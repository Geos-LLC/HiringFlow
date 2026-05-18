/**
 * Central automation execution guard.
 *
 * Every code path that can produce an AutomationExecution row — immediate
 * trigger, delayed QStash callback, chained rule, manual rerun, cron, public
 * webhook, debug — MUST go through `canExecuteAutomationStep` before it
 * sends, promotes, chains, or enqueues. There are no local exceptions.
 *
 * Two policies live here:
 *   - Automatic paths (immediate/delayed_callback/chained/cron/public_trigger):
 *     halt, lifecycle, stage, prerequisite, and idempotency are all enforced.
 *   - Manual rerun (`manual_rerun`): no skipping. The recruiter clicked the
 *     "Run automations" button; the endpoint is role-gated upstream. The
 *     guard returns allowed:true immediately so the step always runs and is
 *     always recorded on the timeline.
 *   - Debug (`debug`): can additionally pass `force=true` to bypass the
 *     idempotency check (lifecycle/stage/prereq/halt still enforced).
 *
 * Design properties (per ARCHITECTURE.md / user requirements):
 *  - Authoritative: this is the only place lifecycle, stage, prerequisite,
 *    and idempotency rules live. Callers do not re-implement them.
 *  - DB-fresh: every call reloads the relevant pieces of state from the DB.
 *    Delayed callbacks never trust enqueue-time state.
 *  - Composable: prerequisites are a map of triggerType → predicate, not a
 *    growing switch. New triggers wire a single predicate; legacy ones keep
 *    the open-trigger default (no prerequisite).
 *  - Skip is a first-class result: blocked attempts persist as
 *    AutomationExecution rows with status `skipped_*` and `skipReason`,
 *    so the run history is queryable and analytics can surface the
 *    distribution of skips.
 */
import { prisma } from './prisma'
import type {
  AutomationExecution,
  AutomationRule,
  AutomationStep,
  Session,
} from '@prisma/client'

// ─── Public types ──────────────────────────────────────────────────────────

export type ExecutionMode =
  | 'immediate'         // synchronous dispatch from a trigger event
  | 'delayed_callback'  // QStash callback firing a queued step
  | 'chained'           // maybeFireChainedRules → automation_completed cascade
  | 'manual_rerun'      // /candidates/:id/run-stage-automations, /automations/:id/test
  | 'cron'              // any /api/cron/* handler firing a step
  | 'public_trigger'    // /api/public/* (training progress, booking, etc.)
  | 'debug'             // /api/automations/debug — admin-only

export type SkipReason =
  | 'skipped_wrong_status'
  | 'skipped_wrong_stage'
  | 'skipped_missing_prerequisite'
  | 'skipped_duplicate'
  | 'skipped_cancelled'
  | 'skipped_ineligible'

export type GuardCtx = {
  session: Session
  rule: AutomationRule
  step: AutomationStep
  channel: 'email' | 'sms'
  triggerType: string
  triggerContext?: Record<string, unknown>
  executionMode: ExecutionMode
  /**
   * Debug-only override. Honoured when executionMode is `debug` to bypass
   * the idempotency (duplicate) guard. NOT needed for `manual_rerun` — that
   * mode short-circuits above and bypasses every check unconditionally.
   * Ignored for all other modes.
   */
  force?: boolean
  /** Used to stamp triggeredByUserId on the resulting AutomationExecution. */
  actorUserId?: string | null
  /**
   * Pipeline Transitions v2 — the StageEntry this send is pinned to. Set
   * only for `stage_entered` triggers; null/undefined for raw-event triggers
   * (flow_completed, training_completed, meeting_*, before_meeting, etc.).
   *
   * Threaded into the idempotency lookup so a candidate re-entering a stage
   * after leaving it produces a fresh execution row (the StageEntry id is
   * unique per entry, so the new (stepId, sessionId, channel, stageEntryId)
   * tuple cannot collide with the previous entry's row).
   */
  stageEntryId?: string | null
}

export type GuardResult =
  | { allowed: true }
  | {
      allowed: false
      reason: SkipReason
      currentState: Record<string, unknown>
      requiredState?: Record<string, unknown>
    }

// ─── Lifecycle status ──────────────────────────────────────────────────────

