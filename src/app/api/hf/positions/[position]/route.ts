/**
 * GET /api/hf/positions/[position]
 *
 * Position detail data — matches Design/5-position.png.
 * Aggregates: summary stats, pipeline performance, top sources, recent
 * candidates. All scoped to the Ad.targetPosition string.
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getFunnelMetrics, getSourceMetrics } from '@/lib/analytics'

export async function GET(
  _req: Request,
  { params }: { params: { position: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const positionSlug = decodeURIComponent(params.position)
  const isUnassigned = positionSlug === '__unassigned'

  // Query filter for sessions attributed to this position via their Ad.
  const sessionWhere = isUnassigned
    ? { workspaceId: ws.workspaceId, OR: [{ adId: null }, { ad: { targetPosition: null } }] }
    : { workspaceId: ws.workspaceId, ad: { targetPosition: positionSlug } }

  const [funnel, sources, sessionCount, activeCount, hiredCount, ads, recent, firstAd] = await Promise.all([
    getFunnelMetrics(ws.workspaceId, { targetPosition: positionSlug }),
    getSourceMetrics(ws.workspaceId, { targetPosition: positionSlug }),
    prisma.session.count({ where: sessionWhere }),
    prisma.session.count({ where: { ...sessionWhere, status: { in: ['active', 'waiting'] } } }),
    prisma.session.count({ where: { ...sessionWhere, status: 'hired' } }),
    prisma.ad.findMany({
      where: isUnassigned
        ? { workspaceId: ws.workspaceId, targetPosition: null }
        : { workspaceId: ws.workspaceId, targetPosition: positionSlug },
      orderBy: { createdAt: 'asc' },
      take: 5,
      select: { id: true, name: true, source: true, createdAt: true },
    }),
    prisma.session.findMany({
      where: sessionWhere,
      orderBy: { lastActivityAt: 'desc' },
      take: 20,
      select: {
        id: true, candidateName: true, candidateEmail: true,
        status: true, pipelineStatus: true, lastActivityAt: true, startedAt: true,
        flow: { select: { name: true } },
      },
    }),
    // Age of the earliest ad — used as "position active since"
    prisma.ad.findFirst({
      where: isUnassigned
        ? { workspaceId: ws.workspaceId, targetPosition: null }
        : { workspaceId: ws.workspaceId, targetPosition: positionSlug },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ])

  // "This week" newly-started sessions for the third stat card.
  const startOfWeek = new Date(Date.now() - 7 * 24 * 3600_000)
  const startedThisWeek = await prisma.session.count({
    where: { ...sessionWhere, startedAt: { gte: startOfWeek } },
  })

  // Average time from start → hire, for the fourth stat card (days).
  const hiredWithDates = await prisma.session.findMany({
    where: { ...sessionWhere, hiredAt: { not: null } },
    select: { startedAt: true, hiredAt: true },
    take: 200,
  })
  const avgDaysToHire = hiredWithDates.length > 0
    ? hiredWithDates.reduce((a, s) => a + ((s.hiredAt!.getTime() - s.startedAt.getTime()) / (24 * 3600_000)), 0) / hiredWithDates.length
    : null

  const totalStarted = funnel.started || 1
  const pipelinePerf = [
    { stage: 'Application',        count: funnel.started,           pct: 100 },
    { stage: 'Orientation training', count: funnel.trainingStarted, pct: Math.round((funnel.trainingStarted / totalStarted) * 100) },
    { stage: 'Interview scheduled', count: funnel.invitedToSchedule, pct: Math.round((funnel.invitedToSchedule / totalStarted) * 100) },
    { stage: 'Meeting',            count: funnel.scheduled,         pct: Math.round((funnel.scheduled / totalStarted) * 100) },
    { stage: 'Hired',              count: hiredCount,               pct: Math.round((hiredCount / totalStarted) * 100) },
  ]

  const topSources = sources.slice(0, 5).map(s => ({
    source: s.source || 'direct',
    count: s.started,
    pct: Math.round((s.started / totalStarted) * 100),
  }))

  const activeSince = firstAd?.createdAt ? Math.max(0, Math.floor((Date.now() - firstAd.createdAt.getTime()) / (24 * 3600_000))) : null

  return NextResponse.json({
    position: {
      slug: positionSlug,
      label: isUnassigned ? 'Unassigned' : positionSlug,
      isActive: true,
      hiringManager: 'You',
      activeSinceDays: activeSince,
    },
    summary: {
      totalApplicants: sessionCount,
      activeCandidates: activeCount,
      startedThisWeek,
      avgDaysToHire,
    },
    pipelinePerformance: pipelinePerf,
    topSources,
    ads,
    recentCandidates: recent.map(s => ({
      id: s.id,
      name: s.candidateName || 'Anonymous',
      email: s.candidateEmail,
      status: s.status || 'active',
      pipelineStatus: s.pipelineStatus,
      flowName: s.flow?.name ?? null,
      lastActivityAt: (s.lastActivityAt || s.startedAt).toISOString(),
    })),
  })
}
