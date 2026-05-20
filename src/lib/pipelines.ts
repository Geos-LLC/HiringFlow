/**
 * Pipelines — multi-pipeline support for funnel stages.
 *
 * Workspaces can have many Pipeline rows, each owning its own ordered stage
 * list. Flows assign themselves to a pipeline (Flow.pipelineId). When that's
 * null we fall back to the workspace's default pipeline so unconfigured
 * flows keep working.
 *
 * Resolution helpers in this module are the single chokepoint for every
 * "which stages apply to this candidate?" question — automation matchers,
 * the kanban API, the candidate detail page, applyStageTrigger.
 */

import type { Pipeline } from '@prisma/client'
import { prisma } from './prisma'
import {
  DEFAULT_FUNNEL_STAGES,
  normalizeStages,
  type FunnelStage,
} from './funnel-stages'

// Cheap wrapper so callers don't have to pull `.stages` JSON, normalize it,
// and remember the shape every time. Returns the in-memory FunnelStage[]
// array, falling back to defaults if the row's stages JSON is malformed.
export function stagesFor(pipeline: Pick<Pipeline, 'stages'>): FunnelStage[] {
  return normalizeStages(pipeline.stages)
}

// Returns the workspace's default pipeline, creating one on the fly if none
// exists yet. The on-the-fly create is the migration path for old workspaces
// — once we've written the row, subsequent reads are free.
//
// We seed the new pipeline's stages from `Workspace.settings.funnelStages`
// when present, so workspaces that customized their kanban don't lose those
// customizations on first read. Falls through to DEFAULT_FUNNEL_STAGES when
// the workspace has no prior config.
export async function getOrCreateDefaultPipeline(workspaceId: string): Promise<Pipeline> {
  const existing = await prisma.pipeline.findFirst({
    where: { workspaceId, isDefault: true },
  })
  if (existing) return existing

  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { settings: true },
  })
  const legacy = (ws?.settings as { funnelStages?: unknown } | null)?.funnelStages
  const stages = normalizeStages(legacy ?? DEFAULT_FUNNEL_STAGES)

  return prisma.pipeline.create({
    data: {
      workspaceId,
      name: 'Default',
      stages: stages as unknown as object,
      isDefault: true,
    },
  })
}

// Resolves "which pipeline applies to this flow?" — either the flow's own
// pipelineId, or the workspace default. Used by the kanban, the candidate
// detail page, and the automation engine.
export async function resolvePipelineForFlow(opts: {
  flowId: string
  workspaceId: string
}): Promise<Pipeline> {
  const flow = await prisma.flow.findUnique({
    where: { id: opts.flowId },
    select: { pipelineId: true, workspaceId: true },
  })
  if (flow?.pipelineId) {
    const pipeline = await prisma.pipeline.findUnique({ where: { id: flow.pipelineId } })
    if (pipeline && pipeline.workspaceId === opts.workspaceId) return pipeline
  }
  return getOrCreateDefaultPipeline(opts.workspaceId)
}

// Same as resolvePipelineForFlow but starting from a session. Used by event
// handlers like applyStageTrigger that already have a sessionId in hand.
export async function resolvePipelineForSession(opts: {
  sessionId: string
  workspaceId?: string
}): Promise<Pipeline | null> {
  const session = await prisma.session.findUnique({
    where: { id: opts.sessionId },
    select: { flowId: true, workspaceId: true },
  })
  if (!session) return null
  return resolvePipelineForFlow({
    flowId: session.flowId,
    workspaceId: opts.workspaceId ?? session.workspaceId,
  })
}

// Bulk version for the kanban — given a list of flows, return a map of
// flowId -> stages. Resolves the workspace default once and reuses it for
// flows with no explicit pipelineId.
export async function resolveStagesForFlows(opts: {
  workspaceId: string
  flowIds: string[]
}): Promise<Map<string, FunnelStage[]>> {
  const out = new Map<string, FunnelStage[]>()
  if (opts.flowIds.length === 0) return out

  const flows = await prisma.flow.findMany({
    where: { id: { in: opts.flowIds }, workspaceId: opts.workspaceId },
    select: { id: true, pipelineId: true },
  })
  const pipelineIds = Array.from(
    new Set(flows.map((f) => f.pipelineId).filter((id): id is string => !!id)),
  )
  const pipelines = pipelineIds.length
    ? await prisma.pipeline.findMany({ where: { id: { in: pipelineIds }, workspaceId: opts.workspaceId } })
    : []
  const byId = new Map(pipelines.map((p) => [p.id, p]))

  const fallback = await getOrCreateDefaultPipeline(opts.workspaceId)
  const fallbackStages = stagesFor(fallback)

  for (const f of flows) {
    const pipeline = f.pipelineId ? byId.get(f.pipelineId) : null
    out.set(f.id, pipeline ? stagesFor(pipeline) : fallbackStages)
  }
  return out
}

// Used by the pipelines settings page. Lists every pipeline a workspace owns
// with a flow-count summary so the UI can show "Cleaner (3 flows)" / "Dispatcher
// (1 flow)" without a separate fetch.
export async function listWorkspacePipelinesWithCounts(workspaceId: string): Promise<Array<{
  pipeline: Pipeline
  flowCount: number
}>> {
  // Make sure the default exists before listing so a freshly migrated
  // workspace doesn't see an empty list.
  await getOrCreateDefaultPipeline(workspaceId)

  const pipelines = await prisma.pipeline.findMany({
    where: { workspaceId },
    // Default first (pinned to top of the list since it receives the
    // null-pipelineId fallback flows), then newest-created next. New
    // pipelines surface immediately at the top instead of being buried
    // under older ones the recruiter has already configured.
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  })
  if (pipelines.length === 0) return []

  const groups = await prisma.flow.groupBy({
    by: ['pipelineId'],
    where: { workspaceId, pipelineId: { in: pipelines.map((p) => p.id) } },
    _count: { _all: true },
  })
  const byPipelineId = new Map<string, number>(
    groups.map((g) => [g.pipelineId as string, g._count._all]),
  )
  // The default pipeline absorbs flows with pipelineId=null too — count
  // those as well so the UI badge matches what the kanban renders.
  const nullFlowCount = await prisma.flow.count({
    where: { workspaceId, pipelineId: null },
  })
  return pipelines.map((p) => ({
    pipeline: p,
    flowCount: (byPipelineId.get(p.id) ?? 0) + (p.isDefault ? nullFlowCount : 0),
  }))
}
