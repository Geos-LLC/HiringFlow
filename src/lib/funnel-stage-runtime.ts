/**
 * Server-side glue between system events and the workspace's funnel stages.
 *
 * Each event site (flow passed, training started/completed, meeting scheduled,
 * etc.) calls applyStageTrigger() with the session id, the event name, and
 * any relevant target ids. We look up the workspace's configured stages and,
 * if any match, write that stage's id into Session.pipelineStatus —
 * overwriting whatever was there (per "automatic always wins").
 *
 * If no stage matches, we fall back to the caller-provided legacy status
 * string so existing display logic keeps working until the workspace
 * configures triggers.
 */

import { prisma } from './prisma'
import { setPipelineStatus } from './pipeline-status'
import {
  findStageForEvent,
  mapLegacyStatusToStageId,
  type StageTriggerEvent,
  type FunnelStage,
} from './funnel-stages'
import { resolvePipelineForSession, stagesFor } from './pipelines'

// When a "completion" event fires and no stage explicitly claims it, we look
// at the candidate's CURRENT stage: if that stage was entered via the paired
// "start" event for the same target (same trainingId / same meeting), we treat
// the current stage as done and advance to the next stage in pipeline order.
//
// This matches the recruiter's mental model: a stage represents a step the
// candidate is performing; completing the step moves the card to the next
// column. Workspaces no longer have to declare a `*_completed` trigger on the
// "next" stage just to get out of the current one.
const COMPLETION_PAIRS: Partial<Record<StageTriggerEvent, StageTriggerEvent[]>> = {
  training_completed: ['training_started'],
  meeting_ended: ['meeting_scheduled', 'meeting_confirmed', 'meeting_started'],
  background_check_passed: [],
}

// Events that mean the candidate is actively progressing — receiving any of
// these should pull a previously-stalled candidate back into the active pool.
// We only flip `status` when it was `stalled` so a manually-set `nurture`,
// `lost`, or `hired` candidate is NOT silently reactivated by a late-firing
// event (e.g. an old training_completed webhook arriving after a recruiter
// already declared the candidate hired_elsewhere).
//
// `meeting_no_show` and `meeting_cancelled` are deliberately excluded — those
// are not progress.
const FORWARD_PROGRESS_EVENTS = new Set<StageTriggerEvent>([
  'flow_passed',
  'flow_completed',
  'training_started',
  'training_completed',
  'meeting_scheduled',
  'meeting_confirmed',
  'meeting_started',
  'meeting_ended',
  'background_check_passed',
])

