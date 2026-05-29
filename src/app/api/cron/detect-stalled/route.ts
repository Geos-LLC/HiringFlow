/**
 * GET /api/cron/detect-stalled
 *
 * Daily sweep that flips `Session.status` from 'active' → 'stalled' when a
 * candidate has gone quiet at a known checkpoint. The four detection rules
 * mirror the spec — see `src/lib/candidate-status.ts` for the disposition
 * enum values written here:
 *
 *   1. Flow / video interview not completed
 *      Session started but never finished, beyond `videoInterviewTimeoutDays`.
 *      → status='stalled', dispositionReason='video_interview_not_completed'
 *
 *   2. Training sent, never started
 *      A TrainingAccessToken exists, but no TrainingEnrollment for that
 *      session/training has progressed past status='not_started', and the
 *      token is older than `trainingTimeoutDays`.
 *      → status='stalled', dispositionReason='training_not_started'
 *
 *   3. Training started, never completed
 *      An in-progress TrainingEnrollment older than `trainingTimeoutDays`
 *      with no completion AND no recent Session.lastActivityAt.
 *      → status='stalled', dispositionReason='training_not_completed'
 *
 *   4. Scheduled interview missed (silent path)
 *      An InterviewMeeting whose scheduled time + `noShowTimeoutHours` has
 *      elapsed without an `actualStart` AND without a `meeting_no_show`
 *      SchedulingEvent. This catches the "neither party joined" edge case
 *      that Workspace Events can't detect.
 *      → status='stalled' (NOT 'lost' — the meeting_no_show event handler
 *        still owns the lost transition; the cron only flags the silence)
 *      → dispositionReason='interview_no_show'
 *
 * Timeouts come from the per-flow columns (`videoInterviewTimeoutDays`,
 * `trainingTimeoutDays`, `noShowTimeoutHours`) and fall back to the platform
 * defaults in `DEFAULT_TIMEOUTS` when null.
 *
 * Idempotent: every WHERE clause filters `status='active'` so re-running the
 * cron never overwrites a manual `nurture` / `lost` / `hired` / `stalled`
 * action. Once a candidate flips to 'stalled', subsequent runs leave them
 * alone — the next status change has to come from a forward-progress event
 * (clears stalled in `applyStageTrigger`) or a manual lifecycle action.
 *
 * Vercel cron schedule: daily 4:00 UTC (after the Calendar/Meet renewals).
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { DEFAULT_TIMEOUTS, type CandidateDispositionReason } from '@/lib/candidate-status'
import { excludeTestSessions } from '@/lib/session-filters'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface SweepCounts {
  videoInterviewNotCompleted: number
  trainingNotStarted: number
  trainingNotCompleted: number
  interviewNoShowSilent: number
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const counts: SweepCounts = {
    videoInterviewNotCompleted: 0,
    trainingNotStarted: 0,
    trainingNotCompleted: 0,
    interviewNoShowSilent: 0,
  }

  // -- Rule 1: video interview not completed -----------------------------
  // Per-flow timeout: the candidate's flow's videoInterviewTimeoutDays, or
  // the platform default. Group sessions by flowId so we can batch the
  // cutoff comparison without per-row queries.
  const flows = await prisma.flow.findMany({
    select: {
      id: true,
      videoInterviewTimeoutDays: true,
      trainingTimeoutDays: true,
      noShowTimeoutHours: true,
    },
  })

  for (const flow of flows) {
    const days = flow.videoInterviewTimeoutDays ?? DEFAULT_TIMEOUTS.videoInterviewTimeoutDays
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    const result = await prisma.session.updateMany({
      where: {
        flowId: flow.id,
        status: 'active',
        ...excludeTestSessions(),
        finishedAt: null,
        startedAt: { lt: cutoff },
      },
      data: stalledPayload(now, 'video_interview_not_completed'),
    })
    counts.videoInterviewNotCompleted += result.count
  }

  // -- Rule 2: training sent, never started -----------------------------
  // The "sent but ignored" signal lives on TrainingAccessToken — when the
  // automation sends a training invite, a token row is created. Clicking
  // the link upserts a TrainingEnrollment bound to THAT token via
  // `accessTokenId` (see src/lib/training-access.ts:getOrCreateEnrollment).
  //
  // Scope per-token, not per-session: a candidate who completed an earlier
  // onboarding training and was then sent a second one they ignored is
  // still stalled on the second one. The old session-wide "no progressed
  // enrollment" guard exempted them because of the earlier completion
  // (Nguyen Tu Bui, 2026-05-14: completed Onboarding Apr 30, ignored
  // post-interview "Test job preparation" token from May 5).
  for (const flow of flows) {
    const days = flow.trainingTimeoutDays ?? DEFAULT_TIMEOUTS.trainingTimeoutDays
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    const stuckTokens = await prisma.trainingAccessToken.findMany({
      where: {
        usedAt: null,
        createdAt: { lt: cutoff },
        candidate: {
          flowId: flow.id,
          status: 'active',
          ...excludeTestSessions(),
        },
        // Per-token enrollment relation — only enrollments bound to THIS
        // token count. A progressed enrollment for a different training (or
        // a different token to the same training) doesn't mask this one.
        enrollments: { none: { status: { not: 'not_started' } } },
      },
      select: { candidateId: true },
    })
    const ids = Array.from(
      new Set(stuckTokens.map((t) => t.candidateId).filter((id): id is string => Boolean(id))),
    )
    if (ids.length > 0) {
      const result = await prisma.session.updateMany({
        where: { id: { in: ids }, status: 'active' },
        data: stalledPayload(now, 'training_not_started'),
      })
      counts.trainingNotStarted += result.count
    }
  }

  // -- Rule 3: training started, never completed -------------------------
  // Trust the per-flow timeout. If the candidate started training >timeout
  // ago and hasn't completed it, they're stuck — regardless of session-wide
  // `lastActivityAt`, which gets bumped by every tangential heartbeat
  // (opening any link, automation sends) and effectively kept candidates
  // out of this rule indefinitely.
  //
  // Per-(session,training) dedupe: if the candidate has a separate
  // `completed` enrollment for the same training, ignore the orphan
  // in-progress one. This happens when a second token gets re-sent for the
  // same training and the candidate completes that one instead, leaving
  // the original enrollment frozen at in_progress forever (Henry,
  // 2026-05-29: May 20 in-progress orphan vs. May 25 completed via re-sent
  // token; the old session-wide `some` clause flagged him post-interview).
  for (const flow of flows) {
    const days = flow.trainingTimeoutDays ?? DEFAULT_TIMEOUTS.trainingTimeoutDays
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

    const stuckEnrollments = await prisma.trainingEnrollment.findMany({
      where: {
        status: 'in_progress',
        completedAt: null,
        startedAt: { lt: cutoff },
        session: {
          is: {
            flowId: flow.id,
            status: 'active',
            ...excludeTestSessions(),
          },
        },
      },
      select: { sessionId: true, trainingId: true },
    })
    if (stuckEnrollments.length === 0) continue

    const sessionIds = Array.from(
      new Set(
        stuckEnrollments
          .map((e) => e.sessionId)
          .filter((id): id is string => Boolean(id)),
      ),
    )
    const trainingIds = Array.from(new Set(stuckEnrollments.map((e) => e.trainingId)))

    const completedPairs = await prisma.trainingEnrollment.findMany({
      where: {
        status: 'completed',
        sessionId: { in: sessionIds },
        trainingId: { in: trainingIds },
      },
      select: { sessionId: true, trainingId: true },
    })
    const completedKey = new Set(
      completedPairs
        .filter((p) => p.sessionId)
        .map((p) => `${p.sessionId}::${p.trainingId}`),
    )

    const trulyStuckIds = Array.from(
      new Set(
        stuckEnrollments
          .filter(
            (e) => e.sessionId && !completedKey.has(`${e.sessionId}::${e.trainingId}`),
          )
          .map((e) => e.sessionId as string),
      ),
    )

    if (trulyStuckIds.length > 0) {
      const result = await prisma.session.updateMany({
        where: { id: { in: trulyStuckIds }, status: 'active' },
        data: stalledPayload(now, 'training_not_completed'),
      })
      counts.trainingNotCompleted += result.count
    }
  }

  // -- Rule 4: silent missed interview ----------------------------------
  // The Meet webhook handler stamps lost+interview_no_show when it sees
  // conference.ended with zero non-host participants. The cron only handles
  // the silent path: scheduled meeting, time elapsed, no actualStart, no
  // meeting_no_show event. Mark as 'stalled' (not 'lost') so a recruiter
  // can investigate before declaring the candidate lost.
  //
  // We only flag if the candidate's MOST RECENT meeting is the silent miss.
  // A later attended meeting (recovery) or a later scheduled rebook means
  // the candidate is back in motion — flagging them on a stale older miss
  // hides them from the default Active tab even though they're progressing
  // (Stephanie Descofleur, 2026-05-06: 5/2 silent miss → 5/5 attended →
  // 5/8 rebook, but the cron still stamped her stalled).
  for (const flow of flows) {
    const hours = flow.noShowTimeoutHours ?? DEFAULT_TIMEOUTS.noShowTimeoutHours
    const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000)
    const candidates = await prisma.session.findMany({
      where: {
        flowId: flow.id,
        status: 'active',
        ...excludeTestSessions(),
        interviewMeetings: {
          some: {
            scheduledStart: { lt: cutoff },
            actualStart: null,
          },
        },
      },
      select: {
        id: true,
        // Pull every meeting so we can pick the most recent and apply the
        // recovery checks. The list is small per session — bounded by how
        // many times a candidate has rebooked.
        interviewMeetings: {
          orderBy: { scheduledStart: 'desc' },
          select: { id: true, scheduledStart: true, actualStart: true },
        },
        schedulingEvents: {
          where: { eventType: 'meeting_no_show' },
          select: { metadata: true },
        },
      },
    })
    const targets: string[] = []
    for (const c of candidates) {
      const mostRecent = c.interviewMeetings[0]
      if (!mostRecent) continue
      // Future meeting or any attended meeting → recovered, skip.
      if (mostRecent.scheduledStart > now) continue
      if (c.interviewMeetings.some((m) => m.actualStart !== null)) continue
      // Most recent must be elapsed past the cutoff and unstarted.
      if (mostRecent.scheduledStart >= cutoff) continue
      if (mostRecent.actualStart !== null) continue
      // The Meet webhook owns the lost transition for meetings it could
      // observe — if it already stamped meeting_no_show for this exact
      // meeting, defer.
      const hasNoShowForMostRecent = c.schedulingEvents.some((ev) => {
        const id = (ev.metadata as { interviewMeetingId?: string } | null)?.interviewMeetingId
        return id === mostRecent.id
      })
      if (hasNoShowForMostRecent) continue
      targets.push(c.id)
    }
    if (targets.length > 0) {
      const result = await prisma.session.updateMany({
        where: { id: { in: targets }, status: 'active' },
        data: stalledPayload(now, 'interview_no_show'),
      })
      counts.interviewNoShowSilent += result.count
    }
  }

  return NextResponse.json({
    ok: true,
    ranAt: now.toISOString(),
    counts,
  })
}

function stalledPayload(now: Date, reason: CandidateDispositionReason) {
  return {
    status: 'stalled',
    dispositionReason: reason,
    stalledAt: now,
    // Flip the central automation kill-switch in the same update so any
    // queued QStash callbacks fired after this transition are blocked at
    // the guard. Without this, a 24h-before reminder for a candidate the
    // cron just flagged stalled would still go out — the cron flips status
    // but doesn't reach into the queue. The guard's halt check skips the
    // send and persists a `skipped_cancelled` row for the audit trail.
    automationsHaltedAt: now,
    automationsHaltedReason: `cron:stalled:${reason}`,
  }
}
