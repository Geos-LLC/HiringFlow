/**
 * GET /api/cron/reconcile-automations
 *
 * Safety net for the lifecycle middleware in `src/lib/lifecycle-middleware.ts`.
 *
 * The middleware fires automation events synchronously on every Prisma write
 * to a tracked field — that covers ~99% of cases. But:
 *   - A write inside a transaction that rolls back after `$use` runs would
 *     fire the event for state that no longer exists in the DB.
 *   - A raw SQL write or a write from a Prisma client without the middleware
 *     attached would bypass the firing entirely.
 *   - A redeploy mid-request can drop in-flight fire-and-forget dispatches.
 *
 * This cron scans the last 24h for state transitions whose matching event
 * left no observable trace (no AutomationExecution row, no auto:* audit row)
 * and replays the event. The central guard's idempotency means even if a
 * stale notification later lands, the dup is silently dropped.
 *
 * Intentionally narrow: only the two transitions we've actually seen drop
 * events in production (flow_completed and recording_ready). Extending to
 * training_completed / meeting_ended is a one-liner each — add them when a
 * gap surfaces.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  fireAutomations,
  fireFlowRecordingReadyAutomations,
  fireMeetingLifecycleAutomations,
  fireTrainingCompletedAutomations,
} from '@/lib/automation'
import { logSchedulingEvent } from '@/lib/scheduling'

interface SweepCounts {
  scanned: { sessionsFinished: number; capturesProcessed: number; meetingsStuckOpen: number; trainingsCompleted: number }
  fired: { flowCompleted: number; recordingReady: number; meetingEnded: number; trainingCompleted: number }
  errors: number
}

// Wait this long after scheduledEnd before declaring a meeting stuck and
// finalizing server-side. 30 min covers the long-tail of meetings that ran
// over their booked window AND any late-arriving lifecycle signal from
// Workspace Events / Recall.
const MEETING_ENDED_RECOVERY_GRACE_MS = 30 * 60 * 1000

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const counts: SweepCounts = {
    scanned: { sessionsFinished: 0, capturesProcessed: 0, meetingsStuckOpen: 0, trainingsCompleted: 0 },
    fired: { flowCompleted: 0, recordingReady: 0, meetingEnded: 0, trainingCompleted: 0 },
    errors: 0,
  }

  // -- Rule 1: Session.finishedAt set but no auto:flow_completed audit -----
  //
  // PipelineStatusChange is the canonical "this event was dispatched"
  // signal — fireAutomations() always calls applyStageTrigger() which
  // writes either the matched-stage row or a legacyFallback row. If
  // neither exists for the session, the firing path never executed.
  const finishedSessions = await prisma.session.findMany({
    where: {
      finishedAt: { gte: cutoff, not: null },
    },
    select: { id: true, outcome: true },
  })
  counts.scanned.sessionsFinished = finishedSessions.length

  if (finishedSessions.length > 0) {
    const audited = await prisma.pipelineStatusChange.findMany({
      where: {
        sessionId: { in: finishedSessions.map((s) => s.id) },
        source: { in: ['auto:flow_completed', 'auto:flow_passed'] },
      },
      select: { sessionId: true },
    })
    const auditedSet = new Set(audited.map((a) => a.sessionId))

    for (const s of finishedSessions) {
      if (auditedSet.has(s.id)) continue
      try {
        await fireAutomations(s.id, s.outcome ?? 'completed', { executionMode: 'cron' })
        counts.fired.flowCompleted++
      } catch (err) {
        counts.errors++
        console.error('[reconcile-automations] fireAutomations failed', { sessionId: s.id, err })
      }
    }
  }

  // -- Rule 2: CaptureResponse processed but no recording_ready execution --
  //
  // CaptureResponse rows don't write a PipelineStatusChange audit (the
  // recording_ready path applies the stage trigger only when wired). The
  // observable signal is an AutomationExecution row with the matching
  // triggerType — its existence proves dispatchRulesForTrigger was reached
  // for this session. If no execution exists AND there is at least one
  // active rule that would match, the firing must have been dropped.
  const processedCaps = await prisma.captureResponse.findMany({
    where: {
      status: 'processed',
      createdAt: { gte: cutoff },
    },
    select: { id: true, sessionId: true, workspaceId: true },
  })
  counts.scanned.capturesProcessed = processedCaps.length

  for (const cap of processedCaps) {
    try {
      // Cheap pre-check: any AutomationExecution with the recording_ready
      // triggerType for this session? If yes, the firing succeeded.
      const existing = await prisma.automationExecution.findFirst({
        where: {
          sessionId: cap.sessionId,
          automationRule: { triggerType: 'recording_ready' },
        },
        select: { id: true },
      })
      if (existing) continue

      // Second filter: is there any active rule that COULD have matched?
      // Without this, we'd re-fire every cron run for workspaces that
      // simply have no recording_ready rule wired.
      const eligible = await prisma.automationRule.findFirst({
        where: {
          workspaceId: cap.workspaceId,
          isActive: true,
          triggerType: 'recording_ready',
        },
        select: { id: true },
      })
      if (!eligible) continue

      await fireFlowRecordingReadyAutomations(cap.sessionId, { executionMode: 'cron' })
      counts.fired.recordingReady++
    } catch (err) {
      counts.errors++
      console.error('[reconcile-automations] fireFlowRecordingReadyAutomations failed', { captureId: cap.id, err })
    }
  }

  // -- Rule 3: TrainingEnrollment.completedAt set but no training_completed --
  //
  // completeEnrollment() writes completedAt; the lifecycle middleware then
  // fires fireTrainingCompletedAutomations as fire-and-forget. On Vercel the
  // function process can be terminated as soon as the HTTP response returns,
  // killing dispatchRulesForTrigger mid-flight before any AutomationExecution
  // row lands. Observable symptom: the candidate's pipelineStatus stays at
  // training_in_progress (applyStageTrigger never ran either) and the recruiter
  // has to manually click "Run automations" on the candidate page.
  //
  // Same shape as Rule 2: the existence of an AutomationExecution row for a
  // training_completed rule on this session proves dispatchRulesForTrigger
  // was reached. Absence + an eligible active rule = dropped firing.
  const recentCompletions = await prisma.trainingEnrollment.findMany({
    where: {
      completedAt: { gte: cutoff, not: null },
      sessionId: { not: null },
    },
    select: {
      id: true,
      sessionId: true,
      trainingId: true,
      session: { select: { workspaceId: true, automationsHaltedAt: true } },
    },
  })
  counts.scanned.trainingsCompleted = recentCompletions.length

  for (const e of recentCompletions) {
    // sessionId is nullable on the model; the WHERE above filters to non-null.
    const sessionId = e.sessionId
    if (!sessionId || !e.session) continue
    try {
      // Halted sessions would skip at the guard anyway; don't waste a fire.
      if (e.session.automationsHaltedAt) continue

      const existing = await prisma.automationExecution.findFirst({
        where: {
          sessionId,
          automationRule: { triggerType: 'training_completed' },
        },
        select: { id: true },
      })
      if (existing) continue

      // Don't re-fire for workspaces with no eligible rule — `trainingId: null`
      // catches workspace-wide rules, `trainingId: e.trainingId` catches
      // training-specific ones.
      const eligible = await prisma.automationRule.findFirst({
        where: {
          workspaceId: e.session.workspaceId,
          isActive: true,
          triggerType: 'training_completed',
          OR: [{ trainingId: e.trainingId }, { trainingId: null }],
        },
        select: { id: true },
      })
      if (!eligible) continue

      await fireTrainingCompletedAutomations(sessionId, e.trainingId, { executionMode: 'cron' })
      counts.fired.trainingCompleted++
    } catch (err) {
      counts.errors++
      console.error('[reconcile-automations] fireTrainingCompletedAutomations failed', { enrollmentId: e.id, err })
    }
  }

  // -- Rule 4: InterviewMeeting started but never ended --------------------
  //
  // A live attendance source (Workspace Events conference.ended, Recall.ai
  // bot.call_ended, sync-on-read Drive-recording fallback) is supposed to
  // fire `meeting_ended`. In practice the signal occasionally fails to
  // land — webhook subscription suspended, bot crashed, Drive artifact not
  // yet finalized. The result is a meeting stuck in
  // actualStart-without-actualEnd limbo, and any post-meeting automations
  // (next-step email, follow-up SMS) never fire.
  //
  // Recovery: find meetings whose scheduledEnd elapsed by the grace window,
  // have an actualStart (so we know the candidate did attend), have no
  // actualEnd yet, and have no meeting_ended SchedulingEvent. Stamp
  // actualEnd, log meeting_ended with source='cron_heartbeat_timeout', and
  // dispatch the same lifecycle automations the live path would have.
  const meetingCutoff = new Date(Date.now() - MEETING_ENDED_RECOVERY_GRACE_MS)
  const stuckMeetings = await prisma.interviewMeeting.findMany({
    where: {
      actualStart: { not: null },
      actualEnd: null,
      scheduledEnd: { lt: meetingCutoff },
      // Bound the lookback so we never re-process meetings older than a week
      // (avoids re-firing automations for legacy stuck rows that operators
      // may have manually resolved without populating actualEnd).
      scheduledStart: { gte: cutoff },
    },
    select: { id: true, sessionId: true, scheduledEnd: true, meetingCode: true },
  })
  counts.scanned.meetingsStuckOpen = stuckMeetings.length

  for (const m of stuckMeetings) {
    try {
      const alreadyEnded = await prisma.schedulingEvent.findFirst({
        where: {
          sessionId: m.sessionId,
          eventType: 'meeting_ended',
          metadata: { path: ['interviewMeetingId'], equals: m.id },
        },
        select: { id: true },
      })
      if (alreadyEnded) continue

      // Best-effort actualEnd: scheduledEnd is a reasonable proxy when no
      // live signal told us when the candidate left.
      const endAt = m.scheduledEnd
      await prisma.interviewMeeting.update({
        where: { id: m.id },
        data: { actualEnd: endAt },
      })
      await logSchedulingEvent({
        sessionId: m.sessionId,
        eventType: 'meeting_ended',
        metadata: {
          interviewMeetingId: m.id,
          meetingCode: m.meetingCode,
          source: 'cron_heartbeat_timeout',
          at: endAt.toISOString(),
        },
      })
      await fireMeetingLifecycleAutomations(m.sessionId, 'meeting_ended')
      counts.fired.meetingEnded++
    } catch (err) {
      counts.errors++
      console.error('[reconcile-automations] meeting_ended recovery failed', { meetingId: m.id, err })
    }
  }

  return NextResponse.json(counts)
}