/**
 * Statuses where candidate-facing automations are blocked by default.
 *
 *  - `stalled` / `lost` / `hired` / `archived`: the candidate is no longer
 *    progressing through the funnel. Forward-moving automations would
 *    contradict the lifecycle state.
 *
 * A rule can opt in to firing for these statuses via `allowedForStatuses`
 * (goodbye emails, compliance notices, etc.). No UI exposes this — set it
 * in code via direct prisma update, intentionally.
 */
const BLOCKING_STATUSES = new Set(['stalled', 'lost', 'hired', 'archived'])

function isStatusAllowed(session: Session, rule: AutomationRule): boolean {
  const status = session.status || 'active'
  if (!BLOCKING_STATUSES.has(status)) return true
  const allowed = (rule as AutomationRule & { allowedForStatuses?: string[] }).allowedForStatuses ?? []
  return allowed.includes(status)
}

// ─── Prerequisite predicates ───────────────────────────────────────────────

/**
 * Composable prerequisite predicates per triggerType. A trigger with no
 * registered predicate is treated as open (allowed) — this keeps the door
 * open for trigger types whose semantics are "fire whenever asked" without
 * forcing this module to enumerate everything.
 *
 * Each predicate returns { satisfied:true } on pass or
 * { satisfied:false, currentState, requiredState } on fail so the guard
 * caller can persist *why* the step was skipped.
 */
type PrerequisiteResult =
  | { satisfied: true }
  | { satisfied: false; currentState: Record<string, unknown>; requiredState?: Record<string, unknown> }

type PrerequisitePredicate = (ctx: {
  session: Session
  rule: AutomationRule
  step: AutomationStep
  triggerType: string
  triggerContext?: Record<string, unknown>
}) => Promise<PrerequisiteResult>

const requireCompletedEnrollment: PrerequisitePredicate = async ({ session, triggerContext }) => {
  const trainingId = typeof triggerContext?.trainingId === 'string' ? (triggerContext.trainingId as string) : null
  const enr = await prisma.trainingEnrollment.findFirst({
    where: {
      sessionId: session.id,
      completedAt: { not: null },
      ...(trainingId ? { trainingId } : {}),
    },
    select: { id: true, completedAt: true, trainingId: true },
  })
  if (enr) return { satisfied: true }
  return {
    satisfied: false,
    currentState: { enrollmentCompletedAt: null },
    requiredState: { enrollmentCompletedAt: 'not null', trainingId: trainingId ?? 'any' },
  }
}

const requireStartedEnrollment: PrerequisitePredicate = async ({ session, triggerContext }) => {
  // `startedAt` is non-nullable with a default(now()) — existence of the
  // enrollment row is the meaningful signal.
  const trainingId = typeof triggerContext?.trainingId === 'string' ? (triggerContext.trainingId as string) : null
  const enr = await prisma.trainingEnrollment.findFirst({
    where: {
      sessionId: session.id,
      ...(trainingId ? { trainingId } : {}),
    },
    select: { id: true },
  })
  if (enr) return { satisfied: true }
  return {
    satisfied: false,
    currentState: { enrollment: null },
    requiredState: { enrollment: 'exists' },
  }
}

const requireInterviewMeeting: PrerequisitePredicate = async ({ session }) => {
  const m = await prisma.interviewMeeting.findFirst({
    where: { sessionId: session.id },
    select: { id: true, scheduledStart: true },
  })
  if (m) return { satisfied: true }
  return {
    satisfied: false,
    currentState: { interviewMeeting: null },
    requiredState: { interviewMeeting: 'exists' },
  }
}

const requireMeetingActualStart: PrerequisitePredicate = async ({ session }) => {
  const m = await prisma.interviewMeeting.findFirst({
    where: { sessionId: session.id, actualStart: { not: null } },
    select: { id: true },
  })
  if (m) return { satisfied: true }
  return {
    satisfied: false,
    currentState: { actualStart: null },
    requiredState: { actualStart: 'not null' },
  }
}

