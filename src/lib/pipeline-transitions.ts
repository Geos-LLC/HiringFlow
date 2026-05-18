/**
 * Pipeline Transitions v2 — rule-driven stage advancement.
 *
 * Replaces V1's hardcoded triple-path advancement (configured stage trigger
 * → completion-pair auto-advance → legacy fallback) with a single mechanism:
 * a row in PipelineTransitionRule matches an event, or nothing happens.
 *
 * V2 is opt-in per workspace OR per pipeline. The env flag
 * PIPELINE_TRANSITIONS_V2 gates the entire engine; per-workspace
 * (`Workspace.pipelineTransitionsV2Enabled`) and per-pipeline
 * (`Pipeline.transitionsV2Enabled`) flags gate individual adoption. A
 * workspace that never opts in continues to use applyStageTrigger's V1 path
 * unchanged.
 *
 * Entry points:
 *   - isV2EnabledForSession()  — boolean gate, used by applyStageTrigger to
 *     pick V1 vs V2.
 *   - resolveTransition()      — pure read; returns the winning rule or null.
 *   - applyTransitionV2()      — full apply: rule lookup → stage write →
 *     StageEntry row → audit. Caller still owns automation dispatch (so
 *     tests can probe transitions independently of sends).
 */

import { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import {
  getOrCreateDefaultPipeline,
  resolvePipelineForFlow,
  resolvePipelineForSession,
  stagesFor,
} from './pipelines'
import { setPipelineStatus } from './pipeline-status'
import type { StageTriggerEvent, FunnelStage } from './funnel-stages'

// ─── Feature flag ──────────────────────────────────────────────────────────

// Same forward-progress set V1 uses to clear `stalled`. Duplicated rather
// than imported so the V2 resolver has no back-dependency on
// funnel-stage-runtime (which will dispatch into here under V2).
const V2_FORWARD_PROGRESS_EVENTS = new Set<StageTriggerEvent>([
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

/**
 * V2 is enabled for a session when the env flag is on AND either the
 * workspace or the resolved pipeline has opted in. Either flag may be
 * flipped independently — workspaces migrate whole-org or role-by-role.
 *
 * Returns false (V1) for any of: env flag off, session missing, workspace
 * + pipeline both off.
 */
export async function isV2EnabledForSession(sessionId: string): Promise<boolean> {
  if (process.env.PIPELINE_TRANSITIONS_V2 !== 'true') return false
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      workspace: { select: { pipelineTransitionsV2Enabled: true } },
      flow: { select: { pipeline: { select: { transitionsV2Enabled: true } } } },
    },
  })
  if (!session) return false
  if (session.workspace.pipelineTransitionsV2Enabled) return true
  if (session.flow?.pipeline?.transitionsV2Enabled) return true
  return false
}

/**
 * Create-time twin of `isV2EnabledForSession`. The session doesn't exist
 * yet, so we look up the workspace flag directly and (when a flow is
 * supplied) the flow's pipeline flag. Returns false on any resolution
 * failure — the create-time path defaults to V1 so a half-configured V2
 * workspace cannot brick public booking.
 */
export async function isV2EnabledForCreate(opts: {
  workspaceId: string
  flowId?: string
}): Promise<boolean> {
  if (process.env.PIPELINE_TRANSITIONS_V2 !== 'true') return false
  const ws = await prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: { pipelineTransitionsV2Enabled: true },
  })
  if (ws?.pipelineTransitionsV2Enabled) return true
  if (!opts.flowId) return false
  const flow = await prisma.flow.findUnique({
    where: { id: opts.flowId },
    select: { pipeline: { select: { transitionsV2Enabled: true } } },
  })
  return flow?.pipeline?.transitionsV2Enabled ?? false
}

/**
 * Source of truth for "what `pipelineStatus` should a new Session row be
 * created with?". Called from every `prisma.session.create` site that
 * previously hardcoded a legacy string like `'training_completed'`.
 *
 * V1 path (workspace/pipeline not on V2): returns `opts.legacyStatus`
 * unchanged — byte-identical behavior to the pre-V2 hardcoded write.
 *
 * V2 path: returns the resolved pipeline's first stage id (lowest
 * `order`). Falls back to `opts.legacyStatus` if pipeline resolution or
 * stage normalization fails, because the public booking path absolutely
 * cannot 500 on session create.
 */
export async function getInitialPipelineStatusForCreate(opts: {
  workspaceId: string
  flowId?: string
  legacyStatus?: string | null
}): Promise<string | null> {
  const v2 = await isV2EnabledForCreate({ workspaceId: opts.workspaceId, flowId: opts.flowId })
  if (!v2) return opts.legacyStatus ?? null

  try {
    const pipeline = opts.flowId
      ? await resolvePipelineForFlow({ flowId: opts.flowId, workspaceId: opts.workspaceId })
      : await getOrCreateDefaultPipeline(opts.workspaceId)
    const stages = stagesFor(pipeline)
    const first = stages.length > 0 ? stages[0].id : null
    return first ?? opts.legacyStatus ?? null
  } catch (err) {
    console.error('[pipeline-transitions] getInitialPipelineStatusForCreate fallback to legacy:', err)
    return opts.legacyStatus ?? null
  }
}

