import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// Duplicate a HiringProcess. Always lands as 'draft' regardless of the
// source's status — duplicating an active process and instantly activating
// the clone would create the "two active processes on the same flow" case
// the candidate-attach path can't disambiguate. Recruiter has to swap
// references (or archive the original) and explicitly activate.
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const src = await prisma.hiringProcess.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    include: { automations: { orderBy: { order: 'asc' } } },
  })
  if (!src) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const created = await prisma.hiringProcess.create({
    data: {
      workspaceId: ws.workspaceId,
      name: `${src.name} (copy)`,
      description: src.description,
      status: 'draft',
      flowId: src.flowId,
      trainingId: src.trainingId,
      schedulingConfigId: src.schedulingConfigId,
      pipelineId: src.pipelineId,
      automations: src.automations.length
        ? {
            create: src.automations.map((a) => ({
              automationRuleId: a.automationRuleId,
              order: a.order,
            })),
          }
        : undefined,
    },
    select: { id: true },
  })

  return NextResponse.json({ id: created.id }, { status: 201 })
}
