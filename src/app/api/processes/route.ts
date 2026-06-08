import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import {
  hasConflictingActiveProcessOnFlow,
  isHiringProcessStatus,
  validateActivate,
} from '@/lib/hiring-processes'

// List HiringProcesses for the caller's workspace. Each row carries the
// counts the list page renders as badges:
//   - automationsCount: number of attached AutomationRules
//   - candidatesCount:  number of Sessions whose processId matches
//
// We deliberately do NOT eager-load the full Flow/Training/Pipeline objects —
// just their names/ids — to keep the list payload small. The edit page
// fetches the rest.
export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const rows = await prisma.hiringProcess.findMany({
    where: { workspaceId: ws.workspaceId },
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    include: {
      flow: { select: { id: true, name: true } },
      training: { select: { id: true, title: true } },
      schedulingConfig: { select: { id: true, name: true } },
      pipeline: { select: { id: true, name: true } },
      _count: { select: { automations: true, sessions: true } },
    },
  })

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      flow: r.flow,
      training: r.training,
      schedulingConfig: r.schedulingConfig,
      pipeline: r.pipeline,
      automationsCount: r._count.automations,
      candidatesCount: r._count.sessions,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  )
}

// Create a new HiringProcess. Starts as 'draft' unless the caller explicitly
// asks for 'active', in which case we enforce the activation rules up front
// (flowId + pipelineId required, no other active process on the same flow).
//
// Activation rules are duplicated in PATCH so a status change applied later
// goes through the same validation — single source of truth in
// src/lib/hiring-processes.ts.
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

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

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  if (name.length > 120) return NextResponse.json({ error: 'Name is too long' }, { status: 400 })

  const status = body.status && isHiringProcessStatus(body.status) ? body.status : 'draft'

  if (status === 'active') {
    const errs = validateActivate({ flowId: body.flowId, pipelineId: body.pipelineId })
    if (errs.length) return NextResponse.json({ error: errs.join(' ') }, { status: 400 })
    if (body.flowId) {
      const conflict = await hasConflictingActiveProcessOnFlow(prisma, {
        workspaceId: ws.workspaceId,
        flowId: body.flowId,
      })
      if (conflict) {
        return NextResponse.json(
          { error: 'Another active Hiring Process already uses this flow. Archive it first.' },
          { status: 409 },
        )
      }
    }
  }

  // Validate every referenced entity belongs to this workspace. Otherwise a
  // hostile client could attach a flow from another workspace and silently
  // start re-attributing sessions across tenants.
  const ownership = await assertOwnership(ws.workspaceId, {
    flowId: body.flowId,
    trainingId: body.trainingId,
    schedulingConfigId: body.schedulingConfigId,
    pipelineId: body.pipelineId,
    automationRuleIds: body.automationRuleIds,
  })
  if (ownership) return ownership

  const ruleIds = Array.isArray(body.automationRuleIds) ? body.automationRuleIds : []

  const created = await prisma.hiringProcess.create({
    data: {
      workspaceId: ws.workspaceId,
      name,
      description: body.description?.trim() || null,
      status,
      flowId: body.flowId || null,
      trainingId: body.trainingId || null,
      schedulingConfigId: body.schedulingConfigId || null,
      pipelineId: body.pipelineId || null,
      automations: ruleIds.length
        ? { create: ruleIds.map((id, idx) => ({ automationRuleId: id, order: idx })) }
        : undefined,
    },
  })

  return NextResponse.json({ id: created.id }, { status: 201 })
}

/**
 * Guard: every entity referenced by a HiringProcess must belong to the same
 * workspace. Returns a NextResponse 400 if any check fails, otherwise null.
 * Kept here (not in lib/) because it's only used by the route layer.
 */
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
