import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { normalizeStages, DEFAULT_FUNNEL_STAGES } from '@/lib/funnel-stages'
import { listWorkspacePipelinesWithCounts } from '@/lib/pipelines'

// List pipelines for the caller's workspace, with a flow-count badge per
// pipeline. The default pipeline is always first; remaining pipelines are
// ordered by creation date. listWorkspacePipelinesWithCounts auto-creates
// the default if missing so newly-migrated workspaces never see an empty list.
export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const rows = await listWorkspacePipelinesWithCounts(ws.workspaceId)
  return NextResponse.json(rows.map((r) => ({
    id: r.pipeline.id,
    name: r.pipeline.name,
    isDefault: r.pipeline.isDefault,
    stages: normalizeStages(r.pipeline.stages),
    flowCount: r.flowCount,
    transitionsV2Enabled: r.pipeline.transitionsV2Enabled,
    createdAt: r.pipeline.createdAt.toISOString(),
  })))
}

// Create a new pipeline. New pipelines start with the platform default stage
// set so the recruiter has something to edit, and are never marked default
// (the workspace already has exactly one default; switching defaults is its
// own action handled via PATCH `?makeDefault=1`).
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = await request.json().catch(() => ({})) as {
    name?: string
    seedFromPipelineId?: string
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (name.length > 80) {
    return NextResponse.json({ error: 'name is too long' }, { status: 400 })
  }

  // Optionally clone stages from an existing pipeline so a new "Dispatcher"
  // pipeline can start from the "Default" one and have the irrelevant stages
  // stripped, rather than starting from blank and rebuilding everything.
  let stages = DEFAULT_FUNNEL_STAGES
  if (body.seedFromPipelineId) {
    const seed = await prisma.pipeline.findFirst({
      where: { id: body.seedFromPipelineId, workspaceId: ws.workspaceId },
      select: { stages: true },
    })
    if (seed) stages = normalizeStages(seed.stages)
  }

  const created = await prisma.pipeline.create({
    data: {
      workspaceId: ws.workspaceId,
      name,
      stages: stages as unknown as object,
      isDefault: false,
    },
  })
  return NextResponse.json({
    id: created.id,
    name: created.name,
    isDefault: created.isDefault,
    stages: normalizeStages(created.stages),
    flowCount: 0,
    createdAt: created.createdAt.toISOString(),
  }, { status: 201 })
}