const requireMeetingActualEnd: PrerequisitePredicate = async ({ session }) => {
  const m = await prisma.interviewMeeting.findFirst({
    where: { sessionId: session.id, actualEnd: { not: null } },
    select: { id: true },
  })
  if (m) return { satisfied: true }
  return {
    satisfied: false,
    currentState: { actualEnd: null },
    requiredState: { actualEnd: 'not null' },
  }
}

const requireRecordingReady: PrerequisitePredicate = async ({ session }) => {
  const m = await prisma.interviewMeeting.findFirst({
    where: { sessionId: session.id, recordingState: 'ready' },
    select: { id: true },
  })
  if (m) return { satisfied: true }
  return {
    satisfied: false,
    currentState: { recordingState: 'not ready' },
    requiredState: { recordingState: 'ready' },
  }
}

const requireTranscriptReady: PrerequisitePredicate = async ({ session }) => {
  const m = await prisma.interviewMeeting.findFirst({
    where: { sessionId: session.id, transcriptState: 'ready' },
    select: { id: true },
  })
  if (m) return { satisfied: true }
  return {
    satisfied: false,
    currentState: { transcriptState: 'not ready' },
    requiredState: { transcriptState: 'ready' },
  }
}

function requireBackgroundCheckOutcome(target: 'passed' | 'failed' | 'needs_review'): PrerequisitePredicate {
  // BackgroundCheck.status mirrors Certn's overall_status (CASE_ORDERED, ...)
  // and overallScore mirrors overall_score (CLEAR | REJECT | REVIEW |
  // RESTRICTED | NOT_APPLICABLE). The trigger outcome maps from overall_score:
  //   passed       → CLEAR | NOT_APPLICABLE
  //   failed       → REJECT
  //   needs_review → REVIEW | RESTRICTED
  // The prerequisite is "a closed-out BC exists for the session whose score
  // maps to the trigger's outcome." A stale callback for the wrong outcome
  // can then be skipped cleanly.
  const scoresFor: Record<typeof target, string[]> = {
    passed: ['CLEAR', 'NOT_APPLICABLE'],
    failed: ['REJECT'],
    needs_review: ['REVIEW', 'RESTRICTED'],
  } as const
  return async ({ session }) => {
    const bc = await prisma.backgroundCheck.findFirst({
      where: {
        sessionId: session.id,
        overallScore: { in: scoresFor[target] },
      },
      select: { id: true, overallScore: true },
    })
    if (bc) return { satisfied: true }
    const current = await prisma.backgroundCheck.findFirst({
      where: { sessionId: session.id },
      select: { overallScore: true, status: true },
    })
    return {
      satisfied: false,
      currentState: {
        overallScore: current?.overallScore ?? null,
        certnStatus: current?.status ?? null,
      },
      requiredState: { overallScore: scoresFor[target].join('|') },
    }
  }
}

function requireSessionOutcome(target: 'completed' | 'passed'): PrerequisitePredicate {
  return async ({ session }) => {
    if (session.outcome === target) return { satisfied: true }
    return {
      satisfied: false,
      currentState: { outcome: session.outcome ?? null },
      requiredState: { outcome: target },
    }
  }
}

const PREREQUISITES: Record<string, PrerequisitePredicate> = {
  // Training lifecycle
  training_started: requireStartedEnrollment,
  training_completed: requireCompletedEnrollment,
  // Meeting lifecycle
  meeting_scheduled: requireInterviewMeeting,
  meeting_started: requireMeetingActualStart,
  meeting_ended: requireMeetingActualEnd,
  before_meeting: requireInterviewMeeting,
  meeting_rescheduled: requireInterviewMeeting,
  // Note: meeting_no_show / meeting_cancelled are inherently "negative" events
  // that fire AFTER the meeting was settled into that state, so the guard
  // treats them as open — the dispatcher already verifies the state.
  recording_ready: requireRecordingReady,
  transcript_ready: requireTranscriptReady,
  // Background check
  background_check_passed: requireBackgroundCheckOutcome('passed'),
  background_check_failed: requireBackgroundCheckOutcome('failed'),
  background_check_needs_review: requireBackgroundCheckOutcome('needs_review'),
  // Flow lifecycle
  flow_completed: requireSessionOutcome('completed'),
  flow_passed: requireSessionOutcome('passed'),
}

// ─── Main guard ────────────────────────────────────────────────────────────

