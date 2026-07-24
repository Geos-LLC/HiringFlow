/**
 * Automation event emission — the single entry point every code path uses
 * to produce automation work.
 *
 * Why this exists
 * ---------------
 * Pre-existing pattern: each emitter (lifecycle middleware, public
 * endpoints, webhooks, cron) called `fireAutomations` / `fireMeetingLifecycleAutomations`
 * / `fireTrainingCompletedAutomations` / etc. directly. Multiple paths often
 * fired the same business event microseconds apart (e.g. submit/route.ts +
 * lifecycle middleware both fired `flow_completed` for one Session update).
 * The central guard at `src/lib/automation-guard.ts` only blocked on
 * `AutomationExecution.status='sent'` — both racing paths inserted
 * `status='pending'` rows that bypassed each other's idempotency check,
 * resulting in duplicate sends. The DB-level unique constraint at
 * `(stepId, sessionId, channel, stageEntryId)` did not save us because raw-
 * event triggers (`flow_completed`, `meeting_*`, etc.) all have
 * `stageEntryId IS NULL`, and Postgres treats NULL as distinct under unique
 * constraints.
 *
 * The fix is a separate `AutomationEvent` table with a *non-nullable*
 * unique key `(workspaceId, eventKey)`. Every emitter writes there first.
 * The DB serialises the two racing inserts → exactly one succeeds → only
 * that path runs dispatch. No reliance on application-level race detection.
 *
 * Contract
 * --------
 * - `emitAutomationEvent` accepts a deterministic `eventKey` computed by
 *   the caller from the business event payload. The key MUST NOT contain
 *   nullable identifiers; conventions live in the schema comment for
 *   `AutomationEvent`.
 * - The wrapper attempts the insert. On success it runs the supplied
 *   `dispatch` callback (the actual `fireAutomations` / `fireMeetingLifecycleAutomations`
 *   / etc. work). On unique-constraint conflict it returns `accepted=false`
 *   and skips dispatch — a sibling caller already won.
 * - Dispatch is awaited but its result does not affect the insert: an
 *   event that successfully wrote but failed mid-dispatch leaves
 *   `dispatchedAt=null`. The reconciler (see `findOrphanAutomationEvents`)
 *   re-runs dispatch for those after a grace window via
 *   `redispatchAcceptedEvent`. Re-runs do NOT touch the event row's
 *   identity, so a third emitter arriving meanwhile still sees the
 *   constraint and skips.
 *
 * What this does NOT replace
 * --------------------------
 * The existing `AutomationExecution` per-step idempotency (status='sent'
 * + the (stepId, sessionId, channel, stageEntryId) unique constraint)
 * stays in place. AutomationEvent guards the event boundary; the per-step
 * guard handles delayed callbacks (where the QStash callback re-enters
 * `executeStep` minutes later) and chained sends from `maybeFireChainedRules`.
 * Both layers are necessary.
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma'

// One source label per category of emitter. Stored verbatim on
// `AutomationEvent.source` for telemetry — answers "which path won the
// race?" without re-deriving from logs. Keep these literal so a typo
// surfaces at compile time, not at runtime triage.
export type EmitSource =
  | 'lifecycle'        // Prisma $use middleware (state-change-driven)
  | 'webhook'          // External HTTP webhook handler
  | 'cron'             // /api/cron/* sweepers
  | 'public_endpoint'  // /api/public/* called by candidates
  | 'manual'           // Recruiter-triggered (run-stage-automations, debug)
  | 'internal'         // Internal service code (book-interview, training-access)

export interface EmitOptions<T> {
  /**
   * Required scope. The unique constraint is (workspaceId, eventKey) so
   * the same eventKey in two different workspaces does not collide.
   */
  workspaceId: string
  /** Session scope (when the event has one). Indexed for reconciler scans. */
  sessionId?: string | null
  /** The business event name — matches AutomationRule.triggerType. */
  triggerType: string
  /**
   * Deterministic key derived from the event payload. Must not contain
   * nullable identifiers. See `AutomationEvent` schema comment for the
   * canonical conventions per trigger type.
   */
  eventKey: string
  source: EmitSource
  /**
   * Optional structured context preserved on the event row. Useful for
   * triage ("what did the emitter think it was firing?") and for the
   * reconciler when it re-runs dispatch and needs the original payload
   * (e.g. `trainingId` for `training_completed`, `meeting_no_show` etc.).
   */
  payload?: Record<string, unknown>
  /**
   * The actual automation dispatch work. Only invoked when the event row
   * was newly inserted; skipped on dedup. Receives the persisted
   * AutomationEvent so callers can stamp it onto downstream rows if they
   * want (current consumers don't, but the door is open).
   */
  dispatch: (eventRow: { id: string }) => Promise<T>
}

