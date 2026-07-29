/**
 * Stage overview server helper.
 *
 * Assembles everything a Stage detail page needs — candidates in stage,
 * today's interviews, booking page, reminder automations, recent activity,
 * health, primary action — in one round-trip.
 *
 * Called from GET /api/hf/stages/[pipelineId]/[stageId]/overview. Pure query
 * layer: no writes, no side effects. Auth is applied at the route.
 */

import { prisma } from '@/lib/prisma'
import { normalizeStages, resolveStage, mapLegacyStatusToStageId, type FunnelStage } from '@/lib/funnel-stages'
import type { Health, HFOverview, PrimaryAction, TimelineEntry } from './types'
import { getStageType, type StageTypeId } from './stage-types'

export interface StageOverviewCandidate {
  id: string
  name: string
  email: string | null
  phone: string | null
  status: string
  enteredStageAt: string | null
  daysInStage: number | null
  nextMeetingAt: string | null
}

export interface StageOverviewBooking {
  id: string
  name: string
  provider: string
  schedulingUrl: string | null
  isDefault: boolean
  assignedMemberIds: string[]
}

export interface StageOverviewReminder {
  id: string
  name: string
  minutesBefore: number | null
  channel: string
  isActive: boolean
  stepCount: number
}

export interface StageOverviewMeeting {
  id: string
  candidateId: string
  candidateName: string | null
  scheduledStart: string
  scheduledEnd: string
  meetingUri: string | null
  confirmedAt: string | null
}

export interface StageOverviewResponse {
  stage: {
    id: string
    label: string
    color: string
    order: number
    typeId: StageTypeId
    typeLabel: string
    panels: string[]
  }
  pipeline: { id: string; name: string; stages: FunnelStage[] }
  overview: HFOverview
  primaryAction: PrimaryAction
  candidates: StageOverviewCandidate[]
  todaysInterviews: StageOverviewMeeting[]
  bookingPages: StageOverviewBooking[]
  reminders: StageOverviewReminder[]
  timeline: TimelineEntry[]
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function getStageOverview(opts: {
  workspaceId: string
  pipelineId: string
  stageId: string
}): Promise<StageOverviewResponse | null> {
  const { workspaceId, pipelineId, stageId } = opts

  const pipeline = await prisma.pipeline.findFirst({
    where: { id: pipelineId, workspaceId },
    select: { id: true, name: true, stages: true },
  })
  if (!pipeline) return null

  const stages = normalizeStages(pipeline.stages)
  const stage = stages.find(s => s.id === stageId) || null
  if (!stage) return null

  const stageType = inferStageTypeFromStage(stage)

  // ── Candidates in this stage ──────────────────────────────────────────────
  const legacyId = mapLegacyStatusToStageId(stage.id)
  const stagePipelineStatuses = Array.from(new Set([stage.id, legacyId].filter(Boolean)))

  const sessions = await prisma.session.findMany({
    where: {
      workspaceId,
      pipelineStatus: { in: stagePipelineStatuses },
    },
    orderBy: { lastActivityAt: 'desc' },
    take: 200,
    select: {
      id: true,
      candidateName: true,
      candidateEmail: true,
      candidatePhone: true,
      status: true,
      startedAt: true,
      lastActivityAt: true,
      interviewMeetings: {
        where: { scheduledStart: { gte: new Date() } },
        orderBy: { scheduledStart: 'asc' },
        take: 1,
        select: { scheduledStart: true },
      },
    },
  })

  const now = Date.now()
  const candidates: StageOverviewCandidate[] = sessions.map(s => {
    const entered = s.lastActivityAt || s.startedAt
    const enteredMs = entered ? new Date(entered).getTime() : null
    return {
      id: s.id,
      name: s.candidateName || 'Anonymous',
      email: s.candidateEmail,
      phone: s.candidatePhone,
      status: s.status || 'active',
      enteredStageAt: entered ? entered.toISOString() : null,
      daysInStage: enteredMs != null ? Math.max(0, Math.floor((now - enteredMs) / (24 * 3600_000))) : null,
      nextMeetingAt: s.interviewMeetings[0]?.scheduledStart?.toISOString() ?? null,
    }
  })

  // ── Today's interviews ────────────────────────────────────────────────────
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
  const endOfToday = new Date();   endOfToday.setHours(23, 59, 59, 999)

  const meetingRows = await prisma.interviewMeeting.findMany({
    where: {
      session: {
        workspaceId,
        pipelineStatus: { in: stagePipelineStatuses },
      },
      scheduledStart: { gte: startOfToday, lte: endOfToday },
    },
    orderBy: { scheduledStart: 'asc' },
    select: {
      id: true,
      sessionId: true,
      scheduledStart: true,
      scheduledEnd: true,
      meetingUri: true,
      confirmedAt: true,
      session: { select: { candidateName: true } },
    },
  })
  const todaysInterviews: StageOverviewMeeting[] = meetingRows.map(m => ({
    id: m.id,
    candidateId: m.sessionId,
    candidateName: m.session.candidateName,
    scheduledStart: m.scheduledStart.toISOString(),
    scheduledEnd: m.scheduledEnd.toISOString(),
    meetingUri: m.meetingUri,
    confirmedAt: m.confirmedAt?.toISOString() ?? null,
  }))

  // ── Booking pages (workspace-scoped; UI can filter for defaults) ──────────
  const bookingRows = await prisma.schedulingConfig.findMany({
    where: { workspaceId, isActive: true },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    take: 10,
    select: {
      id: true,
      name: true,
      provider: true,
      schedulingUrl: true,
      isDefault: true,
      assignedMemberIds: true,
    },
  })
  const bookingPages: StageOverviewBooking[] = bookingRows.map(b => ({
    id: b.id,
    name: b.name,
    provider: b.provider,
    schedulingUrl: b.schedulingUrl,
    isDefault: b.isDefault,
    assignedMemberIds: b.assignedMemberIds,
  }))

  // ── Reminder rules (before_meeting scoped to pipeline OR any) ─────────────
  const reminderRows = await prisma.automationRule.findMany({
    where: {
      workspaceId,
      triggerType: 'before_meeting',
      OR: [{ pipelineId: null }, { pipelineId }],
    },
    orderBy: [{ isActive: 'desc' }, { minutesBefore: 'asc' }],
    select: {
      id: true,
      name: true,
      minutesBefore: true,
      channel: true,
      isActive: true,
      steps: { select: { id: true } },
    },
  })
  const reminders: StageOverviewReminder[] = reminderRows.map(r => ({
    id: r.id,
    name: r.name,
    minutesBefore: r.minutesBefore,
    channel: r.channel,
    isActive: r.isActive,
    stepCount: r.steps.length,
  }))

  // ── Recent activity (7d) ──────────────────────────────────────────────────
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600_000)
  const sessionIds = sessions.map(s => s.id)

