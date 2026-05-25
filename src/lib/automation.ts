import { prisma } from './prisma'
import { sendEmail, renderTemplate } from './email'
import { sendSms, normalizeToE164, SmsConfigError, SmsValidationError, SmsSendError } from './sms'
import { createAccessToken, buildTrainingLink } from './training-access'
import { resolveSchedulingUrl, buildScheduleRedirectUrl, logSchedulingEvent, updatePipelineStatus } from './scheduling'
import { applyStageTrigger } from './funnel-stage-runtime'
import { automationScopeForSession, pipelineScopeFragment, resolveFlowPipelineId } from './automation-pipeline-scope'
import { Client } from '@upstash/qstash'
import { canExecuteAutomationStep, recordSkip, type ExecutionMode } from './automation-guard'

const qstashToken = process.env.QSTASH_TOKEN
const qstash = qstashToken
  ? new Client({ token: qstashToken, baseUrl: process.env.QSTASH_URL })
  : null
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://www.hirefunnel.app'

type SessionCtx = {
  id: string
  workspaceId: string
  flowId: string
  candidateName: string | null
  candidateEmail: string | null
  flow: { name: string }
  ad: { name: string } | null
  source: string | null
}

// Triggers that represent the "pre-meeting" phase. Any pending follow-up step
// from a rule with one of these triggers gets cancelled when the candidate
// books a meeting (meeting_scheduled fires) — the follow-up was a nudge to
// book, and they've now booked. Same idea applies on hire/reject.
const PRE_MEETING_TRIGGERS = new Set([
  'flow_completed',
  'flow_passed',
  'training_started',
  'training_completed',
])

/**
 * Top-level "fire" functions accept an optional `dispatchOptions` so the
 * caller can stamp executionMode (public_trigger / cron / etc.) on every
 * downstream execution. Default is `immediate` (synchronous trigger from
 * an inline lifecycle event).
 */
type FireDispatchOptions = { executionMode?: ExecutionMode; actorUserId?: string | null }

export async function fireAutomations(sessionId: string, outcome: string, opts?: FireDispatchOptions) {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { flow: true, ad: true },
    })
    if (!session) return

    const triggerType = outcome === 'passed' ? 'flow_passed' : outcome === 'completed' ? 'flow_completed' : null
    if (!triggerType) return

    const legacyStatus = outcome === 'passed' ? 'passed' : 'completed_flow'
    await applyStageTrigger({
      sessionId,
      workspaceId: session.workspaceId,
      event: triggerType,
      flowId: session.flowId,
      legacyStatus,
    }).catch(() => updatePipelineStatus(sessionId, legacyStatus).catch(() => {}))

    await dispatchRulesForTrigger(sessionId, triggerType, session, {
      executionMode: opts?.executionMode,
      actorUserId: opts?.actorUserId,
    })
  } catch (error) {
    console.error('[Automation] Error firing automations for session', sessionId, ':', error)
  }
}

/**
 * Fire `recording_ready` rules for a *flow recording submission* (candidate
 * uploaded a video/audio answer to a submission step). This is distinct from
 * `fireMeetingLifecycleAutomations('recording_ready')`, which is for Google
 * Meet meeting recordings and additionally releases `waiting_for_recording`
 * executions — that path is interview-specific and would no-op for flows.
 *
 * Stage move is opt-in via `applyStageTrigger('recording_ready')` with no
 * legacyStatus fallback: workspaces that didn't wire `recording_ready` to a
 * stage keep their current kanban position (the `flow_completed` path that
 * usually fires alongside this owns the default stage move).
 */
export async function fireFlowRecordingReadyAutomations(
  sessionId: string,
  opts?: FireDispatchOptions,
) {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { flow: true, ad: true },
    })
    if (!session) return
    await applyStageTrigger({
      sessionId,
      workspaceId: session.workspaceId,
      event: 'recording_ready',
      flowId: session.flowId,
    }).catch(() => {})
    await dispatchRulesForTrigger(sessionId, 'recording_ready', session, {
      executionMode: opts?.executionMode,
      actorUserId: opts?.actorUserId,
    })
  } catch (error) {
    console.error('[Automation] Error firing flow recording_ready automations for session', sessionId, ':', error)
  }
}

export async function fireTrainingCompletedAutomations(
  sessionId: string,
  trainingId?: string,
  opts?: FireDispatchOptions,
) {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { flow: true, ad: true },
    })
    if (!session) return
    await applyStageTrigger({
      sessionId,
      workspaceId: session.workspaceId,
      event: 'training_completed',
      trainingId,
      legacyStatus: 'training_completed',
    }).catch(() => updatePipelineStatus(sessionId, 'training_completed').catch(() => {}))

    // Candidate finished training. Nuke queued follow-ups whose value was
    // "did you finish training?" — flow_completed/passed nudges and
    // training_started reminders. meeting_scheduled cancellation is a
    // separate path (fireMeetingScheduledAutomations) so we don't touch it
    // here.
    await cancelPendingStepsForSession(sessionId, {
      ruleTriggerTypes: new Set(['flow_completed', 'flow_passed', 'training_started']),
      reason: 'Training was completed before this step fired',
    }).catch((err) => console.error('[Automation] cancel post-training-completed follow-ups failed:', err))

    await dispatchRulesForTrigger(sessionId, 'training_completed', session, {
      trainingId,
      executionMode: opts?.executionMode,
      actorUserId: opts?.actorUserId,
    })
  } catch (error) {
    console.error('[Automation] Error firing training_completed automations for session', sessionId, ':', error)
  }
}

export async function fireTrainingStartedAutomations(
  sessionId: string,
  trainingId: string,
  opts?: FireDispatchOptions,
) {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { flow: true, ad: true },
    })
    if (!session) return
    await applyStageTrigger({
      sessionId,
      workspaceId: session.workspaceId,
      event: 'training_started',
      trainingId,
      legacyStatus: 'training_in_progress',
    })

    // Candidate is now engaged with training. Nuke queued flow_*/passed
    // nudges ("have you started yet?") — they're moot now.
    await cancelPendingStepsForSession(sessionId, {
      ruleTriggerTypes: new Set(['flow_completed', 'flow_passed']),
      reason: 'Training was started before this step fired',
    }).catch((err) => console.error('[Automation] cancel post-training-started follow-ups failed:', err))

    await dispatchRulesForTrigger(sessionId, 'training_started', session, {
      trainingId,
      executionMode: opts?.executionMode,
      actorUserId: opts?.actorUserId,
    })
  } catch (error) {
    console.error('[Automation] Error firing training_started for session', sessionId, ':', error)
  }
}

export async function fireMeetingScheduledAutomations(sessionId: string, opts?: FireDispatchOptions) {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { flow: true, ad: true },
    })
    if (!session) return
    await applyStageTrigger({
      sessionId,
      workspaceId: session.workspaceId,
      event: 'meeting_scheduled',
      flowId: session.flowId,
    }).catch(() => {})

    // The candidate booked. Cancel any pending follow-up steps queued by
    // pre-meeting rules ("haven't booked yet?" nudges) — they're moot now.
    await cancelPendingStepsForSession(sessionId, {
      ruleTriggerTypes: PRE_MEETING_TRIGGERS,
    }).catch((err) => console.error('[Automation] cancel pre-meeting follow-ups failed:', err))

    await dispatchRulesForTrigger(sessionId, 'meeting_scheduled', session, {
      executionMode: opts?.executionMode,
      actorUserId: opts?.actorUserId,
    })

    const upcoming = await prisma.interviewMeeting.findFirst({
      where: { sessionId },
      orderBy: { scheduledStart: 'desc' },
      select: { scheduledStart: true },
    })
    if (upcoming?.scheduledStart) {
      await scheduleBeforeMeetingReminders(sessionId, upcoming.scheduledStart)
    }
  } catch (error) {
    console.error('[Automation] Error firing meeting_scheduled automations for session', sessionId, ':', error)
  }
}

/**
 * Fire `meeting_rescheduled` rules — typically a "Your interview was moved
 * to {{meeting_time}}" SMS or email so the candidate isn't relying on the
 * Google Calendar update notification (which often lands in spam or gets
 * missed). Mirrors fireMeetingScheduledAutomations but does NOT change
 * pipeline status — the candidate is already past the schedule milestone.
 *
 * Token rendering picks up the latest InterviewMeeting.scheduledStart, so
 * the body sees the *new* meeting time even though the row itself was
 * already updated by reconcileExternalMeetReschedule.
 */