export interface EmitResult<T> {
  accepted: boolean
  reason?: 'duplicate'
  /** The id of the AutomationEvent row, whether freshly inserted or matched. */
  eventId?: string
  /**
   * The return value of the `dispatch` callback when accepted=true.
   * Undefined when the event was deduped or when dispatch failed (the
   * error is logged and re-thrown).
   */
  dispatchResult?: T
}

const DUPLICATE_KEY_CODE = 'P2002'

/**
 * Insert one AutomationEvent and, if the insert was the winner of any
 * race, run dispatch. The dispatch callback runs OUTSIDE the insert
 * transaction so a long-running dispatch can't hold a row lock.
 *
 * Failure semantics:
 *  - insert fails with P2002 → return accepted=false; do NOT throw.
 *    Caller treats this as "the event is being handled by a sibling
 *    emitter, my work here is done". No log line as error — info-level
 *    dedup is normal operational traffic.
 *  - insert fails with anything else → propagate (DB unreachable etc.).
 *  - insert succeeds, dispatch throws → record `dispatchError` on the
 *    event row and re-throw. The event row remains for reconciler retry;
 *    callers may still log/swallow as they prefer at their layer.
 *  - insert succeeds, dispatch resolves → stamp `dispatchedAt` and return
 *    accepted=true.
 */
export async function emitAutomationEvent<T>(opts: EmitOptions<T>): Promise<EmitResult<T>> {
  let row: { id: string }
  try {
    row = await prisma.automationEvent.create({
      data: {
        workspaceId: opts.workspaceId,
        sessionId: opts.sessionId ?? null,
        triggerType: opts.triggerType,
        eventKey: opts.eventKey,
        source: opts.source,
        payload: (opts.payload ?? null) as Prisma.InputJsonValue | undefined,
      },
      select: { id: true },
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === DUPLICATE_KEY_CODE) {
      // Resolve the winning row so callers / telemetry can link the
      // dedup'd attempt back to the canonical event. Single indexed
      // lookup — cheap.
      const existing = await prisma.automationEvent.findUnique({
        where: { workspaceId_eventKey: { workspaceId: opts.workspaceId, eventKey: opts.eventKey } },
        select: { id: true },
      })
      console.log(
        `[automation-emit] deduped event=${opts.eventKey} workspace=${opts.workspaceId} source=${opts.source} existingId=${existing?.id ?? '?'}`
      )
      return { accepted: false, reason: 'duplicate', eventId: existing?.id }
    }
    throw err
  }

  try {
    const dispatchResult = await opts.dispatch(row)
    // Mark dispatched on success so the reconciler can distinguish
    // "in-flight" from "definitely fanned out". An updateMany keeps this
    // best-effort — if the row was deleted between insert and update
    // (cascade from workspace delete, etc.), we don't want the failure
    // to bubble back into the dispatcher's success path.
    await prisma.automationEvent
      .update({ where: { id: row.id }, data: { dispatchedAt: new Date() } })
      .catch((err) => console.error('[automation-emit] failed to stamp dispatchedAt', { id: row.id, err }))
    return { accepted: true, eventId: row.id, dispatchResult }
  } catch (dispatchErr) {
    const message = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)
    await prisma.automationEvent
      .update({ where: { id: row.id }, data: { dispatchError: message.slice(0, 1000) } })
      .catch((err) => console.error('[automation-emit] failed to stamp dispatchError', { id: row.id, err }))
    throw dispatchErr
  }
}

/**
 * Reconciler entry point. Finds AutomationEvent rows that landed but
 * never finished dispatching, within the recovery window. These are
 * events where the wrapper accepted the insert but `dispatch` either
 * crashed mid-flight (Vercel function killed, exception, OOM) or hasn't
 * completed yet.
 *
 * Excludes rows whose `dispatchError` is already set — those failed
 * deterministically once; the cron should not retry forever. A human
 * triages those out of band.
 *
 * The reconciler's caller still has to provide a fresh dispatch callback
 * (we don't serialise the original closure). Convention: re-derive the
 * dispatch from `triggerType` + `payload` + `sessionId`. See
 * `src/app/api/cron/reconcile-automations/route.ts` for the canonical
 * fanout.
 */
export interface OrphanEvent {
  id: string
  workspaceId: string
  sessionId: string | null
  triggerType: string
  eventKey: string
  payload: Record<string, unknown> | null
  acceptedAt: Date
}

