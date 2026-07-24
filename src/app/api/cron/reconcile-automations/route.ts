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
import {
  emitAutomationEvent,
  eventKeys,
  findOrphanAutomationEvents,
  redispatchAcceptedEvent,
} from '@/lib/automation-emit'
import { flowScopeFragment } from '@/lib/automation-flow-scope'
import { logSchedulingEvent } from '@/lib/scheduling'
import { reconcileFalseNoShow } from '@/lib/meet/reconcile-no-show'
import { setPipelineStatus } from '@/lib/pipeline-status'

interface SweepCounts {
  scanned: {
    sessionsFinished: number
    capturesProcessed: number
    meetingsStuckOpen: number
    trainingsCompleted: number
    orphanEvents: number
    falseNoShowCandidates: number
  }
  fired: {
    flowCompleted: number
    recordingReady: number
    meetingEnded: number
    trainingCompleted: number
    orphanRedispatched: number
    falseNoShowReverted: number
    falseNoShowStageRestored: number
  }
  errors: number
}

// Window for the AutomationEvent orphan sweep. Anything <2min old is
// still allowed to be in-flight dispatch (Vercel function timeout is 60s,
// add a buffer for retries). Anything >24h is left alone — if it didn't
// land in a day, manual triage is the right answer.
const ORPHAN_MIN_AGE_MS = 2 * 60 * 1000
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000

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
    scanned: { sessionsFinished: 0, capturesProcessed: 0, meetingsStuckOpen: 0, trainingsCompleted: 0, orphanEvents: 0, falseNoShowCandidates: 0 },
    fired: { flowCompleted: 0, recordingReady: 0, meetingEnded: 0, trainingCompleted: 0, orphanRedispatched: 0, falseNoShowReverted: 0, falseNoShowStageRestored: 0 },
    errors: 0,
  }

  // -- Rule 1: Session.finishedAt set but no flow_completed execution row ---
  //
  // Audit signal: presence of an AutomationExecution row whose rule has
  // triggerType ∈ ('flow_completed', 'flow_passed') for this session.
  //
  // Previous criterion was `PipelineStatusChange.source='auto:flow_completed'`
  // — but `applyStageTrigger` writes that row BEFORE the rule-loading +
  // execution-row-creation step inside `dispatchRulesForTrigger`. If Vercel
  // killed the lambda between those two points (Amber Frederick / Jarmall
  // Chester 2026-06-03), the audit row landed but no executions were
  // created, and the cron incorrectly concluded "already dispatched, skip"
  // forever. Same pattern Rules 2 & 3 already use — `AutomationExecution`
  // existence is the only honest "dispatch reached the end" signal.
  //
  // Workspaces with no matching active rule produce zero executions even
  // on a healthy dispatch. The eligible-rule pre-filter prevents re-firing
  // forever for those sessions.
  const finishedSessions = await prisma.session.findMany({
    where: {
      finishedAt: { gte: cutoff, not: null },
    },
    select: { id: true, outcome: true, workspaceId: true, flowId: true },
  })
  counts.scanned.sessionsFinished = finishedSessions.length

  for (const s of finishedSessions) {
    try {
      const outcome = s.outcome ?? 'completed'
      const triggerType = outcome === 'passed' ? 'flow_passed' : 'flow_completed'

      const existing = await prisma.automationExecution.findFirst({
        where: {
          sessionId: s.id,
          automationRule: { triggerType: { in: ['flow_completed', 'flow_passed'] } },
        },
        select: { id: true },
      })
      if (existing) continue

      // No matching active rule → no work to do, no point re-emitting forever.
      // Flow-scope check mirrors the runtime dispatch (dispatchRulesForTrigger):
      // a rule with an explicit flow list only matches sessions from that
      // list; an empty list is workspace-wide. Skipping here keeps us from
      // re-emitting for sessions no rule would ever fire against.
      const eligible = await prisma.automationRule.findFirst({
        where: {
          workspaceId: s.workspaceId,
          isActive: true,
          triggerType: { in: ['flow_completed', 'flow_passed'] },
          ...flowScopeFragment(s.flowId),
        },
        select: { id: true },
      })
      if (!eligible) continue

      const eventKey = triggerType === 'flow_passed' ? eventKeys.flowPassed(s.id) : eventKeys.flowCompleted(s.id)
      const result = await emitAutomationEvent({
        workspaceId: s.workspaceId,
        sessionId: s.id,
        triggerType,
        eventKey,
        source: 'cron',
        payload: { outcome },
        dispatch: () => fireAutomations(s.id, outcome, { executionMode: 'cron' }),
      })
      if (result.accepted) {
        counts.fired.flowCompleted++
      } else if (result.reason === 'duplicate' && result.eventId) {
        // Prior emit landed but the absence of an AutomationExecution row
        // (checked above) proves dispatch didn't reach executeStep. The
        // (workspaceId, eventKey) dedup blocks the normal recovery path:
        // emit returned "duplicate" so the dispatch closure we passed never
        // ran. The orphan sweep is also no help — it skips events whose
        // dispatchedAt is already set. Redispatch directly. Mirrors the
        // Rule 2 self-heal added in d0aad84 — Nicole Walker 2026-07-14 sat
        // in this state for 14 hours until a manual rerun.
        await redispatchAcceptedEvent({
          eventId: result.eventId,
          dispatch: () => fireAutomations(s.id, outcome, { executionMode: 'cron' }),
        })
        counts.fired.flowCompleted++
      }
    } catch (err) {
      counts.errors++
      console.error('[reconcile-automations] flow_completed emit failed', { sessionId: s.id, err })
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
    select: {
      id: true,
      sessionId: true,
      workspaceId: true,
      // session.flowId is needed to honour rule flow-scoping in the
      // eligibility pre-filter below (mirrors runtime dispatch).
      session: { select: { flowId: true } },
    },
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
      // simply have no recording_ready rule wired. Flow-scope check keeps
      // the re-emit tight when a rule exists but is scoped to a different
      // flow than this candidate's.
      const eligible = await prisma.automationRule.findFirst({
        where: {
          workspaceId: cap.workspaceId,
          isActive: true,
          triggerType: 'recording_ready',
          ...(cap.session ? flowScopeFragment(cap.session.flowId) : {}),
        },
        select: { id: true },
      })
      if (!eligible) continue

      const result = await emitAutomationEvent({
        workspaceId: cap.workspaceId,
        sessionId: cap.sessionId,
        triggerType: 'recording_ready',
        eventKey: eventKeys.recordingReadyCapture(cap.id),
        source: 'cron',
        payload: { captureResponseId: cap.id },
        dispatch: () => fireFlowRecordingReadyAutomations(cap.sessionId, { executionMode: 'cron' }),
      })
      if (result.accepted) {
        counts.fired.recordingReady++
      } else if (result.reason === 'duplicate' && result.eventId) {
        // Prior emit landed but the absence of an AutomationExecution row
        // proves dispatch didn't reach executeStep. The (workspaceId,
        // eventKey) dedup blocks the normal recovery path: emit returned
        // "duplicate" so the dispatch closure we passed never ran. The
        // orphan sweep is also no help — it skips events whose
        // dispatchedAt is already set. Force-dispatch directly and re-stamp
        // the audit row so the next sweep has clean state to reason about.
        const eventId = result.eventId
        try {
          await fireFlowRecordingReadyAutomations(cap.sessionId, { executionMode: 'cron' })
          await prisma.automationEvent
            .update({ where: { id: eventId }, data: { dispatchedAt: new Date(), dispatchError: null } })
            .catch(() => {})
          counts.fired.recordingReady++
        } catch (recoverErr) {
          const message = recoverErr instanceof Error ? recoverErr.message : String(recoverErr)
          await prisma.automationEvent
            .update({ where: { id: eventId }, data: { dispatchError: message.slice(0, 1000) } })
            .catch(() => {})
          throw recoverErr
        }
      }
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
      // session.flowId is needed to honour rule flow-scoping in the
      // eligibility pre-filter below (mirrors runtime dispatch).
      session: { select: { workspaceId: true, flowId: true, automationsHaltedAt: true } },
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
      // training-specific ones. Flow-scope check mirrors runtime dispatch so
      // we don't re-emit for training completions whose flow is outside every
      // matching rule's scope.
      const eligible = await prisma.automationRule.findFirst({
        where: {
          workspaceId: e.session.workspaceId,
          isActive: true,
          triggerType: 'training_completed',
          AND: [
            { OR: [{ trainingId: e.trainingId }, { trainingId: null }] },
            flowScopeFragment(e.session.flowId),
          ],
        },
        select: { id: true },
      })
      if (!eligible) continue

      const result = await emitAutomationEvent({
        workspaceId: e.session.workspaceId,
        sessionId,
        triggerType: 'training_completed',
        eventKey: eventKeys.trainingCompleted(e.id),
        source: 'cron',
        payload: { trainingEnrollmentId: e.id, trainingId: e.trainingId },
        dispatch: () => fireTrainingCompletedAutomations(sessionId, e.trainingId, { executionMode: 'cron' }),
      })
      if (result.accepted) counts.fired.trainingCompleted++
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
    select: { id: true, sessionId: true, workspaceId: true, scheduledEnd: true, meetingCode: true },
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
      const result = await emitAutomationEvent({
        workspaceId: m.workspaceId,
        sessionId: m.sessionId,
        triggerType: 'meeting_ended',
        eventKey: eventKeys.meetingEnded(m.id),
        source: 'cron',
        payload: { interviewMeetingId: m.id, source: 'cron_heartbeat_timeout' },
        dispatch: () => fireMeetingLifecycleAutomations(m.sessionId, 'meeting_ended'),
      })
      if (result.accepted) counts.fired.meetingEnded++
    } catch (err) {
      counts.errors++
      console.error('[reconcile-automations] meeting_ended recovery failed', { meetingId: m.id, err })
    }
  }

  // -- Rule 5: AutomationEvent rows accepted but never dispatched -----------
  //
  // The emitter (lifecycle middleware / webhook / public endpoint) won the
  // INSERT race against AutomationEvent's unique constraint but its
  // dispatch callback never set `dispatchedAt`. The likely cause is Vercel
  // killing the function mid-flight after the HTTP response returned
  // (see lifecycle middleware comment about fire-and-forget). Rules 1-4
  // are state-based scans that depend on observable side-effects
  // (`AutomationExecution` row exists, `PipelineStatusChange` audit row);
  // this sweep is *event-based* and picks up drops that didn't leave any
  // side-effect at all.
  //
  // Re-firing routes through the same dispatch function — `redispatchAcceptedEvent`
  // reuses the event row and stamps `dispatchedAt` on success. The per-step
  // `AutomationExecution` guard remains the second line of defence if the
  // dispatch partially completed.
  const orphans = await findOrphanAutomationEvents({
    minAgeMs: ORPHAN_MIN_AGE_MS,
    maxAgeMs: ORPHAN_MAX_AGE_MS,
    take: 200,
  })
  counts.scanned.orphanEvents = orphans.length

  for (const ev of orphans) {
    try {
      // Re-derive the dispatch from triggerType + payload. The original
      // closure is gone (lived in the emitter that died), so the cron
      // owns the trigger → dispatch mapping. Anything we don't recognise
      // is left alone with a dispatchError stamp so a human can triage.
      const dispatch = await deriveDispatchFromEvent(ev)
      if (!dispatch) {
        await prisma.automationEvent.update({
          where: { id: ev.id },
          data: { dispatchError: `reconciler:unknown_trigger:${ev.triggerType}` },
        }).catch(() => {})
        continue
      }
      await redispatchAcceptedEvent({ eventId: ev.id, dispatch: () => dispatch() })
      counts.fired.orphanRedispatched++
    } catch (err) {
      counts.errors++
      console.error('[reconcile-automations] orphan redispatch failed', { eventId: ev.id, err })
    }
  }

  // -- Rule 6: false meeting_no_show + recording actually landed -----------
  //
  // Recall's bot.call_ended (participants list empty, or recording metadata
  // not yet finalized when the duration fallback ran) and sync-on-read's
  // attendance path both make best-effort no-show calls. When they get it
  // wrong the candidate lands in `status='lost'` + `dispositionReason=
  // interview_no_show` + `rejectionReason='No-show'` + halted automations
  // — a terminal state that nothing later un-marks.
  //
  // The `reconcileFalseNoShow` helper (called from `handleBotDone` and
  // `syncMeetingFromMeetApi` at write time) fixes new occurrences. This
  // sweep handles two remaining gaps:
  //   (a) meetings whose recording landed BEFORE this reconciler shipped —
  //       Keira Bowman's case triggered the whole design.
  //   (b) meetings where a rare failure path skipped the inline call — same
  //       reason we have Rules 1-5.
  //
  // 30-day lookback so no candidate wrongly-rejected in the last month
  // stays rejected. Longer than the other rules' 24h because the incident
  // window here is longer (a candidate wrongly marked no-show 3 weeks ago
  // is still wrong today).
  // Session has no `updatedAt`; use the timestamp that lifecycle:meeting_no_show
  // itself sets (`lostAt` for the disposition side, `rejectionReasonAt` for the
  // legacy rejection side). Either qualifies as "was marked no-show within
  // the lookback window."
  const noShowLookback = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const noShowSessions = await prisma.session.findMany({
    where: {
      OR: [
        {
          rejectionReason: 'No-show',
          rejectionReasonAt: { gte: noShowLookback },
        },
        {
          status: 'lost',
          dispositionReason: 'interview_no_show',
          lostAt: { gte: noShowLookback },
        },
      ],
    },
    select: {
      id: true,
      interviewMeetings: {
        where: {
          OR: [
            { recordingState: 'ready' },
            { recallRecordingId: { not: null } },
            { driveRecordingFileId: { not: null } },
            { actualStart: { not: null } },
          ],
        },
        select: { id: true },
        orderBy: { scheduledStart: 'desc' },
        take: 1,
      },
    },
  })
  counts.scanned.falseNoShowCandidates = noShowSessions.length

  for (const s of noShowSessions) {
    const meetingId = s.interviewMeetings[0]?.id
    if (!meetingId) continue
    try {
      const result = await reconcileFalseNoShow(meetingId, 'cron_reconcile_sweep')
      if (result.reverted) counts.fired.falseNoShowReverted++
    } catch (err) {
      counts.errors++
      console.error('[reconcile-automations] reconcileFalseNoShow failed', { sessionId: s.id, meetingId, err })
    }
  }

  // -- Rule 6b: status was reverted but pipelineStatus stage never moved ---
  //
  // Catches candidates whose status was cleared by `reconcileFalseNoShow`
  // BEFORE the stage-restore code shipped in 2fc9507. They have a
  // `meeting_no_show_reverted` SchedulingEvent but their kanban card is
  // still parked on the no-show stage from the original `auto:meeting_no_show`
  // PipelineStatusChange. Sweeps them back to `fromStatus` idempotently:
  // the `auto:meeting_no_show_reverted` audit row guards against re-running
  // for the same session.
  const revertedEvents = await prisma.schedulingEvent.findMany({
    where: { eventType: 'meeting_no_show_reverted' },
    orderBy: { eventAt: 'desc' },
    select: { sessionId: true, metadata: true, eventAt: true },
  })
  const seenSessions = new Set<string>()
  for (const ev of revertedEvents) {
    if (seenSessions.has(ev.sessionId)) continue
    seenSessions.add(ev.sessionId)
    const meta = (ev.metadata as { interviewMeetingId?: string } | null) || {}
    if (!meta.interviewMeetingId) continue
    try {
      const priorMove = await prisma.pipelineStatusChange.findFirst({
        where: {
          sessionId: ev.sessionId,
          source: 'auto:meeting_no_show',
        },
        orderBy: { createdAt: 'desc' },
        select: { fromStatus: true, toStatus: true, createdAt: true },
      })
      if (!priorMove?.fromStatus) continue

      const session = await prisma.session.findUnique({
        where: { id: ev.sessionId },
        select: { pipelineStatus: true },
      })
      // Only restore when the card is still parked on the no-show stage.
      // If a recruiter already dragged her elsewhere, don't yank her back.
      if (session?.pipelineStatus !== priorMove.toStatus) continue

      const alreadyRestored = await prisma.pipelineStatusChange.findFirst({
        where: {
          sessionId: ev.sessionId,
          source: 'auto:meeting_no_show_reverted',
          createdAt: { gte: priorMove.createdAt },
        },
        select: { id: true },
      })
      if (alreadyRestored) continue

      await setPipelineStatus({
        sessionId: ev.sessionId,
        toStatus: priorMove.fromStatus,
        source: 'auto:meeting_no_show_reverted',
        metadata: { interviewMeetingId: meta.interviewMeetingId, backfill: 'rule_6b' },
      })
      counts.fired.falseNoShowStageRestored++
    } catch (err) {
      counts.errors++
      console.error('[reconcile-automations] rule 6b restore failed', { sessionId: ev.sessionId, err })
    }
  }

  return NextResponse.json(counts)
}