export async function fireMeetingRescheduledAutomations(sessionId: string) {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { flow: true, ad: true },
    })
    if (!session) return
    // Stage move is opt-in: only fires if the workspace wired a stage to
    // `meeting_rescheduled`. The furthest-wins guard inside applyStageTrigger
    // protects against regressing a candidate who has already advanced past
    // the schedule milestone. legacyStatus is intentionally omitted so an
    // unconfigured workspace's kanban card stays put.
    await applyStageTrigger({
      sessionId,
      workspaceId: session.workspaceId,
      event: 'meeting_rescheduled',
      flowId: session.flowId,
    }).catch(() => {})
    await dispatchRulesForTrigger(sessionId, 'meeting_rescheduled', session)
  } catch (error) {
    console.error('[Automation] Error firing meeting_rescheduled automations for session', sessionId, ':', error)
  }
}

/**
 * Called when a calendar event is rescheduled. Cancels any pending
 * meeting-relative reminders (they were keyed off the old time) and
 * queues fresh ones for the new scheduledStart.
 *
 * Two paths re-fire:
 *  1. Legacy `before_meeting` trigger rules — handled by
 *     scheduleBeforeMeetingReminders.
 *  2. Per-step timingMode='before_meeting'/'after_meeting' on rules with
 *     other triggers (meeting_scheduled, meeting_started, etc.) — handled
 *     by reScheduleMeetingRelativeSteps.
 *
 * Already-sent meeting-relative reminders are detached (stepId set to null)
 * so they're preserved as audit history but the unique constraint
 * `[stepId, sessionId, channel]` no longer blocks fresh executions for the
 * NEW meeting time. Without this, every reschedule after the first reminder
 * fired would silently skip re-queuing — candidates only got reminders for
 * their first meeting time.
 */
export async function rescheduleBeforeMeetingReminders(sessionId: string, newScheduledStart: Date) {
  await cancelBeforeMeetingReminders(sessionId)
  await detachSentMeetingRelativeExecutions(sessionId)
  await scheduleBeforeMeetingReminders(sessionId, newScheduledStart)
  await reScheduleMeetingRelativeSteps(sessionId)
}

/**
 * Orphan already-sent meeting-relative executions (timingMode in
 * {before_meeting, after_meeting}) for a given session by setting their
 * stepId to null. This preserves the row as audit history while freeing
 * up the [stepId, sessionId, channel] unique key for fresh executions
 * against a new meeting time.
 *
 * `before_meeting`-triggered rules ALSO have their executions detached
 * because their dispatch logic computes the fire time against the latest
 * InterviewMeeting.scheduledStart and the upsert otherwise short-circuits.
 */
async function detachSentMeetingRelativeExecutions(sessionId: string) {
  const candidates = await prisma.automationExecution.findMany({
    where: {
      sessionId,
      status: 'sent',
      stepId: { not: null },
      OR: [
        { step: { timingMode: { in: ['before_meeting', 'after_meeting'] } } },
        { automationRule: { triggerType: 'before_meeting' } },
      ],
    },
    select: { id: true },
  })
  if (candidates.length === 0) return
  await prisma.automationExecution.updateMany({
    where: { id: { in: candidates.map((c) => c.id) } },
    data: { stepId: null },
  })
  console.log(`[Automation] Detached ${candidates.length} sent meeting-relative executions for re-queue (session ${sessionId})`)
}

/**
 * Auto-apply a rule to every upcoming meeting in the workspace whenever the
 * rule is created or edited. Cancels any pending executions for the rule
 * (across all sessions) first, then re-dispatches against each upcoming
 * InterviewMeeting.
 *
 * Only runs for meeting_scheduled and before_meeting triggers. Other triggers
 * fire on past lifecycle events that can't be safely replayed.
 *
 * Past meetings are NOT touched (where: scheduledStart > now). Already-sent
 * steps stay sent — dispatchStep's upsert skips them. The recruiter's intent
 * is "this rule should apply to candidates already booked for upcoming
 * meetings, going forward only".
 */
export async function autoBackfillRuleForUpcomingMeetings(ruleId: string) {
  const rule = await prisma.automationRule.findUnique({
    where: { id: ruleId },
    select: { id: true, workspaceId: true, triggerType: true, isActive: true, flowId: true },
  })
  if (!rule) return
  if (!['meeting_scheduled', 'before_meeting'].includes(rule.triggerType)) return

  // Cancel any pending executions for THIS rule (across all sessions). Stops
  // old QStash jobs from a prior step config from firing after an edit.
  const pending = await prisma.automationExecution.findMany({
    where: {
      automationRuleId: ruleId,
      status: { in: ['queued', 'pending'] },
    },
    select: { id: true, qstashMessageId: true },
  })
  for (const p of pending) {
    if (p.qstashMessageId && qstash) {
      try {
        await (qstash.messages as unknown as { delete: (id: string) => Promise<unknown> }).delete(p.qstashMessageId)
      } catch (err) {
        console.warn('[Automation] qstash.messages.delete failed during backfill (likely already fired):', (err as Error).message)
      }
    }
    await prisma.automationExecution.update({
      where: { id: p.id },
      data: { status: 'cancelled' },
    }).catch(() => {})
  }

  if (!rule.isActive) return

  const now = new Date()
  const meetings = await prisma.interviewMeeting.findMany({
    where: {
      workspaceId: rule.workspaceId,
      scheduledStart: { gt: now },
      ...(rule.flowId ? { session: { flowId: rule.flowId } } : {}),
    },
    select: { sessionId: true, scheduledStart: true },
    orderBy: { scheduledStart: 'asc' },
  })
  for (const m of meetings) {
    try {
      if (rule.triggerType === 'before_meeting') {
        await scheduleBeforeMeetingReminders(m.sessionId, m.scheduledStart)
      } else {
        await dispatchRule(rule.id, m.sessionId)
      }
    } catch (err) {
      console.error('[Automation] auto-backfill failed for session', m.sessionId, err)
    }
  }
}

/**
 * Find every step that has timingMode='before_meeting'/'after_meeting' on
 * a meeting-adjacent trigger and re-queue it. dispatchStep recomputes the
 * fire time against the latest InterviewMeeting.scheduledStart.
 */
async function reScheduleMeetingRelativeSteps(sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { workspaceId: true, flowId: true },
  })
  if (!session) return
  const pipelineId = await resolveFlowPipelineId({
    flowId: session.flowId,
    workspaceId: session.workspaceId,
  })
  const rules = await prisma.automationRule.findMany({
    where: {
      isActive: true,
      workspaceId: session.workspaceId,
      AND: [
        { OR: [{ flowId: session.flowId }, { flowId: null }] },
        pipelineScopeFragment(pipelineId),
      ],
      triggerType: { in: ['meeting_scheduled', 'meeting_started', 'meeting_ended', 'recording_ready'] },
      steps: { some: { timingMode: { in: ['before_meeting', 'after_meeting'] } } },
    },
    select: { id: true, triggerType: true, steps: { orderBy: { order: 'asc' } } },
  })
  for (const rule of rules) {
    const ctx: DispatchContext = {
      triggerType: rule.triggerType,
      executionMode: 'immediate',
    }
    for (const step of rule.steps) {
      if (step.timingMode !== 'before_meeting' && step.timingMode !== 'after_meeting') continue
      // dispatchStep's upsert respects already-sent rows, so this is safe to
      // call again after a reschedule.
      await dispatchStep(rule.id, step, sessionId, ctx).catch((err) => {
        console.error('[Automation] re-schedule of meeting-relative step failed:', err)
      })
    }
  }
}

/**
 * Background check outcome dispatcher. Called from the Certn webhook route
 * (and the reconciliation cron) when a case crosses into a terminal+scored
 * state. Maps Certn's overall_score onto one of three trigger types and
 * dispatches the matching rules.
 *
 * Outcome → trigger mapping:
 *   passed       → background_check_passed       (CLEAR | NOT_APPLICABLE)
 *   failed       → background_check_failed       (REJECT)
 *   needs_review → background_check_needs_review (REVIEW | RESTRICTED)
 *
 * passed/failed also auto-advance the candidate via applyStageTrigger to
 * mirror the meeting lifecycle pattern. needs_review stays put — it's a
 * recruiter-decision moment, not an automatic stage transition.
 */
export async function fireBackgroundCheckAutomations(
  sessionId: string,
  outcome: 'passed' | 'failed' | 'needs_review',
) {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { flow: true, ad: true },
    })
    if (!session) return
    const triggerType = `background_check_${outcome}` as const

    const legacyStatus = outcome === 'failed' ? 'rejected' : undefined
    await applyStageTrigger({
      sessionId,
      workspaceId: session.workspaceId,
      event: triggerType,
      flowId: session.flowId,
      legacyStatus,
    }).catch(() => {})

    await dispatchRulesForTrigger(sessionId, triggerType, session)
  } catch (error) {
    console.error(`[Automation] Error firing background_check_${outcome} for session`, sessionId, ':', error)
  }
}

/**
 * Generic lifecycle dispatcher for Meet integration v2 events
 * (meeting_started / meeting_ended / recording_ready / transcript_ready).
 */