// ─── Rule resolution ───────────────────────────────────────────────────────

export type TransitionContext = {
  flowId?: string
  trainingId?: string
  schedulingConfigId?: string
  // Free-form pointer to the originating event row for audit deep-link
  // (SchedulingEvent.id, CandidateSubmission.id, InterviewMeeting.id, etc.).
  sourceEventId?: string
}

export type ResolvedTransition = {
  ruleId: string
  toStageId: string
  fromStageId: string | null
  targetId: string | null
  allowBackward: boolean
  priority: number
}

/**
 * Pure read: find the highest-priority enabled rule for (pipeline,
 * eventType) that matches the session's current stage and the event's
 * target id. Returns null if none match.
 *
 * Tie-break order:
 *   1. Higher `priority` wins.
 *   2. More-specific rule wins (non-null fromStageId beats null; non-null
 *      targetId beats null — sum of two specificity points).
 *   3. Older `createdAt` wins (deterministic for stable ordering).
 */
export async function resolveTransition(opts: {
  sessionId: string
  eventType: StageTriggerEvent
  context: TransitionContext
}): Promise<ResolvedTransition | null> {
  const session = await prisma.session.findUnique({
    where: { id: opts.sessionId },
    select: { id: true, workspaceId: true, pipelineStatus: true },
  })
  if (!session) return null

  const pipeline = await resolvePipelineForSession({
    sessionId: session.id,
    workspaceId: session.workspaceId,
  })
  if (!pipeline) return null

  const target = pickTargetId(opts.eventType, opts.context)

  const rules = await prisma.pipelineTransitionRule.findMany({
    where: {
      pipelineId: pipeline.id,
      eventType: opts.eventType,
      enabled: true,
    },
  })

  const candidates = rules.filter((r) => {
    if (r.fromStageId !== null && r.fromStageId !== session.pipelineStatus) return false
    if (r.targetId !== null && r.targetId !== target) return false
    return true
  })

  if (candidates.length === 0) return null

  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    const specA = (a.fromStageId ? 1 : 0) + (a.targetId ? 1 : 0)
    const specB = (b.fromStageId ? 1 : 0) + (b.targetId ? 1 : 0)
    if (specB !== specA) return specB - specA
    return a.createdAt.getTime() - b.createdAt.getTime()
  })

  const winner = candidates[0]
  return {
    ruleId: winner.id,
    toStageId: winner.toStageId,
    fromStageId: winner.fromStageId,
    targetId: winner.targetId,
    allowBackward: winner.allowBackward,
    priority: winner.priority,
  }
}

// Map an event family onto the context field that supplies its target id.
// Used to narrow rule matching to "this specific Flow / Training / Config".
function pickTargetId(eventType: StageTriggerEvent, ctx: TransitionContext): string | undefined {
  if (eventType.startsWith('flow_')) return ctx.flowId
  if (eventType.startsWith('training_')) return ctx.trainingId
  if (
    eventType.startsWith('meeting_') ||
    eventType === 'recording_ready' ||
    eventType === 'transcript_ready'
  ) {
    return ctx.schedulingConfigId
  }
  return undefined
}

// ─── Application ───────────────────────────────────────────────────────────

export type ApplyTransitionResult =
  | { kind: 'transitioned'; stageEntryId: string; toStageId: string; fromStageId: string | null; ruleId: string }
  | { kind: 'no_rule_matched'; eventType: StageTriggerEvent }
  | { kind: 'blocked_backward'; ruleId: string; toStageId: string; currentStageId: string }
  | { kind: 'same_stage'; stageId: string; ruleId: string }
  | { kind: 'no_session' }
  | { kind: 'no_pipeline' }

/**
 * V2 entry point: resolve, write Session.pipelineStatus, create StageEntry,
 * audit, and clear `stalled` on forward-progress events.
 *
 * The caller (applyStageTrigger's V2 branch) is responsible for:
 *   - Calling isV2EnabledForSession() first.
 *   - Firing stage_entered automations from the returned StageEntry.
 *   - Cancelling stage-mismatched queued executions (same helper V1 uses).
 *
 * Idempotency: same-stage transitions short-circuit without creating a new
 * StageEntry, so a duplicate event firing twice does not produce two
 * stage-entered execution fan-outs.
 */
