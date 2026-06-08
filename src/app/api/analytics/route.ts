import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { getFunnelMetrics, getSourceMetrics, getAdMetrics, getStatusMetrics, DateFilter } from '@/lib/analytics'

export async function GET(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const range = request.nextUrl.searchParams.get('range') || 'all'
  // Optional Hiring Process scope. The funnel chart honors it; source/ad/status
  // breakdowns ignore it for now since their value is comparing across
  // sources/ads, not within one process.
  const processId = request.nextUrl.searchParams.get('processId') || undefined
  // Optional target-position scope — matches Ad.targetPosition via the
  // session→ad relation so the funnel reflects only candidates hiring for
  // that role. '__unassigned' covers no-ad + null-position sessions.
  const targetPosition = request.nextUrl.searchParams.get('targetPosition') || undefined

  let filter: DateFilter | undefined
  const now = new Date()

  if (range === '7d') {
    filter = { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) }
  } else if (range === '30d') {
    filter = { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) }
  }
  if (processId) {
    filter = { ...(filter || {}), processId }
  }
  if (targetPosition) {
    filter = { ...(filter || {}), targetPosition }
  }

  const [funnel, sources, ads, status] = await Promise.all([
    getFunnelMetrics(ws.workspaceId, filter),
    getSourceMetrics(ws.workspaceId, filter),
    getAdMetrics(ws.workspaceId, filter),
    getStatusMetrics(ws.workspaceId, filter),
  ])

  return NextResponse.json({ funnel, sources, ads, status })
}