export async function fireMeetingLifecycleAutomations(
  sessionId: string,
  trigger: 'meeting_started' | 'meeting_ended' | 'recording_ready' | 'transcript_ready' | 'meeting_no_show',
) {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { flow: true, ad: true },
    })
    if (!session) return

    if (trigger === 'meeting_started' || trigger === 'meeting_ended' || trigger === 'meeting_no_show') {
      const legacyStatus = trigger === 'meeting_no_show' ? 'rejected' : undefined
      await applyStageTrigger({
        sessionId,
        workspaceId: session.workspaceId,
        event: trigger,
        flowId: session.flowId,
        legacyStatus,
      }).catch(() => {})

      if (trigger === 'meeting_no_show') {
        // No-show is a true terminal negative. Stamp BOTH the legacy
        // free-form rejectionReason (for the existing red pill / manual
        // edit) AND the new structured status axis so analytics can group
        // by the disposition enum without parsing free-form strings.
        // Also halt downstream automations (e.g. an "interview tomorrow!"
        // reminder still queued for this candidate) via the central
        // kill-switch.
        const now = new Date()
        await prisma.session.update({
          where: { id: sessionId },
          data: {
            rejectionReason: 'No-show',
            rejectionReasonAt: now,
            status: 'lost',
            dispositionReason: 'interview_no_show',
            lostAt: now,
            automationsHaltedAt: now,
            automationsHaltedReason: 'lifecycle:meeting_no_show',
          },
        }).catch((err) => console.error('[Automation] failed to stamp rejection / lost fields', err))
      }
    }

    if (trigger === 'recording_ready' || trigger === 'transcript_ready') {
      // Stage move is opt-in: only fires if the workspace wired a stage to
      // recording_ready / transcript_ready. No legacy fallback — these are
      // post-meeting artifact events; if unconfigured, the kanban card
      // stays where it was set by meeting_ended.
      await applyStageTrigger({
        sessionId,
        workspaceId: session.workspaceId,
        event: trigger,
        flowId: session.flowId,
      }).catch(() => {})
    }

    if (trigger === 'recording_ready') {
      // Release any executions that were waiting on the recording. Each row
      // represents one (step, channel) pair that should now run. The guard
      // re-evaluates eligibility — a candidate who became stalled/lost
      // between meeting_ended and recording_ready is now safely blocked.
      const pending = await prisma.automationExecution.findMany({
        where: { sessionId, status: 'waiting_for_recording' },
        select: { id: true, stepId: true, channel: true },
      })
      for (const e of pending) {
        if (!e.stepId) continue
        await executeStep(e.stepId, sessionId, e.channel as 'email' | 'sms', {
          dispatchCtx: { triggerType: 'recording_ready', executionMode: 'delayed_callback' },
        }).catch((err) =>
          console.error('[Automation] waiting release failed', e.id, err))
      }
    }

    if (trigger === 'meeting_ended') {
      // For meeting_ended rules, waitForRecording is a per-rule flag that
      // parks the rule's first step. (Multi-step meeting_ended rules are
      // supported but the wait only applies before step 0.)
      const pipelineId = await resolveFlowPipelineId({
        flowId: session.flowId,
        workspaceId: session.workspaceId,
      })
      const rules = await prisma.automationRule.findMany({
        where: {
          isActive: true,
          triggerType: 'meeting_ended',
          workspaceId: session.workspaceId,
          AND: [
            { OR: [{ flowId: session.flowId }, { flowId: null }] },
            pipelineScopeFragment(pipelineId),
          ],
        },
        select: {
          id: true,
          waitForRecording: true,
          steps: { orderBy: { order: 'asc' } },
        },
      })
      const meetingEndedCtx: DispatchContext = {
        triggerType: 'meeting_ended',
        executionMode: 'immediate',
      }
      for (const rule of rules) {
        if (rule.steps.length === 0) continue
        if (rule.waitForRecording) {
          const cutoff = new Date(Date.now() + 4 * 60 * 60 * 1000)
          const firstStep = rule.steps[0]
          const channels = expandChannels(firstStep.channel)
          for (const channel of channels) {
            await upsertExecution({
              ruleId: rule.id,
              stepId: firstStep.id,
              sessionId,
              channel,
              status: 'waiting_for_recording',
              scheduledFor: cutoff,
              executionMode: 'immediate',
            })
          }
          // Subsequent steps still queue at their delays (they don't wait).
          for (let i = 1; i < rule.steps.length; i++) {
            await dispatchStep(rule.id, rule.steps[i], sessionId, meetingEndedCtx)
          }
        } else {
          await dispatchRule(rule.id, sessionId, meetingEndedCtx)
        }
      }
      return
    }

    await dispatchRulesForTrigger(sessionId, trigger, session)
  } catch (error) {
    console.error(`[Automation] Error firing ${trigger} automations for session`, sessionId, ':', error)
  }
}

/**
 * Cancel pending step executions for a session. Used to invalidate
 * queued follow-ups when the candidate's state moves past the point at
 * which the follow-up made sense.
 *
 *   - ruleTriggerTypes: only cancel executions whose parent rule has one of
 *     these trigger types. e.g. PRE_MEETING_TRIGGERS to nuke pre-booking
 *     follow-ups when the candidate books.
 *   - reason: optional human-readable string written to errorMessage so the
 *     Automations run history shows *why* the step was cancelled.
 */
export async function cancelPendingStepsForSession(
  sessionId: string,
  opts?: { ruleTriggerTypes?: Set<string>; stepTimingModes?: Set<string>; reason?: string },
): Promise<number> {
  type Where = {
    sessionId: string
    status: { in: string[] }
    OR?: Array<Record<string, unknown>>
  }
  const where: Where = {
    sessionId,
    status: { in: ['queued', 'pending', 'waiting_for_recording'] },
  }
  const ors: Array<Record<string, unknown>> = []
  if (opts?.ruleTriggerTypes && opts.ruleTriggerTypes.size > 0) {
    ors.push({ automationRule: { triggerType: { in: Array.from(opts.ruleTriggerTypes) } } })
  }
  if (opts?.stepTimingModes && opts.stepTimingModes.size > 0) {
    ors.push({ step: { timingMode: { in: Array.from(opts.stepTimingModes) } } })
  }
  if (ors.length > 0) where.OR = ors
  const queued = await prisma.automationExecution.findMany({
    where,
    select: { id: true, qstashMessageId: true },
  })
  if (queued.length === 0) return 0
  for (const e of queued) {
    if (e.qstashMessageId && qstash) {
      try {
        await (qstash.messages as unknown as { delete: (id: string) => Promise<unknown> }).delete(e.qstashMessageId)
      } catch (err) {
        console.warn('[Automation] qstash.messages.delete failed (likely already fired):', (err as Error).message)
      }
    }
    await prisma.automationExecution.update({
      where: { id: e.id },
      data: { status: 'cancelled', errorMessage: opts?.reason ?? null },
    }).catch(() => {})
  }
  return queued.length
}

/**
 * Cancel queued executions whose rule is pinned to a stage that no longer
 * matches the session's current pipeline status. Called after every
 * `applyStageTrigger` so a session that advances past stage X automatically
 * sheds any pending follow-ups belonging to X (or any other stage that
 * isn't X' the new one).
 *
 * Generalizes the per-trigger cancellation: instead of every dispatcher
 * having to know which rules to nuke, we sweep by the pinned-stage
 * invariant the guard already enforces. The guard would skip these at
 * dispatch time anyway — cancelling here just stops the row from sitting
 * in `queued` for days and keeps the timeline clean.
 *
 * Rules with stageId=null (stage-agnostic, e.g. "fires regardless") are
 * left alone — the guard never blocks them on stage, so they're still
 * valid for the candidate at their new stage.
 */
export async function cancelStageMismatchedQueued(
  sessionId: string,
  newStageId: string,
): Promise<number> {
  const queued = await prisma.automationExecution.findMany({
    where: {
      sessionId,
      status: { in: ['queued', 'pending'] },
      automationRule: {
        stageId: { not: null },
        NOT: { stageId: newStageId },
      },
    },
    select: {
      id: true,
      qstashMessageId: true,
      automationRule: { select: { stageId: true, name: true } },
    },
  })
  if (queued.length === 0) return 0
  for (const e of queued) {
    if (e.qstashMessageId && qstash) {
      try {
        await (qstash.messages as unknown as { delete: (id: string) => Promise<unknown> }).delete(e.qstashMessageId)
      } catch (err) {
        console.warn('[Automation] qstash.messages.delete failed during stage-mismatch cancel:', (err as Error).message)
      }
    }
    await prisma.automationExecution.update({
      where: { id: e.id },
      data: {
        status: 'cancelled',
        errorMessage: `Rule "${e.automationRule.name}" pinned to stage "${e.automationRule.stageId}"; session advanced to "${newStageId}"`,
      },
    }).catch(() => {})
  }
  console.log(`[Automation] Cancelled ${queued.length} stage-mismatched queued execution(s) for session ${sessionId} (now in ${newStageId})`)
  return queued.length
}

