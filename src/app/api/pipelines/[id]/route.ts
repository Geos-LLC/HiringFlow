import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { normalizeStages } from '@/lib/funnel-stages'

// Update a pipeline. Accepts:
//   - name (string)            rename the pipeline
//   - stages (FunnelStage[])   replace the full stage list (validated via
//                              normalizeStages before persisting)
//   - makeDefault (true)       promote this pipeline to the workspace default,
//                              demoting the previous default. Default pipelines
//                              receive flows with `pipelineId = null` and can't
//                              be deleted, so this is a deliberate one-way move.
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const pipeline = await prisma.pipeline.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
  })
  if (!pipeline) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json().catch(() => ({})) as {
    name?: string
    stages?: unknown
    makeDefault?: boolean
    transitionsV2Enabled?: boolean
  }

  const data: { name?: string; stages?: object; isDefault?: boolean; transitionsV2Enabled?: boolean } = {}
  if (body.name !== undefined) {
    const trimmed = typeof body.name === 'string' ? body.name.trim() : ''
    if (!trimmed) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    if (trimmed.length > 80) return NextResponse.json({ error: 'name is too long' }, { status: 400 })
    data.name = trimmed
  }
  if (body.stages !== undefined) {
    // normalizeStages drops malformed entries and returns DEFAULT_FUNNEL_STAGES
    // for empty input — guard against accidentally wiping a pipeline's stages
    // with a `[]` body by refusing the write when the caller passed an array
    // but it normalized to defaults.
    if (!Array.isArray(body.stages)) {
      return NextResponse.json({ error: 'stages must be an array' }, { status: 400 })
    }
    const validated = normalizeStages(body.stages)
    if (validated.length === 0) {
      return NextResponse.json({ error: 'Pipeline must have at least one stage' }, { status: 400 })
    }
    data.stages = validated as unknown as object
  }
  // Pipeline Transitions v2 opt-in. Independent of stages — flipping the
  // flag does not validate that the pipeline has any PipelineTransitionRule
  // rows. That's intentional: the recruiter may want to flip the flag, then
  // build rules; the empty-state UI warning surfaces the half-configured
  // state separately.
  if (typeof body.transitionsV2Enabled === 'boolean') {
    data.transitionsV2Enabled = body.transitionsV2Enabled
  }

  // makeDefault is a single transactional swap so the workspace always has
  // exactly one default. No-op if this pipeline is already default.
  if (body.makeDefault === true && !pipeline.isDefault) {
    await prisma.$transaction([
      prisma.pipeline.updateMany({
        where: { workspaceId: ws.workspaceId, isDefault: true },
        data: { isDefault: false },
      }),
      prisma.pipeline.update({
        where: { id: pipeline.id },
        data: { ...data, isDefault: true },
      }),
    ])
  } else if (Object.keys(data).length > 0) {
    await prisma.pipeline.update({
      where: { id: pipeline.id },
      data,
    })
  }

  const fresh = await prisma.pipeline.findUnique({ where: { id: pipeline.id } })
  if (!fresh) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({
    id: fresh.id,
    name: fresh.name,
    isDefault: fresh.isDefault,
    stages: normalizeStages(fresh.stages),
    transitionsV2Enabled: fresh.transitionsV2Enabled,
  })
}

// Delete a pipeline. The default pipeline can't be deleted — workspaces must
// always have a fallback for flows with `pipelineId = null`. Flows pointing at
// the deleted pipeline get their pipelineId nulled (Prisma `onDelete: SetNull`)
// and fall through to the workspace default.
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const pipeline = await prisma.pipeline.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
  })
  if (!pipeline) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (pipeline.isDefault) {
    return NextResponse.json(
      { error: 'Cannot delete the default pipeline. Promote another pipeline to default first.' },
      { status: 409 },
    )
  }

  await prisma.pipeline.delete({ where: { id: pipeline.id } })
  return NextResponse.json({ success: true })
}