export async function applyStageTrigger(opts: {
  sessionId: string
  workspaceId: string
  event: StageTriggerEvent
  flowId?: string
  trainingId?: string
  // Status to write if no auto-rule matches — preserves the pre-existing
  // hardcoded behaviour for unconfigured workspaces.
  legacyStatus?: string
  // Optional V2 context fields. Pulled into PipelineTransitionRule.targetId
  // matching when V2 is enabled for the session. Ignored by V1.
  schedulingConfigId?: string
  sourceEventId?: string
}): Promise<string | null> {
  // ── V2 dispatch ───────────────────────────────────────────────────────
  // When the env flag is on AND the session's workspace/pipeline has opted
  // in, route to the rule-driven engine instead of V1's triple-path
  // (configured trigger → completion-pair auto-advance → legacy fallback).
  //
  // V2 is intentionally additive — V1 callers passing `legacyStatus` get
  // the legacy fallback when their workspace hasn't opted in. Once a
  // workspace flips its flag, the legacy string is silently dropped on
  // the floor (that's the whole point — no more hidden "scheduled" writes).
  const { isV2EnabledForSession, applyTransitionV2 } = await import('./pipeline-transitions')
  if (await isV2EnabledForSession(opts.sessionId)) {
    const result = await applyTransitionV2({
      sessionId: opts.sessionId,
      eventType: opts.event,
      context: {
        flowId: opts.flowId,
        trainingId: opts.trainingId,
        schedulingConfigId: opts.schedulingConfigId,
        sourceEventId: opts.sourceEventId,
      },
    })

    // Only a real transition triggers stage_entered automations and queue
    // cleanup. no_rule_matched / blocked_backward / same_stage are all
    // observed-but-noop outcomes; they MUST NOT fall back to V1 (that's
    // exactly the silent-legacy-write bug V2 exists to kill) and they
    // MUST NOT fan out automations.
    if (result.kind === 'transitioned') {
      const { cancelStageMismatchedQueued, fireStageEnteredAutomations } = await import('./automation')
      // Pipeline lookup so the stage_entered dispatcher knows which
      // pipeline scope to filter rules by.
      const pipeline = await (async () => {
        const { resolvePipelineForSession } = await import('./pipelines')
        return resolvePipelineForSession({
          sessionId: opts.sessionId,
          workspaceId: opts.workspaceId,
        })
      })()
      await cancelStageMismatchedQueued(opts.sessionId, result.toStageId).catch((err) => {
        console.error('[funnel-stage-runtime] V2 cancelStageMismatchedQueued failed:', err)
      })
      if (pipeline) {
        await fireStageEnteredAutomations({
          stageEntryId: result.stageEntryId,
          sessionId: opts.sessionId,
          stageId: result.toStageId,
          pipelineId: pipeline.id,
          workspaceId: opts.workspaceId,
        }).catch((err) => {
          console.error('[funnel-stage-runtime] V2 fireStageEnteredAutomations failed:', err)
        })
      }
      return result.toStageId
    }

    // All other V2 outcomes return null — stage was NOT changed.
    // (Audit row was already written inside applyTransitionV2 for
    // no_rule_matched and blocked_backward.)
    return null
  }

  // ── V1 path (unchanged) ───────────────────────────────────────────────
  // Resolve which pipeline applies to this candidate. Stages now live on
  // Pipeline rows — the session's flow points at one, falling back to the
  // workspace default. Workspaces with no Pipeline rows yet get one created
  // on the fly from their legacy Workspace.settings.funnelStages.
  const pipeline = await resolvePipelineForSession({
    sessionId: opts.sessionId,
    workspaceId: opts.workspaceId,
  })
  const stages = pipeline ? stagesFor(pipeline) : []
  const stage = findStageForEvent(stages, opts.event, { flowId: opts.flowId, trainingId: opts.trainingId })

  // Best-effort: if this event represents forward progress, reactivate a
  // stalled candidate. Runs whether or not a stage trigger matched (so even
  // workspaces that haven't wired triggers benefit). Scoped to status='stalled'
  // so we never overwrite a recruiter's deliberate 'nurture' / 'lost' / 'hired'.
  //
  // Critically: clear `automationsHaltedAt` / `automationsHaltedReason` too.
  // The cron stalls via `stalledPayload()` which stamps the halt switch
  // alongside `stalledAt`; without clearing both on reactivation, downstream
  // automations on the same forward-progress event hit the guard and skip
  // with `skipped_cancelled` (Elena Bobb, 2026-05-13: training_completed
  // reactivated her but the three training_completed rules were silently
  // dropped). Mirrors `statusTransitionPatch('active')` in candidate-status.ts
  // which handles the manual-reactivate path.
  const reactivatePatch: Record<string, unknown> | null = FORWARD_PROGRESS_EVENTS.has(opts.event)
    ? {
        status: 'active',
        stalledAt: null,
        dispositionReason: null,
        automationsHaltedAt: null,
        automationsHaltedReason: null,
      }
    : null

  // Pull the current pipelineStatus once so both branches share the same
  // furthest-wins guard. We never move a candidate backwards through the
  // funnel based on a system event, regardless of whether the destination
  // came from a configured stage trigger or the legacy fallback.
  const session = await prisma.session.findUnique({
    where: { id: opts.sessionId },
    select: { pipelineStatus: true },
  })
  const currentOrder = currentStageOrder(stages, session?.pipelineStatus ?? null)

  // No matching stage configured — before falling back to legacy, check if
  // this event is the natural completion for the candidate's CURRENT stage.
  // If so, advance to the next stage in pipeline order.
  if (!stage) {
    const advanced = await maybeAutoAdvanceOnCompletion({
      event: opts.event,
      stages,
      currentOrder,
      flowId: opts.flowId,
      trainingId: opts.trainingId,
      sessionId: opts.sessionId,
    })
    if (advanced) {
      if (reactivatePatch) {
        await prisma.session.updateMany({
          where: { id: opts.sessionId, status: 'stalled' },
          data: reactivatePatch,
        }).catch(() => {})
      }
      const { cancelStageMismatchedQueued } = await import('./automation')
      await cancelStageMismatchedQueued(opts.sessionId, advanced).catch((err) => {
        console.error('[funnel-stage-runtime] cancelStageMismatchedQueued (auto-advance) failed:', err)
      })
      return advanced
    }

    if (reactivatePatch) {
      await prisma.session.updateMany({
        where: { id: opts.sessionId, status: 'stalled' },
        data: reactivatePatch,
      }).catch(() => {})
    }
    if (!opts.legacyStatus) return null
    // Apply the same furthest-wins guard to the legacy path. Without this, a
    // late `meeting_no_show` could flip a candidate currently sitting in
    // `hired` straight to `rejected` because the legacy path bypassed the
    // order check entirely.
    const legacyOrder = currentStageOrder(stages, opts.legacyStatus)
    if (currentOrder !== null && legacyOrder !== null && legacyOrder < currentOrder) {
      return null
    }
    await setPipelineStatus({
      sessionId: opts.sessionId,
      toStatus: opts.legacyStatus,
      source: `auto:${opts.event}`,
      metadata: {
        legacyFallback: true,
        flowId: opts.flowId,
        trainingId: opts.trainingId,
      },
    }).catch(() => {})
    return opts.legacyStatus
  }

  // Furthest-stage-wins guard: don't move a candidate backwards through the
  // funnel based on a later-firing event for an earlier stage. Only apply the
  // trigger if the matched stage is at or after the candidate's current
  // stage in the funnel order.
  if (currentOrder !== null && stage.order < currentOrder) {
    return null
  }

  await setPipelineStatus({
    sessionId: opts.sessionId,
    toStatus: stage.id,
    source: `auto:${opts.event}`,
    metadata: {
      flowId: opts.flowId,
      trainingId: opts.trainingId,
    },
  }).catch(() => {})

  if (reactivatePatch) {
    await prisma.session.updateMany({
      where: { id: opts.sessionId, status: 'stalled' },
      data: reactivatePatch,
    }).catch(() => {})
  }

  // The session is now in `stage.id`. Sweep any queued automation executions
  // whose rule is pinned to a different stage — the guard would skip them at
  // dispatch anyway, this just stops them from sitting in `queued` until they
  // expire. Dynamic import to avoid a circular dep (automation.ts imports
  // funnel-stage-runtime via applyStageTrigger).
  const { cancelStageMismatchedQueued } = await import('./automation')
  await cancelStageMismatchedQueued(opts.sessionId, stage.id).catch((err) => {
    console.error('[funnel-stage-runtime] cancelStageMismatchedQueued failed:', err)
  })

  return stage.id
}

