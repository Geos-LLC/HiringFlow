import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { nanoid } from 'nanoid'

const WORKFLOW_TYPES = ['application', 'interview', 'assessment', 'training', 'survey', 'custom']

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const flows = await prisma.flow.findMany({
    where: { workspaceId: ws.workspaceId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: {
        select: { steps: true, sessions: true },
      },
      steps: {
        // Mini-map preview: the list card renders a small left-to-right
        // strip of step-type chips so the recruiter can scan workflow
        // shapes at a glance. We pull only the fields we need to keep
        // the payload small, even on workspaces with many flows.
        orderBy: { stepOrder: 'asc' },
        select: { id: true, stepType: true, questionType: true, formEnabled: true },
      },
    },
  })

  // Completion-rate signal. We compute "completed" as sessions whose
  // `outcome` is 'completed' or 'passed' since both represent a candidate
  // who reached the end of the flow. The list card renders this alongside
  // candidate count.
  const completedCounts = await prisma.session.groupBy({
    by: ['flowId'],
    where: {
      workspaceId: ws.workspaceId,
      outcome: { in: ['completed', 'passed'] },
    },
    _count: { _all: true },
  })
  const completedByFlow: Record<string, number> = {}
  for (const c of completedCounts) {
    completedByFlow[c.flowId] = c._count._all
  }

  return NextResponse.json(
    flows.map((f) => ({
      ...f,
      completedSessions: completedByFlow[f.id] ?? 0,
    })),
  )
}

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  try {
    const body = await request.json() as { name?: string; workflowType?: string | null }
    const { name, workflowType } = body

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }
    if (workflowType !== undefined && workflowType !== null && !WORKFLOW_TYPES.includes(workflowType)) {
      return NextResponse.json({ error: `workflowType must be one of: ${WORKFLOW_TYPES.join(', ')} or null` }, { status: 400 })
    }

    const slug = nanoid(10)

    const flow = await prisma.flow.create({
      data: {
        workspaceId: ws.workspaceId,
        createdById: ws.userId,
        name,
        slug,
        workflowType: workflowType ?? 'application',
      },
    })

    return NextResponse.json(flow)
  } catch (error) {
    console.error('Create flow error:', error)
    return NextResponse.json({ error: 'Failed to create flow' }, { status: 500 })
  }
}
