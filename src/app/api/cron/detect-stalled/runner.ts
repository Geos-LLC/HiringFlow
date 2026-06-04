/**
 * Unified stale-detection sweep. Lives next to the route file so the imports
 * (`../route`) are minimal, but kept in its own module because Next.js App
 * Router restricts `route.ts` exports to HTTP method handlers — exporting
 * a helper named `runStaleDetection` from there fails the production build
 * with "is not a valid Route export field".
 *
 * Reused by:
 *   - `GET /api/cron/detect-stalled` (production daily sweep)
 *   - `scripts/dry-run-stale-detection.ts` (operator preview)
 *   - integration tests
 */

import { prisma } from '@/lib/prisma'
import {
  STALE_DETECTION_DEFAULT_DAYS,
  deriveStaleReason,
  type CandidateDispositionReason,
  type StaleReasonContext,
} from '@/lib/candidate-status'
import { excludeTestSessions } from '@/lib/session-filters'

export interface SweepCounts {
  scanned: number
  stalled: number
  byReason: Record<CandidateDispositionReason, number>
}

/**
 * Core sweep. Shared by the cron route, the dry-run script, and integration
 * tests so they all hit the same query / reason-derivation logic.
 *
 * When `dryRun` is true, no writes happen — the function still computes the
 * candidate set and per-reason counts so the operator can see what *would*
 * change before flipping the rule on.
 */
export async function runStaleDetection(
  opts: {
    dryRun?: boolean
    now?: Date
    /**
     * Restrict the sweep to specific workspaces. Production cron leaves this
     * undefined → all workspaces. Integration tests MUST pass the test
     * workspace ids so a stray `dryRun: false` test invocation can't flip
     * unrelated production rows.
     */
    workspaceIds?: string[]
  } = {},
): Promise<SweepCounts> {
  const now = opts.now ?? new Date()
  const dryRun = !!opts.dryRun

  const counts: SweepCounts = {
    scanned: 0,
    stalled: 0,
    byReason: emptyReasonCounts(),
  }

  // Per-workspace because the threshold is per-workspace. A workspace with
  // 50 active candidates and a 14-day setting is one updateMany; we don't
  // need to fan-out per session unless we need to derive reasons (which we
  // do — see below).
  const workspaces = await prisma.workspace.findMany({
    where: opts.workspaceIds ? { id: { in: opts.workspaceIds } } : undefined,
    select: { id: true, defaultStalledDays: true },
  })

  for (const ws of workspaces) {
    const days = ws.defaultStalledDays ?? STALE_DETECTION_DEFAULT_DAYS
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

    // Candidates eligible for a stale flip. Two filters compose:
    //  - status='active' guard (idempotency — manual nurture/lost/hired wins)
    //  - inactivity by lastProgressAt with `startedAt` fallback for the brief
    //    window between deploy and the first bumpSessionProgress write on
    //    existing rows.
    //
    // Both filters are OR-shaped (`excludeTestSessions` returns a top-level
    // OR; the inactivity check needs another OR with the null-fallback).
    // They MUST go under AND — a spread would let the second OR overwrite
    // the first.
    const candidates = await prisma.session.findMany({
      where: {
        workspaceId: ws.id,
        status: 'active',
        AND: [
          excludeTestSessions(),
          {
            OR: [
              { lastProgressAt: { lt: cutoff } },
              {
                AND: [
                  { lastProgressAt: null },
                  { startedAt: { lt: cutoff } },
                ],
              },
            ],
          },
        ],
      },
      select: {
        id: true,
        finishedAt: true,
        trainingAccessTokens: { select: { id: true }, take: 1 },
        trainingEnrollments: {
          select: { status: true, completedAt: true },
        },
        interviewMeetings: {
          select: { scheduledStart: true, actualStart: true },
          orderBy: { scheduledStart: 'desc' },
        },
        schedulingEvents: {
          where: { eventType: 'scheduling_invite_sent' },
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        backgroundChecks: {
          select: { status: true, overallScore: true },
        },
      },
    })

    counts.scanned += candidates.length

    for (const c of candidates) {
      const reason = deriveStaleReason(staleReasonContextFromCandidate(c))
      counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1

      if (!dryRun) {
        await prisma.session.update({
          where: { id: c.id },
          data: {
            status: 'stalled',
            dispositionReason: reason,
            stalledAt: now,
            // Flip the central automation kill-switch in the same update so
            // queued QStash callbacks fired after this transition are blocked
            // at the guard. Without this, a 24h-before reminder for a
            // candidate the cron just flagged stalled would still go out.
            automationsHaltedAt: now,
            automationsHaltedReason: `cron:stalled:${reason}`,
          },
        })
      }
      counts.stalled++
    }
  }

  return counts
}

function staleReasonContextFromCandidate(c: {
  finishedAt: Date | null
  trainingAccessTokens: { id: string }[]
  trainingEnrollments: { status: string; completedAt: Date | null }[]
  interviewMeetings: { scheduledStart: Date | null; actualStart: Date | null }[]
  schedulingEvents: { createdAt: Date }[]
  backgroundChecks: { status: string | null; overallScore: string | null }[]
}): StaleReasonContext {
  const latestMeeting = c.interviewMeetings[0]
  const hasAttendedAnyMeeting = c.interviewMeetings.some((m) => m.actualStart !== null)
  const hasTrainingProgress = c.trainingEnrollments.some((e) => e.status !== 'not_started')
  const hasTrainingCompleted = c.trainingEnrollments.some((e) => e.status === 'completed' && e.completedAt !== null)
  // A BG check is "pending" until it has a resolved score (passed/flagged/etc).
  // Cancelled cases don't count.
  const hasPendingBackgroundCheck = c.backgroundChecks.some((bc) => {
    const status = (bc.status || '').toUpperCase()
    if (status === 'CANCELLED') return false
    return !bc.overallScore
  })

  return {
    finishedAt: c.finishedAt,
    schedulingInviteSentAt: c.schedulingEvents[0]?.createdAt ?? null,
    latestMeetingScheduledStart: latestMeeting?.scheduledStart ?? null,
    hasAttendedAnyMeeting,
    hasTrainingInvite: c.trainingAccessTokens.length > 0,
    hasTrainingProgress,
    hasTrainingCompleted,
    hasPendingBackgroundCheck,
  }
}

function emptyReasonCounts(): Record<CandidateDispositionReason, number> {
  return {
    no_response_after_video_invite: 0,
    flow_not_completed: 0,
    video_interview_not_completed: 0,
    training_not_started: 0,
    training_not_completed: 0,
    scheduling_not_booked: 0,
    interview_no_show: 0,
    background_check_not_completed: 0,
    no_progress_generic: 0,
    candidate_declined: 0,
    failed_screening: 0,
    failed_training: 0,
    not_qualified: 0,
    not_selected: 0,
    hired_elsewhere: 0,
    manual_other: 0,
  }
}
