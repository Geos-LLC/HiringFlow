/**
 * GET /api/hf/trainings-hub
 *
 * Powers the /dashboard/trainings hub (Design/6-training-automation.png).
 * Aggregates programs, completion stats, currently-training candidates, and
 * top automation rules in one round-trip.
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const now = Date.now()
  const startOfWeek = new Date(now - 7 * 24 * 3600_000)

  const [trainings, automations, activeEnrollments, weekCompletions, allCompletions] = await Promise.all([
    prisma.training.findMany({
      where: { workspaceId: ws.workspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, title: true, slug: true, isPublished: true, accessMode: true,
        sections: { select: { id: true } },
        _count: { select: { enrollments: true } },
      },
    }),
    prisma.automationRule.findMany({
      where: { workspaceId: ws.workspaceId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      select: { id: true, name: true, triggerType: true, isActive: true, channel: true },
    }),
    prisma.trainingEnrollment.findMany({
      where: {
        training: { workspaceId: ws.workspaceId },
        status: { in: ['not_started', 'in_progress'] },
        sessionId: { not: null },
      },
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: {
        id: true, status: true, startedAt: true, progress: true,
        training: { select: { id: true, title: true, sections: { select: { id: true } } } },
        session: {
          select: {
            id: true, candidateName: true,
            ad: { select: { targetPosition: true } },
          },
        },
      },
    }),
    prisma.trainingEnrollment.count({
      where: {
        training: { workspaceId: ws.workspaceId },
        completedAt: { gte: startOfWeek },
      },
    }),
    prisma.trainingEnrollment.findMany({
      where: {
        training: { workspaceId: ws.workspaceId },
        completedAt: { not: null },
      },
      select: {
        completedAt: true, startedAt: true, trainingId: true,
      },
      take: 500,
    }),
  ])

  // Per-training completion stats
  const perTraining = new Map<string, { completions: number; totalDays: number }>()
  for (const c of allCompletions) {
    if (!c.completedAt) continue
    const days = Math.max(0, (c.completedAt.getTime() - c.startedAt.getTime()) / (24 * 3600_000))
    const cur = perTraining.get(c.trainingId) || { completions: 0, totalDays: 0 }
    cur.completions += 1
    cur.totalDays += days
    perTraining.set(c.trainingId, cur)
  }

  const programs = trainings.map(t => {
    const stats = perTraining.get(t.id) || { completions: 0, totalDays: 0 }
    const total = t._count.enrollments
    const rate = total > 0 ? Math.round((stats.completions / total) * 100) : 0
    const avgDays = stats.completions > 0 ? stats.totalDays / stats.completions : null
    return {
      id: t.id,
      title: t.title,
      slug: t.slug,
      isPublished: t.isPublished,
      required: t.accessMode === 'invitation_only',
      sectionCount: t.sections.length,
      enrollmentCount: total,
      completionCount: stats.completions,
      completionRatePct: rate,
      avgDaysToComplete: avgDays,
    }
  })

  // Progress % helper — sections done / total sections
  const rowsInTraining = activeEnrollments.filter(e => e.session).map(e => {
    const totalSections = e.training.sections.length || 1
    const done = ((e.progress as { completedSections?: unknown } | null)?.completedSections as string[] | undefined)?.length ?? 0
    const pct = Math.min(100, Math.round((done / totalSections) * 100))
    return {
      enrollmentId: e.id,
      candidateId: e.session!.id,
      candidateName: e.session!.candidateName || 'Anonymous',
      positionLabel: e.session!.ad?.targetPosition ?? null,
      trainingId: e.training.id,
      trainingTitle: e.training.title,
      progressPct: pct,
      status: e.status,
      startedAt: e.startedAt.toISOString(),
    }
  })

  // Summary stats
  const activeInTraining = rowsInTraining.length
  const totalCompletions = allCompletions.length
  const totalStarted = programs.reduce((a, p) => a + p.enrollmentCount, 0)
  const avgCompletion = totalCompletions > 0
    ? (allCompletions.reduce((a, c) => a + (c.completedAt ? (c.completedAt.getTime() - c.startedAt.getTime()) / (24 * 3600_000) : 0), 0) / totalCompletions)
    : null
  const completionRatePct = totalStarted > 0 ? Math.round((totalCompletions / totalStarted) * 100) : 0

  return NextResponse.json({
    summary: {
      candidatesInTraining: activeInTraining,
      completedThisWeek: weekCompletions,
      avgCompletionDays: avgCompletion,
      completionRatePct,
    },
    programs,
    candidatesInTraining: rowsInTraining,
    automations: automations.map(a => ({
      id: a.id,
      name: a.name,
      triggerType: a.triggerType,
      isActive: a.isActive,
      channel: a.channel,
    })),
  })
}
