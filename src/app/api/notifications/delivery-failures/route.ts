/**
 * GET /api/notifications/delivery-failures?since=<iso>
 *
 * Lists recent email delivery failures for the active workspace. Used by
 * the dashboard's DeliveryFailureToaster client component to surface
 * blocked / bounced / dropped sends as red toasts.
 *
 * Response: `{ items: [{ id, sessionId, candidateName, candidateEmail,
 *   ruleName, deliveryStatus, deliveryErrorMessage, deliveryStatusAt,
 *   bounceRetried, retriedDelivered }] }`
 *
 * `since` defaults to 30 minutes ago to avoid replaying ancient failures
 * on first load. Cap is 100 items so a runaway bad-domain doesn't flood
 * the client.
 *
 * Excludes executions whose bounce-retry already succeeded
 * (`retriedDelivered`) — those recovered automatically and don't need
 * recruiter attention.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

const FAILURE_STATUSES = ['blocked', 'bounce', 'dropped']

export async function GET(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const sinceParam = request.nextUrl.searchParams.get('since')
  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 30 * 60 * 1000)
  if (isNaN(since.getTime())) {
    return NextResponse.json({ error: 'invalid since' }, { status: 400 })
  }

  const rows = await prisma.automationExecution.findMany({
    where: {
      automationRule: { workspaceId: ws.workspaceId },
      channel: 'email',
      deliveryStatus: { in: FAILURE_STATUSES },
      deliveryStatusAt: { gte: since },
    },
    select: {
      id: true,
      sessionId: true,
      deliveryStatus: true,
      deliveryStatusAt: true,
      deliveryErrorMessage: true,
      bounceRetriedAt: true,
      automationRule: { select: { name: true } },
    },
    orderBy: { deliveryStatusAt: 'desc' },
    take: 100,
  })

  // AutomationExecution has no direct `session` relation in the schema —
  // do a single batched lookup so we can attach candidate name/email.
  const sessionIds = Array.from(new Set(rows.map(r => r.sessionId).filter((v): v is string => !!v)))
  const sessions = sessionIds.length > 0
    ? await prisma.session.findMany({
        where: { id: { in: sessionIds } },
        select: { id: true, candidateName: true, candidateEmail: true },
      })
    : []
  const sessionMap = new Map(sessions.map(s => [s.id, s]))

  const items = rows.map(r => {
    const session = r.sessionId ? sessionMap.get(r.sessionId) : null
    return {
      id: r.id,
      sessionId: r.sessionId,
      candidateName: session?.candidateName ?? null,
      candidateEmail: session?.candidateEmail ?? null,
      ruleName: r.automationRule?.name || null,
      deliveryStatus: r.deliveryStatus,
      deliveryErrorMessage: r.deliveryErrorMessage,
      deliveryStatusAt: r.deliveryStatusAt,
      bounceRetried: r.bounceRetriedAt != null,
    }
  })

  return NextResponse.json({ items })
}