/**
 * Fire automation rules with triggerType='stage_entered' pinned to the
 * stage the candidate just entered. Called from applyStageTrigger's V2
 * branch after a real transition (kind='transitioned'), with the freshly
 * created StageEntry row.
 *
 * Match criteria (closed AND list; all must hold):
 *   - workspaceId = opts.workspaceId    (security boundary)
 *   - pipelineId  = opts.pipelineId     (intrinsically pipeline-scoped;
 *                                        wildcard `null` is intentionally
 *                                        NOT supported — stage ids are not
 *                                        unique across pipelines)
 *   - stageId     = opts.stageId
 *   - triggerType = 'stage_entered'
 *   - isActive    = true
 *
 * Each step is queued through the existing dispatchRule path so timing,
 * channel expansion ('both' → email+sms), and the central guard all behave
 * identically to raw-event dispatch. The only differences:
 *   - DispatchContext.stageEntryId is set so AutomationExecution rows carry
 *     the pin (unique constraint and guard idempotency both key on it).
 *   - QStash payloads carry stageEntryId so delayed callbacks rehydrate it.
 *
 * Re-entry semantics: every fresh StageEntry row produces a fresh
 * stageEntryId, so the (stepId, sessionId, channel, stageEntryId) unique
 * never collides with the prior entry. A candidate who left and re-entered
 * the stage will receive the automation again — by design.
 */
export async function fireStageEnteredAutomations(opts: {
  stageEntryId: string
  sessionId: string
  stageId: string
  pipelineId: string
  workspaceId: string
}): Promise<void> {
  try {
    const rules = await prisma.automationRule.findMany({
      where: {
        workspaceId: opts.workspaceId,
        pipelineId: opts.pipelineId,
        stageId: opts.stageId,
        triggerType: 'stage_entered',
        isActive: true,
      },
      select: { id: true },
    })
    if (rules.length === 0) {
      console.log(`[Automation] No stage_entered rules for stage ${opts.stageId} (pipeline ${opts.pipelineId})`)
      return
    }
    console.log(`[Automation] Dispatching ${rules.length} stage_entered rule(s) for session ${opts.sessionId} (stage ${opts.stageId}, entry ${opts.stageEntryId})`)
    const dispatchCtx: DispatchContext = {
      triggerType: 'stage_entered',
      executionMode: 'immediate',
      stageEntryId: opts.stageEntryId,
      triggerContext: {
        stageEntryId: opts.stageEntryId,
        stageId: opts.stageId,
        pipelineId: opts.pipelineId,
      },
    }
    for (const rule of rules) {
      await dispatchRule(rule.id, opts.sessionId, dispatchCtx)
    }
  } catch (err) {
    console.error('[Automation] fireStageEnteredAutomations failed:', err)
  }
}

/**
 * Cancel queued follow-ups whose value depended on the meeting still
 * happening — i.e. delayed steps from rules with triggerType
 * `meeting_scheduled` or `meeting_rescheduled` (e.g. "thanks for booking,
 * see you Friday" sent 1 hour after booking). Composed with
 * `cancelBeforeMeetingReminders` at the cancellation call sites so a
 * cancelled meeting kills both pre-meeting reminders and post-booking
 * nudges.
 */
export async function cancelMeetingDependentFollowups(sessionId: string): Promise<number> {
  return cancelPendingStepsForSession(sessionId, {
    ruleTriggerTypes: new Set(['meeting_scheduled', 'meeting_rescheduled']),
    reason: 'Meeting was cancelled before this step fired',
  })
}

/**
 * Carries through dispatch so the guard at execution time has the same
 * trigger context the dispatcher used to select the rule, plus the
 * executionMode so we can audit *how* the row was produced.
 */
type DispatchContext = {
  triggerType: string
  executionMode: ExecutionMode
  triggerContext?: Record<string, unknown>
  actorUserId?: string | null
  /**
   * Admin-only force override. Only honoured for executionMode in
   * {manual_rerun, debug} and bypasses only the duplicate-send guard.
   * Lifecycle / stage / prerequisite / halt checks remain authoritative.
   */
  force?: boolean
  /**
   * Test-mode short-circuit for the `/api/automations/[id]/test` endpoint.
   * Tests create throwaway sessions with `source='test'` and need to bypass
   * the lifecycle/stage/prerequisite gates to render the email/SMS body
   * end-to-end. Honoured only when the session.source === 'test'.
   */
  bypassEligibilityForTest?: boolean
  /**
   * Pipeline Transitions v2 — set only for `stage_entered` triggers. Threaded
   * end-to-end (dispatch → queue → QStash body → callback → executeStep →
   * guard → upsertExecution) so the AutomationExecution row carries
   * stageEntryId and idempotency dedups per StageEntry, not per session.
   *
   * Null/undefined for raw-event triggers — those preserve V1 dedup
   * semantics (`[stepId, sessionId, channel, NULL]`).
   */
  stageEntryId?: string | null
}

async function dispatchRulesForTrigger(
  sessionId: string,
  triggerType: string,
  session: SessionCtx,
  ctx: { trainingId?: string | null; executionMode?: ExecutionMode; actorUserId?: string | null } = {},
) {
  // Rules can be scoped by flowId AND by trainingId (each nullable on the
  // rule for "any"). For training-* triggers, we must filter on trainingId
  // too — otherwise a rule wired to "Onboarding training" fires when ANY
  // training in the workspace completes, sending duplicate emails and
  // (worse, when nextStepType=scheduling) regressing pipelineStatus back
  // to invited_to_schedule for candidates who already advanced past it.
  //
  // Pipeline scope (added 2026-05-13): rules can be pinned to a specific
  // pipeline. Resolve the candidate's pipeline and filter rules where
  // pipelineId matches OR is null (workspace-wide). Same composition pattern
  // as flow/training scope — pushed onto the AND list so a future scope
  // dimension can slot in without untangling the WHERE clause.
  const pipelineId = await resolveFlowPipelineId({
    flowId: session.flowId,
    workspaceId: session.workspaceId,
  })
  const ands: Array<Record<string, unknown>> = [
    { OR: [{ flowId: session.flowId }, { flowId: null }] },
    pipelineScopeFragment(pipelineId) as unknown as Record<string, unknown>,
  ]
  if (ctx.trainingId) {
    ands.push({ OR: [{ trainingId: ctx.trainingId }, { trainingId: null }] })
  }
  const rules = await prisma.automationRule.findMany({
    where: {
      isActive: true,
      triggerType,
      workspaceId: session.workspaceId,
      AND: ands,
    },
    select: { id: true },
  })
  if (rules.length === 0) return
  console.log(`[Automation] Dispatching ${rules.length} rules for session ${sessionId} (${triggerType})`)
  const dispatchCtx: DispatchContext = {
    triggerType,
    executionMode: ctx.executionMode ?? 'immediate',
    triggerContext: ctx.trainingId ? { trainingId: ctx.trainingId } : undefined,
    actorUserId: ctx.actorUserId ?? null,
  }
  for (const rule of rules) {
    await dispatchRule(rule.id, sessionId, dispatchCtx)
  }
}

/**
 * Dispatch a rule: queue every step at its configured delay. Each step
 * runs independently, but they share the same QStash callback shape so
 * cancellation / replay works the same way.
 *
 * Steps run independently (not chained sequentially); a later step does NOT
 * wait for an earlier step to complete. delayMinutes is interpreted relative
 * to the trigger event, so step 0 at delay=0 fires immediately, step 1 at
 * delay=60 fires 1h after the trigger regardless of whether step 0 succeeded.
 */
export async function dispatchRule(ruleId: string, sessionId: string, ctx?: DispatchContext) {
  const rule = await prisma.automationRule.findUnique({
    where: { id: ruleId },
    select: {
      id: true,
      triggerType: true,
      steps: { orderBy: { order: 'asc' } },
    },
  })
  if (!rule) return
  if (rule.steps.length === 0) {
    console.warn(`[Automation] Rule ${ruleId} has no steps configured — skipping`)
    return
  }
  // Default the trigger type to the rule's own when the caller didn't
  // supply one (e.g. legacy QStash callbacks with the rule-shape payload).
  const dispatchCtx: DispatchContext = ctx ?? {
    triggerType: rule.triggerType,
    executionMode: 'immediate',
  }
  for (const step of rule.steps) {
    await dispatchStep(rule.id, step, sessionId, dispatchCtx)
  }
}