  const nameBySessionId = new Map<string, string | null>(sessions.map(s => [s.id, s.candidateName]))

  const [schedulingEvents, execRows] = sessionIds.length === 0 ? [[], []] : await Promise.all([
    prisma.schedulingEvent.findMany({
      where: { sessionId: { in: sessionIds }, eventAt: { gte: sevenDaysAgo } },
      orderBy: { eventAt: 'desc' },
      take: 80,
      select: { id: true, eventType: true, eventAt: true, sessionId: true },
    }),
    prisma.automationExecution.findMany({
      where: {
        sessionId: { in: sessionIds },
        createdAt: { gte: sevenDaysAgo },
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
      select: {
        id: true, status: true, channel: true, sessionId: true,
        sentAt: true, createdAt: true, errorMessage: true,
        automationRule: { select: { name: true } },
      },
    }),
  ])

  const timeline: TimelineEntry[] = []
  schedulingEvents.forEach(e => {
    const name = nameBySessionId.get(e.sessionId) || 'Anonymous'
    timeline.push({
      id: `se_${e.id}`,
      label: `${labelSchedulingEvent(e.eventType)} — ${name}`,
      time: e.eventAt.toISOString(),
      type: schedulingEventType(e.eventType),
      href: `/dashboard/candidates/${e.sessionId}`,
    })
  })
  execRows.forEach(e => {
    const at = (e.sentAt || e.createdAt).toISOString()
    const verb = e.status === 'sent' ? 'sent' : e.status === 'failed' ? 'failed' : e.status
    const name = e.sessionId ? nameBySessionId.get(e.sessionId) : null
    timeline.push({
      id: `ae_${e.id}`,
      label: `${e.automationRule.name} — ${verb}${e.channel === 'sms' ? ' (SMS)' : ''}`,
      detail: name || undefined,
      time: at,
      type: e.status === 'sent' ? 'success' : e.status === 'failed' ? 'error' : 'info',
      href: e.sessionId ? `/dashboard/candidates/${e.sessionId}` : undefined,
    })
  })
  timeline.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())