// If the firing event is a completion event paired with the candidate's
// current stage's start trigger, advance them to the next stage in order.
// Returns the new stage id on success, null otherwise.
async function maybeAutoAdvanceOnCompletion(opts: {
  event: StageTriggerEvent
  stages: FunnelStage[]
  currentOrder: number | null
  flowId?: string
  trainingId?: string
  sessionId: string
}): Promise<string | null> {
  const startEvents = COMPLETION_PAIRS[opts.event]
  if (!startEvents || startEvents.length === 0) return null
  if (opts.currentOrder === null) return null

  const currentStage = opts.stages.find((s) => s.order === opts.currentOrder)
  if (!currentStage?.triggers?.length) return null

  // The current stage must have an entry trigger that pairs with this
  // completion event AND targets the same entity (or is a wildcard).
  const target = opts.event.startsWith('training_') ? opts.trainingId
    : opts.event.startsWith('meeting_') ? undefined
    : undefined
  const pair = currentStage.triggers.find((t) => {
    if (!startEvents.includes(t.event)) return false
    if (t.targetId && target && t.targetId !== target) return false
    return true
  })
  if (!pair) return null

  // Pick the next stage in funnel order (skipping any terminal stages would
  // be over-engineering — recruiters lay out stages in the order they want
  // candidates to flow through).
  const nextStage = opts.stages
    .filter((s) => s.order > opts.currentOrder!)
    .sort((a, b) => a.order - b.order)[0]
  if (!nextStage) return null

  await setPipelineStatus({
    sessionId: opts.sessionId,
    toStatus: nextStage.id,
    source: `auto-advance:${opts.event}`,
    metadata: {
      from: currentStage.id,
      via: 'completion-pair',
      pairedStart: pair.event,
      flowId: opts.flowId,
      trainingId: opts.trainingId,
    },
  }).catch(() => {})
  return nextStage.id
}

function currentStageOrder(stages: FunnelStage[], pipelineStatus: string | null): number | null {
  if (!pipelineStatus) return null
  const direct = stages.find((s) => s.id === pipelineStatus)
  if (direct) return direct.order
  // Resolve legacy status strings (e.g. 'rejected', 'training_completed') to
  // their default-stage equivalent so callers passing a legacy value still
  // get a meaningful order back. Returns null only when the value matches
  // neither a configured stage nor a known legacy status.
  const mapped = mapLegacyStatusToStageId(pipelineStatus)
  const fallback = stages.find((s) => s.id === mapped)
  return fallback ? fallback.order : null
}