/**
 * Queue a single step for a session at its delayMinutes. Splits step.channel='both'
 * into one execution per channel.
 *
 * Timing modes:
 *  - 'trigger'        → delay seconds from NOW (default).
 *  - 'before_meeting' → fire at InterviewMeeting.scheduledStart - delayMinutes.
 *  - 'after_meeting'  → fire at InterviewMeeting.scheduledStart + delayMinutes.
 *
 * For meeting-relative modes we look up the latest InterviewMeeting attached
 * to the session. If none exists, we SKIP — falling through to trigger
 * semantics ("send now") would defeat the recruiter's intent ("send X minutes
 * before the meeting") and produces the bug where reminders fire immediately
 * after meeting_scheduled instead of relative to scheduledStart.
 */
async function dispatchStep(
  ruleId: string,
  step: { id: string; delayMinutes: number; channel: string; timingMode?: string | null },
  sessionId: string,
  ctx: DispatchContext,
) {
  const channels = expandChannels(step.channel)
  const mode = step.timingMode || 'trigger'
  let delaySeconds: number = step.delayMinutes * 60

  if (mode === 'before_meeting' || mode === 'after_meeting') {
    const meeting = await prisma.interviewMeeting.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      select: { scheduledStart: true },
    })
    if (!meeting?.scheduledStart) {
      console.warn(`[Automation] Skipping step ${step.id} for session ${sessionId} — timingMode=${mode} but no InterviewMeeting found`)
      return
    }
    const nowMs = Date.now()
    const sign = mode === 'before_meeting' ? -1 : 1
    const fireAtMs = meeting.scheduledStart.getTime() + sign * step.delayMinutes * 60_000
    delaySeconds = Math.floor((fireAtMs - nowMs) / 1000)

    // For before_meeting: if the MEETING itself has already started/passed,
    // skip. Sending "X minutes before" copy after the meeting started is
    // contradictory.
    if (mode === 'before_meeting' && meeting.scheduledStart.getTime() <= nowMs) {
      console.log(`[Automation] Skipping step ${step.id} for session ${sessionId} — before_meeting requested but meeting already started/passed`)
      return
    }

    // For before_meeting, skip when we're so late that the copy no longer
    // matches reality. A "24h before" reminder going out 1h before the meeting
    // contradicts itself ("Your interview is in 24 hours" while it's actually
    // in 1 hour). Threshold: more than half the configured window has elapsed
    // since the intended fire time. So a 24h reminder firing 22h out (2h
    // late) still fires; firing <12h out skips. A 60m reminder firing 50m
    // out (10m late) still fires; firing <30m out skips.
    if (mode === 'before_meeting') {
      const lateByMs = nowMs - (meeting.scheduledStart.getTime() - step.delayMinutes * 60_000)
      if (lateByMs > (step.delayMinutes * 60_000) / 2) {
        console.log(`[Automation] Skipping step ${step.id} for session ${sessionId} — before_meeting fire time too far past (late by ${Math.floor(lateByMs / 60000)}m vs ${step.delayMinutes}m configured)`)
        return
      }
    }

    // Otherwise, if the computed fire time is in the past or imminent (the
    // recruiter just added/edited the rule mid-cycle for an upcoming
    // meeting), fire immediately rather than skip — better late than
    // missed. The 24h reminder for a meeting now 23h out goes out now.
    if (delaySeconds < 60) {
      console.log(`[Automation] Step ${step.id} (${mode}) fire time already past/imminent (${delaySeconds}s) — firing immediately for session ${sessionId}`)
      delaySeconds = 0
    }
  }

  for (const channel of channels) {
    if (delaySeconds > 0 && qstash) {
      await queueStepAtDelay(ruleId, step.id, sessionId, channel, delaySeconds, ctx)
    } else {
      await executeStep(step.id, sessionId, channel, { dispatchCtx: ctx })
    }
  }
}

/**
 * Expand a step.channel value to the channels we'll actually send on. 'both'
 * fans out into [email, sms]; the literal channel passes through.
 */
function expandChannels(channel: string): Array<'email' | 'sms'> {
  if (channel === 'both') return ['email', 'sms']
  if (channel === 'sms') return ['sms']
  return ['email']
}

/**
 * Find-or-create the AutomationExecution row for (step, session, channel).
 * Mirrors the prior single-row-per-execution model but keyed on the step.
 */
async function upsertExecution(opts: {
  ruleId: string
  stepId: string
  sessionId: string
  channel: 'email' | 'sms'
  status: string
  scheduledFor?: Date | null
  executionMode?: ExecutionMode
  /**
   * When true, clear `qstashMessageId` (the caller has just deleted the old
   * QStash message and is about to publish a fresh one). When false, the
   * existing messageId is preserved so a transient re-entry (e.g. a stale
   * callback) does not lose the live message id — that was the pre-fix
   * behaviour that left orphan QStash messages firing with no DB pointer.
   */
  resetQueueState?: boolean
  /**
   * StageEntry id for `stage_entered` execs. Scopes both the lookup and the
   * created row so re-entry to the same stage produces a fresh execution
   * row (the new StageEntry id never collides with the previous one).
   */
  stageEntryId?: string | null
}) {
  const stageEntryId = opts.stageEntryId ?? null
  const existing = await prisma.automationExecution.findFirst({
    where: {
      stepId: opts.stepId,
      sessionId: opts.sessionId,
      channel: opts.channel,
      stageEntryId,
    },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) {
    return prisma.automationExecution.update({
      where: { id: existing.id },
      data: {
        status: opts.status,
        scheduledFor: opts.scheduledFor ?? null,
        // Only blank these when the caller is explicitly resetting the
        // queued state (e.g. queueStepAtDelay after deleting the old
        // QStash msg). Otherwise keep them — a re-entry without a queue
        // reset must not orphan the QStash message or lose error context.
        ...(opts.resetQueueState
          ? { errorMessage: null, qstashMessageId: null }
          : {}),
        // executionMode is upserted whenever the caller provides one so
        // we capture which path actually produced the current state.
        ...(opts.executionMode ? { executionMode: opts.executionMode } : {}),
      },
    })
  }
  return prisma.automationExecution.create({
    data: {
      automationRuleId: opts.ruleId,
      stepId: opts.stepId,
      sessionId: opts.sessionId,
      channel: opts.channel,
      stageEntryId,
      status: opts.status,
      scheduledFor: opts.scheduledFor ?? null,
      executionMode: opts.executionMode ?? null,
    },
  })
}

/**
 * Lower-level: queue a step+channel via QStash with an arbitrary delay.
 */
async function queueStepAtDelay(
  ruleId: string,
  stepId: string,
  sessionId: string,
  channel: 'email' | 'sms',
  delaySeconds: number,
  ctx: DispatchContext,
): Promise<boolean> {
  if (!qstash || delaySeconds <= 0) {
    await executeStep(stepId, sessionId, channel, { dispatchCtx: ctx })
    return false
  }
  const scheduledFor = new Date(Date.now() + delaySeconds * 1000)
  const stageEntryId = ctx.stageEntryId ?? null
  const existing = await prisma.automationExecution.findFirst({
    where: { stepId, sessionId, channel, stageEntryId },
    orderBy: { createdAt: 'desc' },
  })
  if (existing?.status === 'sent') return false
  // Delete any previously-queued QStash msg for this row before re-publishing.
  // Without this, a second meeting_scheduled (rebooking, in-app re-create)
  // overwrites qstashMessageId in the DB but leaves the old QStash msg live —
  // so the stale msg fires later against whatever meeting is current at that
  // time, producing wrong-time reminders (e.g. "1h before" SMS arriving 14h
  // early after a rebooking).
  if (existing?.qstashMessageId) {
    try {
      await (qstash.messages as unknown as { delete: (id: string) => Promise<unknown> }).delete(existing.qstashMessageId)
    } catch (err) {
      console.warn('[Automation] qstash.messages.delete failed during re-queue (likely already fired):', (err as Error).message)
    }
  }
  const row = await upsertExecution({
    ruleId, stepId, sessionId, channel,
    status: 'queued',
    scheduledFor,
    executionMode: ctx.executionMode,
    stageEntryId,
    // Caller deleted the old QStash msg above (line ~785); reset the queue
    // state so the new publish below replaces the prior messageId cleanly.
    resetQueueState: true,
  })
  try {
    const res = await qstash.publishJSON({
      url: `${APP_URL}/api/automations/run`,
      // Carry the trigger context so the callback handler can pass the same
      // (triggerType, triggerContext) into the guard at execution time — the
      // guard re-loads session/rule/step state from the DB and verifies
      // prerequisites are still met. Without this, the callback would
      // default-trigger off the rule's own triggerType, losing the
      // trainingId/contextual disambiguation needed by predicates like
      // requireCompletedEnrollment.
      body: {
        stepId,
        sessionId,
        channel,
        triggerType: ctx.triggerType,
        triggerContext: ctx.triggerContext,
        // Carry the StageEntry pin so the delayed callback re-applies it
        // when calling executeStep — without this, a queued stage_entered
        // step would land on the callback path with stageEntryId=null and
        // dedupe against the wrong key.
        stageEntryId: ctx.stageEntryId ?? null,
      },
      delay: delaySeconds,
    })
    const messageId = (res as { messageId?: string })?.messageId
    if (messageId) {
      await prisma.automationExecution.update({
        where: { id: row.id },
        data: { qstashMessageId: messageId },
      }).catch(() => {})
    }
    console.log(`[Automation] Queued step ${stepId} (${channel}) for session ${sessionId} (delay ${delaySeconds}s, fires ${scheduledFor.toISOString()}, qstash=${messageId ?? 'unknown'})`)
    return true
  } catch (err) {
    console.error('[Automation] QStash publish failed, running inline:', err)
    await executeStep(stepId, sessionId, channel, { dispatchCtx: ctx })
    return false
  }
}

/**
 * Schedule (or re-schedule) all `before_meeting` reminder rules for a
 * session. Fires only the first step of each rule at `scheduledStart -
 * rule.minutesBefore`. Multi-step before_meeting rules are not yet exposed
 * in the UI, but if they exist, subsequent steps fire `step.delayMinutes`
 * minutes AFTER the first step's fire time (i.e. closer to / after the
 * meeting start).
 */
export async function scheduleBeforeMeetingReminders(sessionId: string, scheduledStart: Date) {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { workspaceId: true, flowId: true },
    })
    if (!session) return
    const pipelineId = await resolveFlowPipelineId({
      flowId: session.flowId,
      workspaceId: session.workspaceId,
    })
    const rules = await prisma.automationRule.findMany({
      where: {
        isActive: true,
        triggerType: 'before_meeting',
        workspaceId: session.workspaceId,
        AND: [
          { OR: [{ flowId: session.flowId }, { flowId: null }] },
          pipelineScopeFragment(pipelineId),
        ],
      },
      select: {
        id: true,
        minutesBefore: true,
        steps: { orderBy: { order: 'asc' } },
      },
    })
    if (rules.length === 0) return
    const now = Date.now()
    for (const rule of rules) {
      const minutesBefore = rule.minutesBefore ?? 0
      if (minutesBefore <= 0) continue
      // If the meeting itself has already started/passed, drop ALL steps for
      // this rule — sending "X before" copy after the meeting is wrong.
      if (scheduledStart.getTime() <= now) {
        console.log(`[Automation] Skipping rule ${rule.id} — meeting already started/passed`)
        continue
      }
      const firstFireAtMs = scheduledStart.getTime() - minutesBefore * 60_000
      for (let i = 0; i < rule.steps.length; i++) {
        const step = rule.steps[i]
        // Step 0 fires `minutesBefore` before the meeting; step N fires
        // step.delayMinutes minutes after step 0's fire time.
        const fireAtMs = firstFireAtMs + (i === 0 ? 0 : step.delayMinutes) * 60_000
        let delaySeconds = Math.floor((fireAtMs - now) / 1000)
        // Late reminder for an upcoming meeting → fire immediately. Better
        // late than missed.
        if (delaySeconds < 60) {
          console.log(`[Automation] Step ${step.id} fire time already past/imminent (${delaySeconds}s) — firing immediately for session ${sessionId}`)
          delaySeconds = 0
        }
        const channels = expandChannels(step.channel)
        const ctx: DispatchContext = {
          triggerType: 'before_meeting',
          executionMode: 'immediate',
        }
        for (const channel of channels) {
          if (delaySeconds > 0 && qstash) {
            await queueStepAtDelay(rule.id, step.id, sessionId, channel, delaySeconds, ctx)
          } else {
            await executeStep(step.id, sessionId, channel, { dispatchCtx: ctx })
          }
        }
      }
    }
  } catch (err) {
    console.error('[Automation] scheduleBeforeMeetingReminders failed:', err)
  }
}