export async function applyTransitionV2(opts: {
  sessionId: string
  eventType: StageTriggerEvent
  context: TransitionContext
}): Promise<ApplyTransitionResult> {
  const session = await prisma.session.findUnique({
    where: { id: opts.sessionId },
    select: { id: true, workspaceId: true, pipelineStatus: true, status: true },
  })
  if (!session) return { kind: 'no_session' }

  const pipeline = await resolvePipelineForSession({
    sessionId: session.id,
    workspaceId: session.workspaceId,
  })
  if (!pipeline) return { kind: 'no_pipeline' }

  const stages = stagesFor(pipeline)
  const resolved = await resolveTransition({
    sessionId: session.id,
    eventType: opts.eventType,
    context: opts.context,
  })

  // ── No rule matched ──
  // V2 contract: event observed but no transition. Audit it (so recruiters
  // can answer "why didn't this move?" without log forensics) but DO NOT
  // mutate stage. We write directly because setPipelineStatus would skip
  // when from === to.
  if (!resolved) {
    await prisma.pipelineStatusChange.create({
      data: {
        sessionId: session.id,
        fromStatus: session.pipelineStatus,
        toStatus: session.pipelineStatus ?? '(unset)',
        source: `v2:no_rule:${opts.eventType}`,
        metadata: {
          v2: true,
          eventType: opts.eventType,
          context: opts.context as unknown as Prisma.InputJsonValue,
        } as unknown as Prisma.InputJsonValue,
      },
    }).catch((err) => {
      console.error('[pipeline-transitions] no_rule audit failed:', err)
    })
    return { kind: 'no_rule_matched', eventType: opts.eventType }
  }

  // ── Furthest-wins guard ──
  // Block backward moves unless the rule explicitly opts in. We still audit
  // the block so a misconfigured rule is visible without log spelunking.
  const currentOrder = stageOrder(stages, session.pipelineStatus)
  const targetOrder = stageOrder(stages, resolved.toStageId)
  if (
    !resolved.allowBackward &&
    currentOrder !== null &&
    targetOrder !== null &&
    targetOrder < currentOrder
  ) {
    await prisma.pipelineStatusChange.create({
      data: {
        sessionId: session.id,
        fromStatus: session.pipelineStatus,
        toStatus: resolved.toStageId,
        source: `v2:transition_blocked_backward:${opts.eventType}`,
        metadata: {
          v2: true,
          eventType: opts.eventType,
          ruleId: resolved.ruleId,
          currentOrder,
          targetOrder,
        } as unknown as Prisma.InputJsonValue,
      },
    }).catch((err) => {
      console.error('[pipeline-transitions] blocked_backward audit failed:', err)
    })
    return {
      kind: 'blocked_backward',
      ruleId: resolved.ruleId,
      toStageId: resolved.toStageId,
      currentStageId: session.pipelineStatus ?? '(none)',
    }
  }

  // ── Same-stage no-op ──
  // The matched rule resolves to where the candidate already sits. Skip the
  // write AND the StageEntry creation so a re-fired event (e.g. duplicate
  // webhook) doesn't spawn duplicate stage_entered automation fan-outs.
  if (resolved.toStageId === session.pipelineStatus) {
    return { kind: 'same_stage', stageId: resolved.toStageId, ruleId: resolved.ruleId }
  }

  // ── Apply transition ──
  await setPipelineStatus({
    sessionId: session.id,
    toStatus: resolved.toStageId,
    source: `v2:auto:${opts.eventType}`,
    metadata: {
      v2: true,
      eventType: opts.eventType,
      ruleId: resolved.ruleId,
      fromStageId: resolved.fromStageId,
      targetId: resolved.targetId,
      priority: resolved.priority,
      allowBackward: resolved.allowBackward,
    },
  })

  const stageEntry = await prisma.stageEntry.create({
    data: {
      workspaceId: session.workspaceId,
      pipelineId: pipeline.id,
      sessionId: session.id,
      stageId: resolved.toStageId,
      previousStageId: session.pipelineStatus,
      sourceEventType: opts.eventType,
      sourceEventId: opts.context.sourceEventId ?? null,
      transitionRuleId: resolved.ruleId,
    },
    select: { id: true },
  })

  // Forward-progress reactivation — mirror of V1's behaviour in
  // funnel-stage-runtime.ts. Only flips a stalled candidate back to active
  // and clears the automation halt switch; deliberately leaves nurture /
  // lost / hired alone (recruiter intent wins over event chatter).
  if (V2_FORWARD_PROGRESS_EVENTS.has(opts.eventType) && session.status === 'stalled') {
    await prisma.session.updateMany({
      where: { id: session.id, status: 'stalled' },
      data: {
        status: 'active',
        stalledAt: null,
        dispositionReason: null,
        automationsHaltedAt: null,
        automationsHaltedReason: null,
      },
    }).catch((err) => {
      console.error('[pipeline-transitions] stalled reactivation failed:', err)
    })
  }

  return {
    kind: 'transitioned',
    stageEntryId: stageEntry.id,
    toStageId: resolved.toStageId,
    fromStageId: session.pipelineStatus,
    ruleId: resolved.ruleId,
  }
}

function stageOrder(stages: FunnelStage[], stageId: string | null | undefined): number | null {
  if (!stageId) return null
  const found = stages.find((s) => s.id === stageId)
  return found ? found.order : null
}