/**
 * Authoritative decision: may this (rule, step, channel) be sent now for
 * this session, given the trigger and execution mode?
 *
 * Order of checks (first failure wins):
 *   0. Manual rerun short-circuit — executionMode='manual_rerun' is always
 *      allowed; no other checks run. The recruiter's button click is intent.
 *   1. Halt — session.automationsHaltedAt set.
 *   2. Lifecycle status — session.status in BLOCKING_STATUSES unless
 *      rule.allowedForStatuses opts in.
 *   3. Stage match — rule.stageId, if set, must equal session.pipelineStatus.
 *      Enforced only for executionMode='delayed_callback' (staleness check
 *      on QStash-delayed sends). Same-tick paths trust the rule's trigger.
 *   4. Prerequisite predicate for the triggerType.
 *   5. Idempotency — existing 'sent' execution for (step, session, channel).
 *
 * Rule.isActive is NOT checked here — callers handle it (a paused rule
 * shouldn't even reach the guard, except for the test endpoint which passes
 * an ignoreActive override; in that case we still run the guard because
 * tests must respect lifecycle invariants).
 */
export async function canExecuteAutomationStep(ctx: GuardCtx): Promise<GuardResult> {
  const { session, rule, step, channel, triggerType, executionMode, force } = ctx

  // 0. Manual rerun bypass — recruiter clicked "Run automations" on the
  //    candidate detail page. They explicitly want this rule to fire NOW for
  //    this candidate, regardless of halt / lifecycle / stage / prerequisite
  //    / idempotency. The endpoint that produces `manual_rerun` is itself
  //    role-gated (see /api/candidates/:id/run-stage-automations), so the
  //    privilege check has already happened upstream.
  if (executionMode === 'manual_rerun') {
    return { allowed: true }
  }

  // 1. Halt kill-switch
  if (session.automationsHaltedAt) {
    return {
      allowed: false,
      reason: 'skipped_cancelled',
      currentState: {
        automationsHaltedAt: session.automationsHaltedAt.toISOString(),
        automationsHaltedReason: session.automationsHaltedReason ?? null,
      },
    }
  }

  // 2. Lifecycle status (default-deny for stalled/lost/hired/archived)
  if (!isStatusAllowed(session, rule)) {
    return {
      allowed: false,
      reason: 'skipped_wrong_status',
      currentState: { status: session.status },
      requiredState: { status: 'active|waiting|nurture (or in rule.allowedForStatuses)' },
    }
  }

  // 3. Stage match — staleness protection for *delayed* sends only. A 24h
  //    reminder queued while the candidate was in "training_sent" should NOT
  //    fire if they've since moved on. For same-tick dispatches (immediate,
  //    chained, cron, public_trigger, debug) the rule's triggerType is
  //    authoritative: the event just happened, the rule is wired to it, so
  //    fire. Without this carve-out, rules wired to a stage that the
  //    candidate's pipeline never auto-advances them into (e.g. Dispatcher
  //    pipeline with no entry triggers configured) silently skip every send.
  if (
    rule.stageId &&
    executionMode === 'delayed_callback' &&
    session.pipelineStatus !== rule.stageId
  ) {
    return {
      allowed: false,
      reason: 'skipped_wrong_stage',
      currentState: { pipelineStatus: session.pipelineStatus ?? null },
      requiredState: { pipelineStatus: rule.stageId },
    }
  }

  // 4. Prerequisite — only enforced for triggers with a registered predicate.
  //    Open triggers (no entry in the map) are assumed valid by design.
  const predicate = PREREQUISITES[triggerType]
  if (predicate) {
    const result = await predicate({
      session,
      rule,
      step,
      triggerType,
      triggerContext: ctx.triggerContext,
    })
    if (!result.satisfied) {
      return {
        allowed: false,
        reason: 'skipped_missing_prerequisite',
        currentState: result.currentState,
        requiredState: result.requiredState,
      }
    }
  }

  // 5. Idempotency — never send twice for the same (step, session, channel,
  //    stageEntry) on the automatic paths. `manual_rerun` is short-circuited
  //    above so it is not subject to this check. `debug` may still use
  //    `force` to bypass.
  //
  //    For raw-event triggers (flow_*, meeting_*, training_*, before_meeting)
  //    stageEntryId is null → behaves identically to the V1 lookup. For
  //    `stage_entered` triggers the lookup is scoped to one specific
  //    StageEntry, so a candidate re-entering the same stage later produces
  //    a fresh entry id and a new execution.
  const stageEntryId = ctx.stageEntryId ?? null
  const existing = await prisma.automationExecution.findFirst({
    where: { stepId: step.id, sessionId: session.id, channel, stageEntryId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  })
  if (existing && existing.status === 'sent') {
    const forceAllowed = force === true && executionMode === 'debug'
    if (!forceAllowed) {
      return {
        allowed: false,
        reason: 'skipped_duplicate',
        currentState: { priorExecutionId: existing.id, priorStatus: existing.status },
      }
    }
  }

  return { allowed: true }
}

// ─── Persistence helper ────────────────────────────────────────────────────

/**
 * Persist a skipped execution row. Called by dispatch/execute paths after
 * `canExecuteAutomationStep` returns `{allowed:false}`. Keeps the skip
 * decision auditable and queryable (e.g. analytics counting blocked sends
 * per rule) without bloating the logs.
 *
 * Upserts on (stepId, sessionId, channel) — if a previous attempt already
 * created the row (queued, then deemed ineligible at QStash callback), we
 * update it in place rather than crashing on the unique constraint.
 */
export async function recordSkip(opts: {
  ruleId: string
  stepId: string
  sessionId: string
  channel: 'email' | 'sms'
  executionMode: ExecutionMode
  actorUserId?: string | null
  result: Extract<GuardResult, { allowed: false }>
  session: Session
  /** Same shape as GuardCtx.stageEntryId — see that field's comment. */
  stageEntryId?: string | null
}): Promise<void> {
  const stageEntryId = opts.stageEntryId ?? null
  const data = {
    automationRuleId: opts.ruleId,
    stepId: opts.stepId,
    sessionId: opts.sessionId,
    channel: opts.channel,
    stageEntryId,
    status: opts.result.reason,
    skipReason: opts.result.reason,
    evaluatedStage: opts.session.pipelineStatus ?? null,
    evaluatedStatus: opts.session.status ?? null,
    expectedStage: typeof opts.result.requiredState?.pipelineStatus === 'string'
      ? (opts.result.requiredState.pipelineStatus as string)
      : null,
    executionMode: opts.executionMode,
    triggeredByUserId: opts.actorUserId ?? null,
    errorMessage: JSON.stringify({
      reason: opts.result.reason,
      currentState: opts.result.currentState,
      requiredState: opts.result.requiredState,
    }).slice(0, 1000),
  } as const

  const existing = await prisma.automationExecution.findFirst({
    where: { stepId: opts.stepId, sessionId: opts.sessionId, channel: opts.channel, stageEntryId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  })

  if (existing) {
    // Never downgrade a successful send into a skip — a 'sent' row stays
    // 'sent'. (This can happen when a stale QStash callback fires for a
    // step that was already manually re-sent.)
    if (existing.status === 'sent') return
    await prisma.automationExecution.update({
      where: { id: existing.id },
      data,
    })
    return
  }

  await prisma.automationExecution.create({ data })
}

// ─── Halt helpers ──────────────────────────────────────────────────────────

/**
 * Set the central kill-switch for a session and cancel its pending
 * automation rows in one call. Future automation attempts (including stale
 * QStash callbacks) hit the halt check at the top of the guard and skip.
 *
 * Idempotent: calling twice with the same reason is a no-op for the second
 * call; calling with a new reason overwrites the prior one.
 */
export async function haltSessionAutomations(opts: {
  sessionId: string
  reason: string
}): Promise<void> {
  await prisma.session.update({
    where: { id: opts.sessionId },
    data: {
      automationsHaltedAt: new Date(),
      automationsHaltedReason: opts.reason,
    },
  })
}

/**
 * Clear the kill-switch. Used by manual operator un-halts; the lifecycle
 * un-stall path also calls this when transitioning a session back to active.
 */
export async function resumeSessionAutomations(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      automationsHaltedAt: null,
      automationsHaltedReason: null,
    },
  })
}