/**
 * Cancel all queued meeting-relative reminders for a session — both rules
 * with triggerType='before_meeting' (legacy rule-level model) and any step
 * whose timingMode is 'before_meeting' or 'after_meeting' (per-step model).
 *
 * Called when the calendar event is cancelled or rescheduled — both
 * scenarios invalidate the meeting-relative fire times.
 */
export async function cancelBeforeMeetingReminders(sessionId: string): Promise<number> {
  return cancelPendingStepsForSession(sessionId, {
    ruleTriggerTypes: new Set(['before_meeting']),
    stepTimingModes: new Set(['before_meeting', 'after_meeting']),
  })
}

/**
 * Execute a single step for a session on a specific channel: render content,
 * send, write the execution row, fire chained rules if this was the rule's
 * last step and the send succeeded.
 */
/**
 * Options for executeStep. dispatchCtx carries the trigger context from the
 * caller (immediate trigger, QStash callback, manual rerun, etc.) so the
 * authoritative guard can re-check prerequisites against current DB state.
 *
 * `ignoreActive`: lets the test endpoint run paused rules. Lifecycle/stage/
 * prerequisite checks still apply — tests of paused rules must still respect
 * candidate lifecycle invariants.
 *
 * `force`: admin-only override for the duplicate-send guard. Only honoured
 * when dispatchCtx.executionMode is 'manual_rerun' or 'debug'. The guard
 * module enforces this rule; callers cannot bypass it by setting force on
 * other modes.
 */
type ExecuteStepOptions = {
  ignoreActive?: boolean
  /** Admin-only override of the duplicate-send guard. */
  force?: boolean
  dispatchCtx?: DispatchContext
}

