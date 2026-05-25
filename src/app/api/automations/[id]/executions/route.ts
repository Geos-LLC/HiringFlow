import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// List recent executions for an automation rule. Used by the "Sent" count
// in the automations table — clicking it opens a modal that lists every
// candidate the rule ran against, with status, channel, sent time, and a
// link to the candidate page.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const rule = await prisma.automationRule.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const status = request.nextUrl.searchParams.get('status')
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '200', 10) || 200, 1000)

  const executions = await prisma.automationExecution.findMany({
    where: {
      automationRuleId: params.id,
      ...(status ? { status } : {}),
    },
    orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    select: {
      id: true,
      status: true,
      channel: true,
      sentAt: true,
      scheduledFor: true,
      createdAt: true,
      errorMessage: true,
      sessionId: true,
      deliveryStatus: true,
      deliveryStatusAt: true,
      deliveryErrorMessage: true,
      step: { select: { id: true, order: true } },
    },
  })

  // AutomationExecution.sessionId has no Prisma relation back to Session
  // (intentional — keeps history rows immune to session deletion cascades),
  // so we fetch the candidate fields in a single follow-up query and merge
  // them in. Workspace scope is enforced via the join.
  const sessionIds = Array.from(new Set(executions.map((e) => e.sessionId).filter((id): id is string => !!id)))
  const sessions = sessionIds.length === 0 ? [] : await prisma.session.findMany({
    where: { id: { in: sessionIds }, workspaceId: ws.workspaceId },
    select: { id: true, candidateName: true, candidateEmail: true, candidatePhone: true },
  })
  const sessionById = new Map(sessions.map((s) => [s.id, s]))

  return NextResponse.json(executions.map((e) => ({
    ...e,
    session: e.sessionId ? sessionById.get(e.sessionId) ?? null : null,
  })))
}
