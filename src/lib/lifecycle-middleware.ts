/**
 * Lifecycle event middleware — every state transition fires its matching
 * automation event, regardless of which code path made the write.
 *
 * Background: before this module, each API endpoint that flipped a
 * lifecycle field (Session.finishedAt, CaptureResponse.status='processed',
 * TrainingEnrollment.completedAt, InterviewMeeting.actualEnd, …) was
 * independently responsible for calling the matching `fire*` helper from
 * `src/lib/automation.ts`. Forgetting that call was a silent bug: the
 * write succeeded, no event fired, no AutomationExecution row was created,
 * the kanban card stayed put. The Spotless Homes capture-finalize endpoint
 * is the canonical example — it landed audio rows in CaptureResponse for
 * weeks before anyone noticed `recording_ready` rules never fired.
 *
 * Now: emit events from Prisma `$use` based on the state change itself.
 * Endpoints can keep their explicit fire calls (the central guard at
 * `automation-guard.ts` de-dupes via `(stepId, sessionId, channel)`),
 * but they no longer have to remember. New endpoints inherit the
 * firing for free.
 *
 * Design notes:
 *   - Fire-and-forget: the middleware awaits the underlying write, then
 *     schedules the event dispatch with `void` so a slow LogHub or a
 *     missing rule can't latency the request.
 *   - Dynamic import for automation.ts to avoid the circular dep
 *     (automation.ts imports prisma; prisma.ts imports this; this would
 *     import automation.ts statically).
 *   - Action filter: handles `create` / `update` / `upsert`. `updateMany`
 *     is skipped — it doesn't surface a row id and the use cases for
 *     lifecycle fields in this codebase are always single-row updates.
 *   - State-change detection: a write that *sets* the tracked field is
 *     treated as a transition. Writes that don't include the field in
 *     `args.data` pass through. A no-op write (setting `finishedAt` to its
 *     existing value) re-fires; the central guard's idempotency keeps that
 *     from producing duplicate sends.
 *
 * Skip flag: server-side scripts (backfill, seed) that mass-update
 * lifecycle fields should set `process.env.HF_SKIP_LIFECYCLE_MIDDLEWARE='1'`
 * so they don't accidentally trigger thousands of automation runs against
 * historical rows.
 */
import type { Prisma, PrismaClient } from '@prisma/client'

type DataLike = Record<string, unknown> | undefined

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null
}

function dataFromAction(params: Prisma.MiddlewareParams): DataLike {
  if (params.action === 'update' || params.action === 'create') {
    return (params.args?.data ?? undefined) as DataLike
  }
  if (params.action === 'upsert') {
    // For upserts we treat both create and update branches as transitions.
    // The data is shape `{ create, update, where }`. We union the two so
    // the detection fires regardless of which branch ran. Slight
    // over-firing on the "already exists" branch is fine due to guard
    // idempotency.
    const args = params.args as { create?: DataLike; update?: DataLike } | undefined
    return { ...(args?.create ?? {}), ...(args?.update ?? {}) } as DataLike
  }
  return undefined
}

function whereId(params: Prisma.MiddlewareParams): string | null {
  const args = params.args as { where?: { id?: string } } | undefined
  if (typeof args?.where?.id === 'string') return args.where.id
  return null
}

function resultId(result: unknown): string | null {
  if (result && typeof result === 'object' && 'id' in (result as Record<string, unknown>)) {
    const id = (result as Record<string, unknown>).id
    if (typeof id === 'string') return id
  }
  return null
}

/**
 * Throwaway sessions created by /api/automations/[id]/test set source='test'
 * and synthesise lifecycle state (finishedAt, actualStart, …) to position the
 * session at the rule's trigger stage. The test endpoint dispatches its rule
 * explicitly via executeRule — letting this middleware also fire produces a
 * duplicate send (the executeStep guard only blocks on status='sent', so two
 * near-simultaneous paths both reach the actual send).
 */