export async function findOrphanAutomationEvents(opts: {
  /** Don't redispatch anything younger than this — in-flight dispatch needs a grace window. */
  minAgeMs: number
  /** Don't look back further than this — old failures stay buried. */
  maxAgeMs: number
  /** Soft cap on results returned per call so the cron doesn't blow up. */
  take?: number
}): Promise<OrphanEvent[]> {
  const now = Date.now()
  const rows = await prisma.automationEvent.findMany({
    where: {
      acceptedAt: { gte: new Date(now - opts.maxAgeMs), lte: new Date(now - opts.minAgeMs) },
      dispatchedAt: null,
      dispatchError: null,
    },
    select: {
      id: true,
      workspaceId: true,
      sessionId: true,
      triggerType: true,
      eventKey: true,
      payload: true,
      acceptedAt: true,
    },
    orderBy: { acceptedAt: 'asc' },
    take: opts.take ?? 100,
  })
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    sessionId: r.sessionId,
    triggerType: r.triggerType,
    eventKey: r.eventKey,
    payload: (r.payload ?? null) as Record<string, unknown> | null,
    acceptedAt: r.acceptedAt,
  }))
}

/**
 * Re-run dispatch for an already-accepted AutomationEvent. Used by the
 * reconciler when a previous dispatch attempt was killed mid-flight.
 *
 * Idempotency: the dispatch callback itself converges through the central
 * automation guard (status='sent' / unique constraint on AutomationExecution).
 * A successful resend of a partial dispatch does not produce duplicate
 * AutomationExecution rows for steps that already completed; it only
 * fills in the ones that never landed.
 */
export async function redispatchAcceptedEvent<T>(opts: {
  eventId: string
  dispatch: (eventRow: { id: string }) => Promise<T>
}): Promise<T> {
  try {
    const result = await opts.dispatch({ id: opts.eventId })
    await prisma.automationEvent
      .update({ where: { id: opts.eventId }, data: { dispatchedAt: new Date(), dispatchError: null } })
      .catch((err) => console.error('[automation-emit] redispatch dispatchedAt update failed', { id: opts.eventId, err }))
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.automationEvent
      .update({ where: { id: opts.eventId }, data: { dispatchError: message.slice(0, 1000) } })
      .catch((updateErr) =>
        console.error('[automation-emit] redispatch dispatchError update failed', { id: opts.eventId, updateErr })
      )
    throw err
  }
}

// ─── eventKey helpers ──────────────────────────────────────────────────────
// Centralised so emitters can't drift on key shape (a single misspelling
// breaks dedup across that whole trigger type). Lifecycle middleware,
// webhooks, cron reconciler, and internal callers all use these.

export const eventKeys = {
  flowStarted: (sessionId: string) => `flow_started:${sessionId}`,
  flowCompleted: (sessionId: string) => `flow_completed:${sessionId}`,
  flowPassed: (sessionId: string) => `flow_passed:${sessionId}`,
  recordingReadyCapture: (captureResponseId: string) =>
    `recording_ready:capture:${captureResponseId}`,
  recordingReadyMeet: (interviewMeetingId: string) =>
    `recording_ready:meet:${interviewMeetingId}`,
  recordingReadyFlow: (sessionId: string, candidateSubmissionId: string) =>
    `recording_ready:flow:${sessionId}:${candidateSubmissionId}`,
  trainingStarted: (trainingEnrollmentId: string) =>
    `training_started:${trainingEnrollmentId}`,
  trainingCompleted: (trainingEnrollmentId: string) =>
    `training_completed:${trainingEnrollmentId}`,
  meetingScheduled: (interviewMeetingId: string) =>
    `meeting_scheduled:${interviewMeetingId}`,
  meetingRescheduled: (interviewMeetingId: string, newScheduledStartIso: string) =>
    `meeting_rescheduled:${interviewMeetingId}:${newScheduledStartIso}`,
  meetingStarted: (interviewMeetingId: string) =>
    `meeting_started:${interviewMeetingId}`,
  meetingEnded: (interviewMeetingId: string) =>
    `meeting_ended:${interviewMeetingId}`,
  meetingNoShow: (interviewMeetingId: string) =>
    `meeting_no_show:${interviewMeetingId}`,
  transcriptReadyMeet: (interviewMeetingId: string) =>
    `transcript_ready:meet:${interviewMeetingId}`,
  stageEntered: (stageEntryId: string) => `stage_entered:${stageEntryId}`,
  backgroundCheck: (backgroundCheckId: string, outcome: string) =>
    `background_check:${backgroundCheckId}:${outcome}`,
} as const
