/**
 * Home page data assembler.
 *
 * Powers the alive Home surface (§4 of the vision). Everything a recruiter
 * needs to triage at 9am, all pulled from existing tables so no schema
 * change is required.
 *
 * Sections:
 *   - todaySummary    counts for the "Today" strip
 *   - todaysInterviews  live meeting list
 *   - needsAttention  candidates awaiting a recruiter decision
 *   - newApplicants   last 24h applications
 *   - recentActivity  workspace-wide timeline (14d, capped)
 *
 * Called from GET /api/hf/home; auth applied at the route.
 */

import { prisma } from '@/lib/prisma'
import type { TimelineEntry } from './types'

export interface HomeSummary {
  interviewsToday: number
  newApplicants24h: number
  waiting: number
  noShows24h: number
}

export interface HomeInterviewRow {
  meetingId: string
  candidateId: string
  candidateName: string
  positionLabel: string | null
  scheduledStart: string
  scheduledEnd: string
  meetingUri: string | null
  confirmedAt: string | null
  minutesFromNow: number
}

export interface HomeNeedsAttentionRow {
  candidateId: string
  candidateName: string
  reason: string
  actionLabel: string
  actionHref: string
  positionLabel: string | null
}

export interface HomeApplicantRow {
  candidateId: string
  candidateName: string
  positionLabel: string | null
  source: string | null
  startedAt: string
}

// Recent replies = candidate SMS confirms / cancels received through Sigcore.
// v1 shows only the two kinds we actually process (metadata.source ===
// 'candidate_sms'); anything else is silently ignored today. If we ever
// persist non-keyword replies we can add a `text` field here.
export interface HomeReplyRow {
  candidateId: string
  candidateName: string
  positionLabel: string | null
  kind: 'confirmed' | 'cancelled'
  at: string
}

export interface HomeFinishedTrainingRow {
  candidateId: string
  candidateName: string
  positionLabel: string | null
  trainingTitle: string
  completedAt: string
}

export interface HomeResponse {
  summary: HomeSummary
  todaysInterviews: HomeInterviewRow[]
  nextInterview: HomeInterviewRow | null
  needsAttention: HomeNeedsAttentionRow[]
  newApplicants: HomeApplicantRow[]
  recentReplies: HomeReplyRow[]
  justFinishedTraining: HomeFinishedTrainingRow[]
  recentActivity: TimelineEntry[]
}