/**
 * Map a stored AutomationEvent back to its dispatch function. The cron is
 * the only caller — emit sites always know the right `fire*` to wire up
 * at write time. This covers every triggerType the wrapper currently
 * accepts; an unmapped trigger returns null so the reconciler can stamp
 * a `dispatchError` instead of silently looping.
 */
async function deriveDispatchFromEvent(ev: {
  sessionId: string | null
  triggerType: string
  payload: Record<string, unknown> | null
}): Promise<(() => Promise<void>) | null> {
  if (!ev.sessionId) return null
  const sessionId = ev.sessionId
  switch (ev.triggerType) {
    case 'flow_completed':
    case 'flow_passed': {
      const outcome = ev.triggerType === 'flow_passed' ? 'passed' : 'completed'
      return () => fireAutomations(sessionId, outcome, { executionMode: 'cron' }).then(() => undefined)
    }
    case 'recording_ready':
      return () => fireFlowRecordingReadyAutomations(sessionId, { executionMode: 'cron' }).then(() => undefined)
    case 'training_completed': {
      const trainingId = typeof ev.payload?.trainingId === 'string' ? (ev.payload.trainingId as string) : undefined
      return () => fireTrainingCompletedAutomations(sessionId, trainingId, { executionMode: 'cron' }).then(() => undefined)
    }
    case 'meeting_started':
    case 'meeting_ended':
    case 'meeting_no_show':
    case 'transcript_ready':
      return () => fireMeetingLifecycleAutomations(
        sessionId,
        ev.triggerType as 'meeting_started' | 'meeting_ended' | 'meeting_no_show' | 'transcript_ready',
      ).then(() => undefined)
    default:
      return null
  }
}