export async function executeStep(
  stepId: string,
  sessionId: string,
  channel: 'email' | 'sms',
  options?: ExecuteStepOptions,
) {
  console.log(`[Automation] executeStep start stepId=${stepId} sessionId=${sessionId} channel=${channel}`)
  const step = await prisma.automationStep.findUnique({
    where: { id: stepId },
    include: {
      emailTemplate: true,
      smsTemplate: true,
      training: true,
      schedulingConfig: true,
      rule: {
        include: {
          workspace: { select: { senderEmail: true, senderName: true, senderVerifiedAt: true, senderDomain: true, senderDomainValidatedAt: true, timezone: true, phone: true } },
        },
      },
    },
  })
  if (!step) { console.log(`[Automation] Step ${stepId} NOT FOUND`); return }
  const rule = step.rule
  if (!rule.isActive && !options?.ignoreActive) { console.log(`[Automation] Rule ${rule.id} INACTIVE — skipping step ${stepId}`); return }

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { flow: true, ad: true },
  })
  if (!session) { console.log(`[Automation] Session ${sessionId} NOT FOUND`); return }

  // ─── Authoritative guard ─────────────────────────────────────────────────
  // Every send path converges here. The guard re-loads prerequisites against
  // current DB state, so delayed QStash callbacks can't trust enqueue-time
  // assumptions. force is honoured only for manual_rerun / debug modes, and
  // only bypasses the duplicate-send check — never lifecycle, stage, or
  // prerequisite checks.
  //
  // Test sessions (`source='test'`) created by the /automations/[id]/test
  // endpoint are throwaway by design — they bypass eligibility checks so
  // the recruiter can render the email/SMS body end-to-end without first
  // satisfying lifecycle/stage/prerequisite gates. The bypass requires
  // BOTH source='test' on the session AND the caller passing
  // bypassEligibilityForTest, so a real session can never trip it.
  const dispatchCtx = options?.dispatchCtx
  const isTestBypass = dispatchCtx?.bypassEligibilityForTest === true && session.source === 'test'
  if (!isTestBypass) {
    const guard = await canExecuteAutomationStep({
      session,
      rule,
      step,
      channel,
      triggerType: dispatchCtx?.triggerType ?? rule.triggerType,
      triggerContext: dispatchCtx?.triggerContext,
      executionMode: dispatchCtx?.executionMode ?? 'immediate',
      force: options?.force ?? dispatchCtx?.force,
      actorUserId: dispatchCtx?.actorUserId,
      stageEntryId: dispatchCtx?.stageEntryId,
    })
    if (!guard.allowed) {
      console.log(`[Automation] Step ${stepId} BLOCKED by guard: ${guard.reason} (session ${sessionId})`)
      await recordSkip({
        ruleId: rule.id,
        stepId,
        sessionId,
        channel,
        executionMode: dispatchCtx?.executionMode ?? 'immediate',
        actorUserId: dispatchCtx?.actorUserId ?? null,
        result: guard,
        session,
        stageEntryId: dispatchCtx?.stageEntryId,
      })
      return
    }
  }

  const execution = await upsertExecution({
    ruleId: rule.id, stepId, sessionId, channel,
    status: 'pending',
    executionMode: dispatchCtx?.executionMode,
    stageEntryId: dispatchCtx?.stageEntryId,
  })

  // ─── Resolve merge tokens (training link, scheduling link, meeting info) ──
  let trainingLink = ''
  if (step.nextStepType === 'training' && step.trainingId && step.training) {
    try {
      const { token } = await createAccessToken({ sessionId, trainingId: step.trainingId, sourceRefId: rule.id })
      trainingLink = buildTrainingLink(step.training.slug, token)
    } catch (err) {
      console.error('[Automation] Failed to generate training token:', err)
      trainingLink = step.nextStepUrl || ''
    }
  } else if (step.nextStepType === 'training' && step.nextStepUrl) {
    trainingLink = step.nextStepUrl
  }

  let scheduleLink = ''
  if (step.nextStepType === 'scheduling') {
    try {
      const resolved = await resolveSchedulingUrl(step.schedulingConfigId, session.workspaceId)
      if (resolved) scheduleLink = buildScheduleRedirectUrl(sessionId, resolved.configId)
    } catch (err) {
      console.error('[Automation] Failed to resolve scheduling URL:', err)
    }
    if (!scheduleLink && step.nextStepUrl) scheduleLink = step.nextStepUrl
  }

  // Background check link. When nextStepType='background_check', order a
  // Certn case (or reuse the existing active one) and surface the invite URL
  // via {{certn_link}}. Same semantics as training_link — the recruiter
  // configures the merge token in the email/SMS body and we resolve it
  // here. Failures are logged and the link stays empty rather than
  // crashing the send; the recruiter sees the missing link in the rendered
  // email and can investigate.
  let certnLink = ''
  if (step.nextStepType === 'background_check') {
    try {
      const { orderForSession } = await import('./certn/order')
      const result = await orderForSession({
        sessionId,
        orderedById: null,
      })
      certnLink = result.backgroundCheck.inviteLink || ''
    } catch (err) {
      console.error('[Automation] Failed to order Certn background check:', err)
    }
  }

  let meetingTime = ''
  let meetingLink = ''
  let rescheduleLink = ''
  let cancelLink = ''
  let recordingLink = ''
  let transcriptLink = ''
  let recordingStatusNote = ''

  const interviewMeeting = await prisma.interviewMeeting.findFirst({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, meetingUri: true, scheduledStart: true, recordingState: true,
      transcriptState: true, driveRecordingFileId: true, driveTranscriptFileId: true,
      schedulingConfigId: true,
    },
  }).catch(() => null)

  // Render meeting time in the workspace's timezone — without this, the
  // server's runtime tz (UTC on Vercel/Railway) leaks into the email and
  // candidates see e.g. "4:00 PM" for a 12pm-EDT meeting.
  const workspaceTz = rule.workspace.timezone || 'America/New_York'
  const formatMeetingTime = (d: Date) => d.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: workspaceTz,
    timeZoneName: 'short',
  })

  if (interviewMeeting) {
    meetingLink = interviewMeeting.meetingUri || ''
    const d = interviewMeeting.scheduledStart
    if (d) meetingTime = formatMeetingTime(d)
    const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'https://www.hirefunnel.app'
    // Issue reschedule + cancel links if the meeting was created via a
    // built-in scheduler config. External-provider configs (Calendly etc.)
    // don't accept our reschedule endpoint, so leave the tokens blank for them.
    if (interviewMeeting.schedulingConfigId && d) {
      try {
        const cfg = await prisma.schedulingConfig.findUnique({
          where: { id: interviewMeeting.schedulingConfigId },
          select: { useBuiltInScheduler: true },
        })
        if (cfg?.useBuiltInScheduler) {
          const { issueBookingToken } = await import('./scheduling/booking-links')
          // Tokens expire 1h before the meeting starts — no changes after meeting begins.
          const cutoff = new Date(d.getTime() - 60 * 60_000)
          const reTok = issueBookingToken({ sessionId, configId: interviewMeeting.schedulingConfigId, purpose: 'reschedule', expiresAt: cutoff })
          const caTok = issueBookingToken({ sessionId, configId: interviewMeeting.schedulingConfigId, purpose: 'cancel', expiresAt: cutoff })
          rescheduleLink = `${appUrl}/book/${interviewMeeting.schedulingConfigId}/reschedule?t=${encodeURIComponent(reTok)}`
          cancelLink = `${appUrl}/book/${interviewMeeting.schedulingConfigId}/cancel?t=${encodeURIComponent(caTok)}`
        }
      } catch (err) {
        console.error('[Automation] Failed to issue reschedule/cancel tokens:', err)
      }
    }
    if (interviewMeeting.recordingState === 'ready' && interviewMeeting.driveRecordingFileId) {
      try {
        const { signArtifactToken } = await import('./meet/pubsub-jwt')
        const tok = signArtifactToken({
          meetingId: interviewMeeting.id,
          kind: 'recording',
          exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        })
        recordingLink = `${appUrl}/api/interview-meetings/${interviewMeeting.id}/recording?t=${encodeURIComponent(tok)}`
      } catch { /* leave empty */ }
    } else if (interviewMeeting.recordingState === 'processing' || interviewMeeting.recordingState === 'requested') {
      recordingStatusNote = 'Recording will be available shortly.'
    } else if (interviewMeeting.recordingState === 'failed' || interviewMeeting.recordingState === 'unavailable') {
      recordingStatusNote = 'Recording was not captured for this interview.'
    }
    if (interviewMeeting.transcriptState === 'ready' && interviewMeeting.driveTranscriptFileId) {
      try {
        const { signArtifactToken } = await import('./meet/pubsub-jwt')
        const tok = signArtifactToken({
          meetingId: interviewMeeting.id,
          kind: 'transcript',
          exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        })
        transcriptLink = `${appUrl}/api/interview-meetings/${interviewMeeting.id}/transcript?t=${encodeURIComponent(tok)}`
      } catch { /* leave empty */ }
    }
  } else {
    const latestMeeting = await prisma.schedulingEvent.findFirst({
      where: {
        sessionId,
        eventType: { in: ['meeting_scheduled', 'meeting_rescheduled'] },
      },
      orderBy: { eventAt: 'desc' },
      select: { metadata: true },
    })
    if (latestMeeting?.metadata) {
      const meta = latestMeeting.metadata as Record<string, unknown>
      if (typeof meta.scheduledAt === 'string') {
        const d = new Date(meta.scheduledAt)
        if (!isNaN(d.getTime())) meetingTime = formatMeetingTime(d)
      }
      if (typeof meta.meetingUrl === 'string') meetingLink = meta.meetingUrl
    }
  }

  const variables: Record<string, string> = {
    candidate_name: session.candidateName || 'Candidate',
    candidate_email: session.candidateEmail || '',
    candidate_phone: session.candidatePhone || '',
    flow_name: session.flow.name,
    training_link: trainingLink,
    schedule_link: scheduleLink,
    certn_link: certnLink,
    meeting_time: meetingTime,
    meeting_link: meetingLink,
    reschedule_link: rescheduleLink,
    cancel_link: cancelLink,
    recording_link: recordingLink,
    transcript_link: transcriptLink,
    recording_status_note: recordingStatusNote,
    source: session.source || '',
    ad_name: session.ad?.name || '',
  }

  // ─── Send on the requested channel ─────────────────────────────────
  let result: { success: boolean; error?: string; messageId?: string }
  let provider: 'sendgrid' | 'sigcore' = 'sendgrid'

  if (channel === 'sms') {
    provider = 'sigcore'
    // Resolve SMS body: prefer the saved SmsTemplate (named, reusable) over
    // the legacy inline step.smsBody (one-off / pre-template). The template's
    // body wins when smsTemplateId is set, even if smsBody is also populated.
    const resolvedSmsBody =
      (step.smsTemplate?.body && step.smsTemplate.body.trim().length > 0)
        ? step.smsTemplate.body
        : (step.smsBody ?? '')
    if (!resolvedSmsBody || resolvedSmsBody.trim().length === 0) {
      await prisma.automationExecution.update({
        where: { id: execution.id },
        data: { status: 'failed', errorMessage: 'SMS step has no body configured', channel, provider },
      })
      return
    }

    // Resolve recipient phone based on smsDestination — mirrors email's
    // applicant / company / specific options. Default 'applicant' → candidate.
    let rawRecipient: string | null = null
    let recipientLabel = ''
    if (step.smsDestination === 'company') {
      rawRecipient = rule.workspace?.phone ?? null
      recipientLabel = 'workspace company phone'
    } else if (step.smsDestination === 'specific') {
      rawRecipient = step.smsDestinationNumber ?? null
      recipientLabel = 'specific number on the step'
    } else {
      rawRecipient = session.candidatePhone ?? null
      recipientLabel = 'candidate phone'
    }
    if (!rawRecipient) {
      await prisma.automationExecution.update({
        where: { id: execution.id },
        data: { status: 'failed', errorMessage: `No ${recipientLabel} configured`, channel, provider },
      })
      return
    }
    const normalized = normalizeToE164(rawRecipient)
    if (!normalized) {
      await prisma.automationExecution.update({
        where: { id: execution.id },
        data: { status: 'failed', errorMessage: `${recipientLabel} is not E.164-normalizable: ${rawRecipient}`, channel, provider },
      })
      return
    }
    const body = renderTemplate(resolvedSmsBody, variables)
    // Note: if the recruiter set "Includes link to" but the body doesn't
    // contain the matching {{xxx_link}} token, the link silently won't
    // appear. The rule editor surfaces this as an inline warning so the
    // recruiter can add the token where they want it placed.
    try {
      const sent = await sendSms({
        candidateId: sessionId,
        workspaceId: session.workspaceId,
        to: normalized,
        body,
        automationExecutionId: execution.id,
      })
      result = { success: true, messageId: sent.providerMessageId }
    } catch (err) {
      let errorMessage: string
      if (err instanceof SmsConfigError) errorMessage = `SMS not configured: ${err.message}`
      else if (err instanceof SmsValidationError) errorMessage = `SMS validation: ${err.message}`
      else if (err instanceof SmsSendError) errorMessage = `Sigcore: ${err.message}`
      else errorMessage = (err as Error).message || 'Unknown SMS error'
      result = { success: false, error: errorMessage }
    }
  } else {
    if (!step.emailTemplate) {
      await prisma.automationExecution.update({
        where: { id: execution.id },
        data: { status: 'failed', errorMessage: 'Email step has no template configured', channel, provider },
      })
      return
    }
    const subject = renderTemplate(step.emailTemplate.subject, variables)
    const html = renderTemplate(step.emailTemplate.bodyHtml, variables)
    const text: string | undefined = step.emailTemplate.bodyText ? renderTemplate(step.emailTemplate.bodyText, variables) : undefined
    // Note: if the recruiter set "Includes link to" but the template doesn't
    // contain the matching {{xxx_link}} token, the link silently won't
    // appear. The rule editor surfaces this as an inline warning so the
    // recruiter can add the token where they want it placed.

    let recipient: string | null = null
    if (step.emailDestination === 'company') recipient = rule.workspace?.senderEmail || null
    else if (step.emailDestination === 'specific') recipient = step.emailDestinationAddress || null
    else recipient = session.candidateEmail

    if (!recipient) {
      await prisma.automationExecution.update({
        where: { id: execution.id },
        data: { status: 'failed', errorMessage: `No ${step.emailDestination} email configured`, channel, provider },
      })
      return
    }

    let from: { email: string; name?: string } | null = null
    const ws = rule.workspace
    if (ws?.senderEmail && ws?.senderName) {
      const domainOk = !!(ws.senderDomainValidatedAt && ws.senderDomain && ws.senderEmail.toLowerCase().endsWith('@' + ws.senderDomain.toLowerCase()))
      const singleOk = !!ws.senderVerifiedAt
      if (domainOk || singleOk) {
        from = { email: ws.senderEmail, name: ws.senderName || undefined }
      }
    }

    // For company-destination notifications the recipient IS the workspace
    // sender, so without a reply-to the recruiter's "Reply" goes back to
    // their own inbox. Point it at the candidate so replies actually reach
    // them.
    let replyTo: { email: string; name?: string } | null = null
    if (step.emailDestination === 'company' && session.candidateEmail) {
      replyTo = { email: session.candidateEmail, name: session.candidateName || undefined }
    }

    result = await sendEmail({
      to: recipient,
      subject,
      html,
      text,
      from,
      replyTo,
      executionId: execution.id,
      workspaceId: session.workspaceId,
      candidateId: sessionId,
    })
  }

  await prisma.automationExecution.update({
    where: { id: execution.id },
    data: {
      status: result.success ? 'sent' : 'failed',
      errorMessage: result.error || null,
      providerMessageId: result.messageId || null,
      sentAt: result.success ? new Date() : null,
      channel,
      provider,
    },
  })

  if (result.success && step.nextStepType === 'scheduling') {
    const resolved = await resolveSchedulingUrl(step.schedulingConfigId).catch(() => null)
    await logSchedulingEvent({
      sessionId,
      schedulingConfigId: resolved?.configId || null,
      eventType: 'invite_sent',
      metadata: { automationRuleId: rule.id, automationStepId: step.id, executionId: execution.id },
    }).catch(() => {})
    // Don't regress pipeline status when the rule fires AFTER the candidate
    // has already booked a meeting — those scheduling links are for
    // rescheduling, not first-time scheduling. Without this guard, a
    // before_meeting reminder with a scheduling link would knock the card
    // back to "Application Done"/"Invited to Schedule" right before the
    // interview. meeting_no_show keeps its existing exclusion (no-show flow
    // manages status via its own path).
    const POST_SCHEDULING_TRIGGERS = new Set([
      'meeting_scheduled', 'before_meeting',
      'meeting_started', 'meeting_ended', 'meeting_no_show',
      'recording_ready', 'transcript_ready',
    ])
    if (!POST_SCHEDULING_TRIGGERS.has(rule.triggerType)) {
      await updatePipelineStatus(sessionId, 'invited_to_schedule').catch(() => {})
    }
  }

  // Chain: fire automation_completed rules only when the *last* step of this
  // rule has succeeded across all of its channels. Otherwise downstream rules
  // would fire mid-sequence.
  if (result.success) {
    await maybeFireChainedRules(rule.id, sessionId, session)
  }
}