async function isTestSession(sessionId: string): Promise<boolean> {
  try {
    const { prisma } = await import('./prisma')
    const row = await prisma.session.findUnique({ where: { id: sessionId }, select: { source: true } })
    return row?.source === 'test'
  } catch {
    return false
  }
}

/**
 * Attach the lifecycle middleware to a Prisma client. Call once at module
 * init from `src/lib/prisma.ts`. Idempotent — calling twice on the same
 * client is harmless (Prisma allows multiple $use registrations but our
 * effects are guarded by the central automation guard's unique index).
 */
export function attachLifecycleMiddleware(client: PrismaClient): void {
  if (process.env.HF_SKIP_LIFECYCLE_MIDDLEWARE === '1') return

  client.$use(async (params, next) => {
    const result = await next(params)

    // Tracked state transitions. Each handler is fire-and-forget; failures
    // never bubble back to the originating write.
    try {
      handle(params, result).catch((err) => {
        console.error('[lifecycle-middleware] handler error', { model: params.model, action: params.action, err })
      })
    } catch (err) {
      console.error('[lifecycle-middleware] sync detect error', { model: params.model, action: params.action, err })
    }

    return result
  })
}

async function handle(params: Prisma.MiddlewareParams, result: unknown): Promise<void> {
  if (params.action !== 'create' && params.action !== 'update' && params.action !== 'upsert') return
  const data = dataFromAction(params)
  if (!data) return

  const id = whereId(params) ?? resultId(result)

  // Lazy import to break the circular dep (automation.ts → prisma → this).
  const auto = await import('./automation')
  const { emitAutomationEvent, eventKeys } = await import('./automation-emit')
  const { prisma } = await import('./prisma')

  switch (params.model) {
    case 'Session': {
      // finishedAt transitioning to a value → flow_completed / flow_passed.
      // outcome may travel in the same update; prefer the in-flight value,
      // fall back to whatever the result row says.
      if (isSet((data as Record<string, unknown>).finishedAt)) {
        const sessionId = id ?? resultId(result)
        if (!sessionId) return
        // Test sessions (source='test', created by /api/automations/[id]/test)
        // are dispatched explicitly by the test endpoint via executeRule.
        // Letting the middleware also fire would produce a duplicate. With
        // AutomationEvent dedup this is now belt-and-suspenders — the
        // explicit dispatch in the test endpoint doesn't go through
        // emitAutomationEvent, so the constraint wouldn't catch it.
        if (await isTestSession(sessionId)) return
        const outcomeInData = (data as Record<string, unknown>).outcome
        const outcome =
          typeof outcomeInData === 'string'
            ? outcomeInData
            : ((result as Record<string, unknown> | null)?.outcome as string | undefined) ?? 'completed'
        const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { workspaceId: true } })
        if (!session) return
        const triggerType = outcome === 'passed' ? 'flow_passed' : 'flow_completed'
        const eventKey = triggerType === 'flow_passed' ? eventKeys.flowPassed(sessionId) : eventKeys.flowCompleted(sessionId)
        await emitAutomationEvent({
          workspaceId: session.workspaceId,
          sessionId,
          triggerType,
          eventKey,
          source: 'lifecycle',
          payload: { outcome },
          dispatch: () => auto.fireAutomations(sessionId, outcome, { executionMode: 'public_trigger' }),
        })
      }
      break
    }

    case 'CaptureResponse': {
      // status transitioning to 'processed' → recording_ready. Capture
      // flows live in CaptureResponse (separate from CandidateSubmission);
      // without this hook, only the explicit fire call inside
      // captures/finalize would emit, and any other code path that
      // processes a capture (admin re-process, cron sweep) would miss.
      if ((data as Record<string, unknown>).status === 'processed') {
        const captureId = id ?? resultId(result)
        if (!captureId) return
        const r = result as { sessionId?: string; workspaceId?: string } | null
        let sessionId = r?.sessionId
        let workspaceId = r?.workspaceId
        if (!sessionId || !workspaceId) {
          const row = await prisma.captureResponse.findUnique({ where: { id: captureId }, select: { sessionId: true, workspaceId: true } })
          sessionId = sessionId ?? row?.sessionId
          workspaceId = workspaceId ?? row?.workspaceId
        }
        if (!sessionId || !workspaceId) return
        if (await isTestSession(sessionId)) return
        await emitAutomationEvent({
          workspaceId,
          sessionId,
          triggerType: 'recording_ready',
          eventKey: eventKeys.recordingReadyCapture(captureId),
          source: 'lifecycle',
          payload: { captureResponseId: captureId },
          dispatch: () => auto.fireFlowRecordingReadyAutomations(sessionId!, { executionMode: 'public_trigger' }),
        })
      }
      break
    }

    case 'TrainingEnrollment': {
      // completedAt set → training_completed. Covers admin marking a
      // candidate complete, public training progress endpoint, future
      // bulk-complete flows.
      if (isSet((data as Record<string, unknown>).completedAt)) {
        const enrollmentId = id ?? resultId(result)
        if (!enrollmentId) return
        const r = result as { sessionId?: string; trainingId?: string } | null
        let sessionId = r?.sessionId
        let trainingId = r?.trainingId
        if (!sessionId || !trainingId) {
          const row = await prisma.trainingEnrollment.findUnique({
            where: { id: enrollmentId },
            select: { sessionId: true, trainingId: true },
          })
          sessionId = sessionId ?? row?.sessionId ?? undefined
          trainingId = trainingId ?? row?.trainingId ?? undefined
        }
        if (!sessionId) return
        if (await isTestSession(sessionId)) return
        const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { workspaceId: true } })
        if (!session) return
        await emitAutomationEvent({
          workspaceId: session.workspaceId,
          sessionId,
          triggerType: 'training_completed',
          eventKey: eventKeys.trainingCompleted(enrollmentId),
          source: 'lifecycle',
          payload: { trainingEnrollmentId: enrollmentId, trainingId: trainingId ?? null },
          dispatch: () => auto.fireTrainingCompletedAutomations(sessionId!, trainingId ?? undefined, { executionMode: 'public_trigger' }),
        })
      }
      break
    }

    case 'InterviewMeeting': {
      // actualStart / actualEnd set → meeting_started / meeting_ended.
      // Recording state transitions are handled by the Meet webhook
      // directly (it has the artifact context), so we don't double-fire
      // recording_ready here.
      const meetingId = id ?? resultId(result)
      if (!meetingId) return
      const r = result as { sessionId?: string; workspaceId?: string } | null
      let sessionId = r?.sessionId
      let workspaceId = r?.workspaceId
      if (!sessionId || !workspaceId) {
        const row = await prisma.interviewMeeting.findUnique({ where: { id: meetingId }, select: { sessionId: true, workspaceId: true } })
        sessionId = sessionId ?? row?.sessionId
        workspaceId = workspaceId ?? row?.workspaceId
      }
      if (!sessionId || !workspaceId) return
      if (await isTestSession(sessionId)) return
      if (isSet((data as Record<string, unknown>).actualEnd)) {
        await emitAutomationEvent({
          workspaceId,
          sessionId,
          triggerType: 'meeting_ended',
          eventKey: eventKeys.meetingEnded(meetingId),
          source: 'lifecycle',
          payload: { interviewMeetingId: meetingId },
          dispatch: () => auto.fireMeetingLifecycleAutomations(sessionId!, 'meeting_ended'),
        })
      } else if (isSet((data as Record<string, unknown>).actualStart)) {
        await emitAutomationEvent({
          workspaceId,
          sessionId,
          triggerType: 'meeting_started',
          eventKey: eventKeys.meetingStarted(meetingId),
          source: 'lifecycle',
          payload: { interviewMeetingId: meetingId },
          dispatch: () => auto.fireMeetingLifecycleAutomations(sessionId!, 'meeting_started'),
        })
      }
      break
    }

    default:
      return
  }
}
