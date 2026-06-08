import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import {
  findStageReferenceWarnings,
  hasConflictingActiveProcessOnFlow,
  isHiringProcessStatus,
  validateActivate,
} from '@/lib/hiring-processes'

// Fetch one HiringProcess plus the derived fields the editor needs:
//
//   - stageWarnings: AutomationRules attached to this process whose stageId
//     doesn't exist in the selected Pipeline. Surfaced as a yellow banner in
//     the Automations step of the editor (the spec calls for a warning, not
//     a hard error).
//   - bookingUrlPreview: when a SchedulingConfig is attached, the URL a
//     candidate would land on. Lets the Review step show "Candidates will
//     book at https://...".
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const row = await prisma.hiringProcess.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    include: {
      flow: { select: { id: true, name: true, slug: true } },
      training: { select: { id: true, title: true, slug: true } },
      schedulingConfig: {
        select: { id: true, name: true, schedulingUrl: true, useBuiltInScheduler: true },
      },
      pipeline: { select: { id: true, name: true, stages: true } },
      automations: {
        orderBy: { order: 'asc' },
        include: {
          automationRule: {
            select: { id: true, name: true, triggerType: true, stageId: true, isActive: true },
          },
        },
      },
      _count: { select: { sessions: true } },
    },
  })

  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const rulesForWarning = row.automations.map((a) => ({
    id: a.automationRule.id,
    name: a.automationRule.name,
    stageId: a.automationRule.stageId,
  }))
  const stageWarnings = row.pipeline
    ? findStageReferenceWarnings(rulesForWarning, row.pipeline.stages)
    : []

  // The recruiter wants to verify their booking link before activating. We
  // hand back the same URL the public scheduling redirect would 302 to: the
  // pasted external link OR the in-app /book/:configId page.
  let bookingUrlPreview: string | null = null
  if (row.schedulingConfig) {
    bookingUrlPreview = row.schedulingConfig.useBuiltInScheduler
      ? `/book/${row.schedulingConfig.id}`
      : row.schedulingConfig.schedulingUrl
  }

  return NextResponse.json({
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    flow: row.flow,
    training: row.training,
    schedulingConfig: row.schedulingConfig,
    pipeline: row.pipeline
      ? { id: row.pipeline.id, name: row.pipeline.name }
      : null,
    automations: row.automations.map((a) => ({
      id: a.automationRule.id,
      name: a.automationRule.name,
      triggerType: a.automationRule.triggerType,
      stageId: a.automationRule.stageId,
      isActive: a.automationRule.isActive,
      order: a.order,
    })),
    stageWarnings,
    bookingUrlPreview,
    candidatesCount: row._count.sessions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

// Update a HiringProcess. Any subset of fields may be provided. If status
// changes to 'active' we re-run the activation rules — that means activating
// a previously-draft process from the list-page "Activate" button hits the
// same gate as creating-and-activating in one shot.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const existing = await prisma.hiringProcess.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: {
      id: true, status: true, flowId: true, pipelineId: true,
    },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = (await request.json().catch(() => ({}))) as {
    name?: string
    description?: string | null
    status?: string
    flowId?: string | null
    trainingId?: string | null
    schedulingConfigId?: string | null
    pipelineId?: string | null
    automationRuleIds?: string[]
  }

  const data: Record<string, unknown> = {}

  if (typeof body.name === 'string') {
    const n = body.name.trim()
    if (!n) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    if (n.length > 120) return NextResponse.json({ error: 'Name is too long' }, { status: 400 })
    data.name = n
  }
  if (body.description !== undefined) {
    data.description = typeof body.description === 'string' ? body.description.trim() || null : null
  }
  if (body.flowId !== undefined) data.flowId = body.flowId || null
  if (body.trainingId !== undefined) data.trainingId = body.trainingId || null
  if (body.schedulingConfigId !== undefined) data.schedulingConfigId = body.schedulingConfigId || null
  if (body.pipelineId !== undefined) data.pipelineId = body.pipelineId || null

  // Status: validate transition. The effective flow/pipeline for the
  // activation check is the post-update value, not the pre-update value —
  // otherwise a recruiter saving "set flowId + activate" in one PATCH would
  // fail the gate.
  let nextStatus = existing.status as 'draft' | 'active' | 'archived'
  if (body.status !== undefined) {
    if (!isHiringProcessStatus(body.status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }
    nextStatus = body.status
    data.status = body.status
  }

  if (nextStatus === 'active') {
    const flowId = data.flowId !== undefined ? (data.flowId as string | null) : existing.flowId
    const pipelineId = data.pipelineId !== undefined ? (data.pipelineId as string | null) : existing.pipelineId
    const errs = validateActivate({ flowId, pipelineId })
    if (errs.length) return NextResponse.json({ error: errs.join(' ') }, { status: 400 })
    if (flowId) {
      const conflict = await hasConflictingActiveProcessOnFlow(prisma, {
        workspaceId: ws.workspaceId,
        flowId,
        excludeProcessId: existing.id,
      })
      if (conflict) {
        return NextResponse.json(
          { error: 'Another active Hiring Process already uses this flow. Archive it first.' },
          { status: 409 },
        )
      }
    }
  }

  // Workspace-ownership guards. Same as POST — see /api/processes/route.ts.
  const owns = await assertOwnership(ws.workspaceId, {
    flowId: data.flowId as string | null | undefined,
    trainingId: data.trainingId as string | null | undefined,
    schedulingConfigId: data.schedulingConfigId as string | null | undefined,
    pipelineId: data.pipelineId as string | null | undefined,
    automationRuleIds: body.automationRuleIds,
  })
  if (owns) return owns

  // Apply the update + (optionally) replace the automation list. Wrapped in a
  // transaction so we never end up with a half-saved process whose
  // automations changed but whose status didn't.
  await prisma.$transaction(async (tx) => {
    await tx.hiringProcess.update({ where: { id: existing.id }, data })

    if (Array.isArray(body.automationRuleIds)) {
      await tx.hiringProcessAutomation.deleteMany({ where: { processId: existing.id } })
      if (body.automationRuleIds.length) {
        await tx.hiringProcessAutomation.createMany({
          data: body.automationRuleIds.map((id, idx) => ({
            processId: existing.id,
            automationRuleId: id,
            order: idx,
          })),
          skipDuplicates: true,
        })
      }
    }
  })

  return NextResponse.json({ ok: true })
}

async function assertOwnership(
  workspaceId: string,
  refs: {
    flowId?: string | null
    trainingId?: string | null
    schedulingConfigId?: string | null
    pipelineId?: string | null
    automationRuleIds?: string[]
  },
): Promise<NextResponse | null> {
  const checks: Array<Promise<boolean>> = []

  if (refs.flowId) {
    checks.push(
      prisma.flow
        .findFirst({ where: { id: refs.flowId, workspaceId }, select: { id: true } })
        .then((r) => !!r),
    )
  }
  if (refs.trainingId) {
    checks.push(
      prisma.training
        .findFirst({ where: { id: refs.trainingId, workspaceId }, select: { id: true } })
        .then((r) => !!r),
    )
  }
  if (refs.schedulingConfigId) {
    checks.push(
      prisma.schedulingConfig
        .findFirst({ where: { id: refs.schedulingConfigId, workspaceId }, select: { id: true } })
        .then((r) => !!r),
    )
  }
  if (refs.pipelineId) {
    checks.push(
      prisma.pipeline
        .findFirst({ where: { id: refs.pipelineId, workspaceId }, select: { id: true } })
        .then((r) => !!r),
    )
  }
  if (refs.automationRuleIds && refs.automationRuleIds.length) {
    checks.push(
      prisma.automationRule
        .count({ where: { id: { in: refs.automationRuleIds }, workspaceId } })
        .then((c) => c === refs.automationRuleIds!.length),
    )
  }

  const results = await Promise.all(checks)
  if (results.some((ok) => !ok)) {
    return NextResponse.json(
      { error: 'One or more referenced items do not belong to this workspace.' },
      { status: 400 },
    )
  }
  return null
}