/**
 * Backwards-compatible entry point: execute a rule for a session as a single
 * unit. New code should use dispatchRule instead. Kept because the test
 * harness ([id]/test/route.ts) wants to run a rule end-to-end and assert on
 * its execution status, and because the QStash callback may still be holding
 * old-shape messages with { ruleId, sessionId }.
 *
 * Runs every step inline (ignoring delay) on every channel. The `ignoreActive`
 * flag propagates to executeStep so paused rules can be tested. The
 * `ignoreSentGuard` flag bypasses the per-(step,session,channel) "already
 * sent" check so a recruiter-initiated manual run can intentionally re-send.
 */
export async function executeRule(
  ruleId: string,
  sessionId: string,
  options?: {
    ignoreActive?: boolean
    /** Admin-only override of the duplicate-send guard. Honoured only for
     * manual_rerun / debug executionModes. */
    force?: boolean
    dispatchCtx?: DispatchContext
  },
) {
  const rule = await prisma.automationRule.findUnique({
    where: { id: ruleId },
    select: { id: true, isActive: true, triggerType: true, steps: { orderBy: { order: 'asc' } } },
  })
  if (!rule) return
  if (!rule.isActive && !options?.ignoreActive) return
  const ctx: DispatchContext = options?.dispatchCtx ?? {
    triggerType: rule.triggerType,
    executionMode: 'immediate',
  }
  for (const step of rule.steps) {
    for (const channel of expandChannels(step.channel)) {
      await executeStep(step.id, sessionId, channel, {
        ignoreActive: options?.ignoreActive,
        force: options?.force,
        dispatchCtx: ctx,
      })
    }
  }
}

/**
 * Fire any automation_completed rules chained off the given rule, but only
 * once all of its steps' executions for this session have terminated
 * (status=sent or failed) — not while later steps are still queued. This
 * keeps "after automation X" semantics intact for multi-step parents.
 */
async function maybeFireChainedRules(ruleId: string, sessionId: string, session: SessionCtx) {
  const rule = await prisma.automationRule.findUnique({
    where: { id: ruleId },
    select: {
      id: true,
      workspaceId: true,
      steps: {
        select: {
          id: true,
          channel: true,
          executions: { where: { sessionId }, select: { id: true, status: true, channel: true } },
        },
      },
    },
  })
  if (!rule) return

  // Did every (step, channel) pair we *were going to send* land in a
  // terminal state? If any are still queued/pending/waiting, defer.
  for (const step of rule.steps) {
    const expected = expandChannels(step.channel)
    for (const ch of expected) {
      const ex = step.executions.find((e) => e.channel === ch)
      if (!ex) return
      if (ex.status !== 'sent' && ex.status !== 'failed') return
    }
  }

  const chained = await prisma.automationRule.findMany({
    where: {
      isActive: true,
      triggerType: 'automation_completed',
      triggerAutomationId: ruleId,
      workspaceId: session.workspaceId,
    },
    select: { id: true },
  })
  for (const c of chained) {
    // executionMode=chained so skips on the chained side are auditable and
    // bypasses (force) cannot leak through the cascade.
    await dispatchRule(c.id, sessionId, {
      triggerType: 'automation_completed',
      executionMode: 'chained',
      triggerContext: { parentRuleId: ruleId },
    })
  }
}