export async function getHomeData(opts: {
  workspaceId: string
}): Promise<HomeResponse> {
  const { workspaceId } = opts
  const now = new Date()
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0)
  const endOfToday   = new Date(now); endOfToday.setHours(23, 59, 59, 999)
  const yesterday    = new Date(now.getTime() - 24 * 3600_000)
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 3600_000)

  // ── Today's interviews ────────────────────────────────────────────────────
  const meetingRows = await prisma.interviewMeeting.findMany({
    where: {
      workspaceId,
      scheduledStart: { gte: startOfToday, lte: endOfToday },
    },
    orderBy: { scheduledStart: 'asc' },
    select: {
      id: true, sessionId: true, scheduledStart: true, scheduledEnd: true,
      meetingUri: true, confirmedAt: true,
      session: {
        select: {
          candidateName: true,
          ad: { select: { targetPosition: true } },
        },
      },
    },
  })
  const todaysInterviews: HomeInterviewRow[] = meetingRows.map(m => ({
    meetingId: m.id,
    candidateId: m.sessionId,
    candidateName: m.session.candidateName || 'Anonymous',
    positionLabel: m.session.ad?.targetPosition ?? null,
    scheduledStart: m.scheduledStart.toISOString(),
    scheduledEnd: m.scheduledEnd.toISOString(),
    meetingUri: m.meetingUri,
    confirmedAt: m.confirmedAt?.toISOString() ?? null,
    minutesFromNow: Math.round((m.scheduledStart.getTime() - now.getTime()) / 60_000),
  }))

  // Next up = the earliest future one (or the currently-happening one)
  const nextInterview = todaysInterviews.find(m => m.minutesFromNow >= -30) || null

  // ── New applicants (last 24h) ─────────────────────────────────────────────
  const applicantSessions = await prisma.session.findMany({
    where: {
      workspaceId,
      startedAt: { gte: yesterday },
    },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      candidateName: true,
      source: true,
      startedAt: true,
      ad: { select: { targetPosition: true } },
    },
  })
  const newApplicants: HomeApplicantRow[] = applicantSessions.map(s => ({
    candidateId: s.id,
    candidateName: s.candidateName || 'Anonymous',
    positionLabel: s.ad?.targetPosition ?? null,
    source: s.source,
    startedAt: s.startedAt.toISOString(),
  }))

  // ── Needs attention ───────────────────────────────────────────────────────
  // 1) Finished flow, passed, no decision recorded (still 'active')
  // 2) Finished training, no meeting scheduled
  // 3) Meeting no-show yesterday, still lost/rejected
  const needs: HomeNeedsAttentionRow[] = []

  const passedNoDecision = await prisma.session.findMany({
    where: {
      workspaceId,
      finishedAt: { not: null, gte: fourteenDaysAgo },
      outcome: 'passed',
      status: 'active',
      pipelineStatus: { in: ['passed', 'completed_flow', 'in_progress'] },
    },
    orderBy: { finishedAt: 'desc' },
    take: 25,
    select: {
      id: true, candidateName: true,
      ad: { select: { targetPosition: true } },
    },
  })
  passedNoDecision.forEach(s => {
    needs.push({
      candidateId: s.id,
      candidateName: s.candidateName || 'Anonymous',
      reason: 'Passed application — decision pending',
      actionLabel: 'Review',
      actionHref: `/dashboard/candidates/${s.id}`,
      positionLabel: s.ad?.targetPosition ?? null,
    })
  })

  const finishedTrainingNoMeeting = await prisma.session.findMany({
    where: {
      workspaceId,
      status: 'active',
      trainingEnrollments: {
        some: { completedAt: { not: null, gte: fourteenDaysAgo } },
      },
      interviewMeetings: { none: {} },
    },
    orderBy: { lastActivityAt: 'desc' },
    take: 25,
    select: {
      id: true, candidateName: true,
      ad: { select: { targetPosition: true } },
    },
  })
  finishedTrainingNoMeeting.forEach(s => {
    needs.push({
      candidateId: s.id,
      candidateName: s.candidateName || 'Anonymous',
      reason: 'Finished training — no interview scheduled',
      actionLabel: 'Schedule',
      actionHref: `/dashboard/candidates/${s.id}`,
      positionLabel: s.ad?.targetPosition ?? null,
    })
  })

  // Deduplicate on candidateId (a session can hit multiple rules)
  const seen = new Set<string>()
  const needsAttention = needs.filter(n => {
    if (seen.has(n.candidateId)) return false
    seen.add(n.candidateId); return true
  }).slice(0, 15)

  // ── Summary counts ────────────────────────────────────────────────────────
  const [waitingCount, noShows24h] = await Promise.all([
    prisma.session.count({
      where: {
        workspaceId,
        status: { in: ['waiting', 'stalled'] },
      },
    }),
    prisma.schedulingEvent.count({
      where: {
        session: { workspaceId },
        eventType: 'meeting_no_show',
        eventAt: { gte: yesterday },
      },
    }),
  ])

  const summary: HomeSummary = {
    interviewsToday: todaysInterviews.length,
    newApplicants24h: newApplicants.length,
    waiting: waitingCount,
    noShows24h,
  }

  // ── Recent activity (workspace-wide, 14d, capped 40 rows) ────────────────
  const [recentSchedulingEvents, recentSessions, recentExecs] = await Promise.all([
    prisma.schedulingEvent.findMany({
      where: {
        session: { workspaceId },
        eventAt: { gte: fourteenDaysAgo },
      },
      orderBy: { eventAt: 'desc' },
      take: 30,
      select: {
        id: true, eventType: true, eventAt: true, sessionId: true,
        session: { select: { candidateName: true } },
      },
    }),
    prisma.session.findMany({
      where: {
        workspaceId,
        finishedAt: { not: null, gte: fourteenDaysAgo },
      },
      orderBy: { finishedAt: 'desc' },
      take: 20,
      select: { id: true, candidateName: true, outcome: true, finishedAt: true },
    }),
    prisma.automationExecution.findMany({
      where: {
        automationRule: { workspaceId },
        status: { in: ['sent', 'failed'] },
        createdAt: { gte: fourteenDaysAgo },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true, status: true, sessionId: true, channel: true,
        sentAt: true, createdAt: true,
        automationRule: { select: { name: true } },
      },
    }),
  ])

  const activity: TimelineEntry[] = []
  recentSchedulingEvents.forEach(e => {
    activity.push({
      id: `se_${e.id}`,
      label: `${labelSchedulingEvent(e.eventType)} — ${e.session.candidateName || 'Anonymous'}`,
      time: e.eventAt.toISOString(),
      type: schedulingEventType(e.eventType),
      href: `/dashboard/candidates/${e.sessionId}`,
    })
  })
  recentSessions.forEach(s => {
    if (!s.finishedAt) return
    activity.push({
      id: `sf_${s.id}`,
      label: `Flow ${s.outcome || 'completed'} — ${s.candidateName || 'Anonymous'}`,
      time: s.finishedAt.toISOString(),
      type: s.outcome === 'passed' ? 'success' : s.outcome === 'failed' ? 'error' : 'info',
      href: `/dashboard/candidates/${s.id}`,
    })
  })
  recentExecs.forEach(e => {
    activity.push({
      id: `ae_${e.id}`,
      label: `${e.automationRule.name} ${e.status === 'sent' ? 'sent' : 'failed'}${e.channel === 'sms' ? ' (SMS)' : ''}`,
      time: (e.sentAt || e.createdAt).toISOString(),
      type: e.status === 'sent' ? 'success' : 'error',
      href: e.sessionId ? `/dashboard/candidates/${e.sessionId}` : undefined,
    })
  })
  activity.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
  const recentActivity = activity.slice(0, 40)

  // ── Recent replies (candidate SMS confirms / cancels, last 7d) ────────────
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600_000)
  const replyRows = await prisma.schedulingEvent.findMany({
    where: {
      session: { workspaceId },
      eventType: { in: ['meeting_confirmed', 'meeting_cancelled'] },
      eventAt: { gte: sevenDaysAgo },
    },
    orderBy: { eventAt: 'desc' },
    take: 40,
    select: {
      id: true, eventType: true, eventAt: true, sessionId: true, metadata: true,
      session: {
        select: {
          candidateName: true,
          ad: { select: { targetPosition: true } },
        },
      },
    },
  })
  // Only surface events the candidate themselves triggered via SMS reply —
  // recruiter-initiated cancels (calendar delete) shouldn't feel like a
  // candidate "reply" on the home surface.
  const recentReplies: HomeReplyRow[] = replyRows
    .filter(e => {
      const meta = e.metadata as Record<string, unknown> | null
      return meta?.source === 'candidate_sms'
    })
    .map(e => ({
      candidateId: e.sessionId,
      candidateName: e.session.candidateName || 'Anonymous',
      positionLabel: e.session.ad?.targetPosition ?? null,
      kind: (e.eventType === 'meeting_confirmed' ? 'confirmed' : 'cancelled') as 'confirmed' | 'cancelled',
      at: e.eventAt.toISOString(),
    }))
    .slice(0, 15)

  // ── Just finished training (last 7d) ──────────────────────────────────────
  const enrollmentRows = await prisma.trainingEnrollment.findMany({
    where: {
      session: { workspaceId },
      completedAt: { not: null, gte: sevenDaysAgo },
    },
    orderBy: { completedAt: 'desc' },
    take: 15,
    select: {
      id: true, completedAt: true, sessionId: true,
      training: { select: { title: true } },
      session: {
        select: {
          candidateName: true,
          ad: { select: { targetPosition: true } },
        },
      },
    },
  })
  const justFinishedTraining: HomeFinishedTrainingRow[] = enrollmentRows
    .filter(e => e.sessionId && e.session)
    .map(e => ({
      candidateId: e.sessionId!,
      candidateName: e.session!.candidateName || 'Anonymous',
      positionLabel: e.session!.ad?.targetPosition ?? null,
      trainingTitle: e.training.title,
      completedAt: e.completedAt!.toISOString(),
    }))

  return {
    summary,
    todaysInterviews,
    nextInterview,
    needsAttention,
    newApplicants,
    recentReplies,
    justFinishedTraining,
    recentActivity,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function labelSchedulingEvent(type: string): string {
  const labels: Record<string, string> = {
    invite_sent:         'Scheduling invite sent',
    link_clicked:        'Scheduling link clicked',
    marked_scheduled:    'Marked as scheduled',
    meeting_scheduled:   'Meeting scheduled',
    meeting_rescheduled: 'Meeting rescheduled',
    meeting_cancelled:   'Meeting cancelled',
    meeting_confirmed:   'Meeting confirmed via SMS',
    meeting_no_show:     'Meeting no-show',
    nudge_sent:          'Nudge sent',
    message_sent:        'Message sent',
  }
  return labels[type] || type
}

function schedulingEventType(type: string): TimelineEntry['type'] {
  if (['meeting_cancelled', 'meeting_no_show'].includes(type)) return 'error'
  if (['marked_scheduled', 'meeting_scheduled', 'meeting_rescheduled', 'meeting_confirmed'].includes(type)) return 'success'
  return 'info'
}