  // ── Health + primary action + uncertainty ─────────────────────────────────
  const waitingCount = candidates.filter(c => !c.nextMeetingAt && stage.id !== 'hired' && stage.id !== 'rejected').length
  const noShowCount = schedulingEvents.filter(e => e.eventType === 'meeting_no_show').length

  const health: Health = noShowCount >= 3
    ? { status: 'red', label: 'High no-show rate', detail: `${noShowCount} no-shows in last 7 days` }
    : waitingCount >= 5
      ? { status: 'yellow', label: 'Backlog forming', detail: `${waitingCount} candidates waiting` }
      : candidates.length === 0
        ? { status: 'unknown', label: 'No candidates', detail: 'Nothing has entered this stage yet' }
        : { status: 'green', label: 'On track' }

  const primaryAction: PrimaryAction = waitingCount > 0
    ? {
        verb: `Help ${waitingCount} waiting`,
        kind: 'help',
        target: { kind: 'callback', callbackId: 'help_waiting' },
      }
    : noShowCount > 0
      ? {
          verb: `Re-book ${noShowCount} no-show${noShowCount === 1 ? '' : 's'}`,
          kind: 'reactivate',
          target: { kind: 'callback', callbackId: 'rebook_noshows' },
        }
      : {
          verb: 'Configure stage',
          kind: 'configure',
          target: { kind: 'href', href: `/dashboard/pipelines?stage=${encodeURIComponent(stage.id)}` },
        }

  const overview: HFOverview = {
    title: stage.label,
    subtitle: `${stageType.label} stage · ${pipeline.name}`,
    health,
    uncertainty: {
      whatIsThis: `${stageType.label} stage of ${pipeline.name} pipeline.`,
      everythingOk: noShowCount > 0
        ? `${noShowCount} no-show${noShowCount === 1 ? '' : 's'} in last 7 days.`
        : candidates.length === 0
          ? 'No activity — nothing has entered this stage yet.'
          : 'On track.',
      needsAttention: waitingCount > 0
        ? `${waitingCount} candidate${waitingCount === 1 ? '' : 's'} waiting for next step.`
        : 'Nothing needs your attention right now.',
      nextBest: primaryAction.verb,
    },
    infoCards: [
      { label: 'In stage',        value: candidates.length, tone: 'neutral' },
      { label: 'Today',           value: todaysInterviews.length, tone: 'info' },
      { label: 'Waiting',         value: waitingCount, tone: waitingCount > 0 ? 'warn' : 'neutral' },
      { label: 'No-shows 7d',     value: noShowCount, tone: noShowCount > 0 ? 'danger' : 'neutral' },
    ],
  }

  return {
    stage: {
      id: stage.id,
      label: stage.label,
      color: stage.color,
      order: stage.order,
      typeId: stageType.id,
      typeLabel: stageType.label,
      panels: stageType.panels,
    },
    pipeline: { id: pipeline.id, name: pipeline.name, stages },
    overview,
    primaryAction,
    candidates,
    todaysInterviews,
    bookingPages,
    reminders,
    timeline,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function inferStageTypeFromStage(stage: FunnelStage) {
  // v1 heuristic — infer from stage label; when Pipeline schema gains a
  // typeId column we'll persist it and read it directly.
  const lower = stage.label.toLowerCase()
  if (/train/.test(lower)) return getStageType('training')
  if (/interview|meet|schedul|call/.test(lower)) return getStageType('interview')
  if (/apply|application|new|screen/.test(lower)) return getStageType('application')
  if (/trial|job/.test(lower)) return getStageType('trial_job')
  if (/offer|document|acceptance/.test(lower)) return getStageType('offer')
  if (/hire|reject|lost/.test(lower)) return getStageType('terminal')
  return getStageType('custom')
}

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
