/**
 * Candidate timeline adapter.
 *
 * Pure function: given a loaded CandidateDetail payload, return the ordered
 * list of TimelineEntry rows the `<Timeline>` primitive expects.
 *
 * Extracted from src/app/dashboard/candidates/[id]/page.tsx so any surface
 * (candidate detail, position candidate list, home Latest activity) can
 * render the same entries with the same fidelity — including the synthetic
 * "waiting for candidate to X" / "candidate didn't X" deadline rows that
 * aren't stored in any table.
 *
 * Zero regression is the acceptance test: the candidate detail Timeline tab
 * before and after this extraction should render identical rows.
 */

import type { TimelineEntry } from '@/lib/hf-core/types'
import type { CandidateStatus, CandidateDispositionReason } from '@/lib/candidate-status'
import { DISPOSITION_DISPLAY, DEFAULT_TIMEOUTS } from '@/lib/candidate-status'

// ─── Input shape (mirrors src/app/dashboard/candidates/[id]/page.tsx) ───────

export interface CandidateTimelineTraining {
  id: string
  status: string
  startedAt: string
  completedAt: string | null
  progress: {
    completedSections?: string[]
    quizScores?: { sectionId: string; score: number }[]
    sectionTimestamps?: Record<string, string>
  } | null
  training: {
    id: string
    title: string
    sections?: { id: string; title: string; sortOrder: number; kind: string }[]
  }
}

export interface CandidateTimelineSchedulingEvent {
  id: string
  eventType: string
  eventAt: string
  metadata: Record<string, any> | null
}

export interface CandidateTimelineAutomationExec {
  id: string
  status: string
  errorMessage: string | null
  skipReason: string | null
  sentAt: string | null
  scheduledFor: string | null
  createdAt: string
  channel: string
  deliveryStatus: string | null
  deliveryStatusAt: string | null
  deliveryErrorMessage: string | null
  automationRule: {
    id: string
    name: string
    triggerType: string
    chainedBy: { id: string; name: string; steps: { delayMinutes: number }[] }[]
  }
  step: {
    id: string
    order: number
    channel: string
    delayMinutes: number
    timingMode: string | null
    nextStepType: string | null
    emailDestination: string
    emailDestinationAddress: string | null
    training: { title: string; slug: string } | null
    schedulingConfig: { name: string; schedulingUrl: string } | null
    emailTemplate: { name: string; subject: string } | null
  } | null
}

export interface CandidateTimelineInput {
  startedAt: string
  finishedAt: string | null
  outcome: string | null
  status: CandidateStatus | null
  dispositionReason: CandidateDispositionReason | null
  stalledAt: string | null
  flow: {
    schedulingTimeoutHours?: number | null
    trainingTimeoutDays?: number | null
    backgroundCheckTimeoutDays?: number | null
  } | null
  trainingEnrollments: CandidateTimelineTraining[]
  schedulingEvents: CandidateTimelineSchedulingEvent[]
  automationExecutions?: CandidateTimelineAutomationExec[]
  interviewMeetings?: { id: string; createdAt: string }[]
  backgroundChecks?: { id: string; status: string; overallScore: string | null; createdAt: string }[]
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export function buildCandidateTimeline(c: CandidateTimelineInput): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let nextId = 0
  const add = (partial: Omit<TimelineEntry, 'id'>) =>
    entries.push({ id: `ct_${nextId++}`, ...partial })

  add({ label: 'Applied / Flow started', time: c.startedAt, type: 'start' })

  if (c.finishedAt) {
    add({
      label: `Flow ${c.outcome || 'completed'}`,
      time: c.finishedAt,
      type: c.outcome === 'passed' ? 'success' : c.outcome === 'failed' ? 'error' : 'info',
    })
  }

  if (c.stalledAt) {
    const reasonLabel = c.dispositionReason
      ? (DISPOSITION_DISPLAY[c.dispositionReason] || c.dispositionReason)
      : null
    add({
      label: 'Candidate became stale — no forward progress',
      detail: reasonLabel ? `Reason: ${reasonLabel}` : undefined,
      time: c.stalledAt,
      type: 'error',
    })
  }

  c.trainingEnrollments.forEach(e => {
    add({ label: `Training started: ${e.training.title}`, time: e.startedAt, type: 'info' })
    const stamps = e.progress?.sectionTimestamps || {}
    const sections = e.training.sections || []
    const sectionById = new Map(sections.map(s => [s.id, s] as const))
    for (const [sectionId, at] of Object.entries(stamps)) {
      const section = sectionById.get(sectionId)
      if (!section) continue
      add({
        label: `Training section completed: ${section.title}`,
        detail: e.training.title,
        time: at,
        type: 'info',
      })
    }
    if (e.completedAt) {
      add({ label: `Training completed: ${e.training.title}`, time: e.completedAt, type: 'success' })
    }
  })

  c.schedulingEvents.forEach(e => {
    const labels: Record<string, string> = {
      invite_sent: 'Scheduling invite sent',
      link_clicked: 'Scheduling link clicked',
      marked_scheduled: 'Marked as scheduled',
      meeting_scheduled: 'Meeting scheduled',
      meeting_rescheduled: 'Meeting rescheduled',
      meeting_cancelled: 'Meeting cancelled',
      meeting_confirmed: 'Candidate confirmed via SMS',
      meeting_no_show: 'Candidate no-show',
      nudge_sent: 'Manual "join now" nudge sent',
      message_sent: 'Message sent',
    }
    const successTypes = new Set([
      'marked_scheduled', 'meeting_scheduled', 'meeting_rescheduled',
      'meeting_confirmed', 'nudge_sent', 'message_sent',
    ])
    const errorTypes = new Set(['meeting_cancelled', 'meeting_no_show'])
    const type: TimelineEntry['type'] = errorTypes.has(e.eventType) ? 'error' : successTypes.has(e.eventType) ? 'success' : 'info'
    const meta = e.metadata || {}
    const bits: string[] = []
    if (meta.scheduledAt) bits.push(`When: ${new Date(meta.scheduledAt).toLocaleString()}`)
    if (meta.meetingUrl) bits.push(`Link: ${meta.meetingUrl}`)
    if (meta.notes) bits.push(`Notes: ${meta.notes}`)
    if (e.eventType === 'nudge_sent') {
      const channels: string[] = []
      if (meta.emailOk) channels.push('email')
      if (meta.smsOk) channels.push('SMS')
      if (channels.length > 0) bits.push(`Channels: ${channels.join(' + ')}`)
    }
    add({
      label: labels[e.eventType] || e.eventType,
      time: e.eventAt,
      type,
      detail: bits.join(' · ') || undefined,
    })
  })

  ;(c.automationExecutions || []).forEach(e => {
    const r = e.automationRule
    const s = e.step
    const destLabel = s?.emailDestination === 'company' ? 'Company'
      : s?.emailDestination === 'specific' ? (s?.emailDestinationAddress || 'Specific')
      : 'Applicant'
    const chainSummary = (ch: { name: string; steps: { delayMinutes: number }[] }) => {
      const firstDelay = ch.steps[0]?.delayMinutes ?? 0
      return ch.name + (firstDelay ? ` (+${firstDelay}m)` : '')
    }
    const nextStep = s?.nextStepType === 'training' && s?.training ? `Training — ${s.training.title}`
      : s?.nextStepType === 'scheduling' && s?.schedulingConfig ? `Scheduling — ${s.schedulingConfig.name}`
      : r.chainedBy.length > 0 ? `Chains to → ${r.chainedBy.map(chainSummary).join(', ')}`
      : s?.nextStepType === 'email' ? 'Send email only'
      : 'No follow-up'
    const stepDelay = s?.delayMinutes ?? 0
    const delayStr = stepDelay > 0
      ? (stepDelay >= 1440 ? `${Math.round(stepDelay / 1440)}d`
         : stepDelay >= 60 ? `${Math.round(stepDelay / 60)}h`
         : `${stepDelay}m`)
      : null
    const sentChannel = e.channel || s?.channel || 'email'
    const channelLabel = sentChannel === 'sms' ? 'SMS' : 'Email'
    const bits = [
      `Channel: ${channelLabel}`,
      sentChannel === 'email' ? `To: ${destLabel}` : null,
      sentChannel === 'email' && s?.emailTemplate ? `Template: ${s.emailTemplate.name}` : null,
      `Next step: ${nextStep}`,
      delayStr ? `Delay: ${delayStr}` : null,
      s && s.order > 0 ? `Step ${s.order + 1}` : null,
    ].filter(Boolean).join(' · ')
    const base = `Automation: ${r.name}`
    const sendVerb = sentChannel === 'sms' ? 'SMS sent' : 'email sent'

    const deliveryBadge = sentChannel === 'email' && e.status === 'sent'
      ? {
          status: normalizeDeliveryStatus(e.deliveryStatus),
          at: e.deliveryStatusAt || undefined,
          error: e.deliveryErrorMessage || undefined,
        }
      : undefined

    if (e.status === 'sent') {
      add({
        label: `${base} — ${sendVerb}`,
        detail: bits,
        time: e.sentAt || e.createdAt,
        type: 'success',
        delivery: deliveryBadge,
      })
    } else if (e.status === 'failed') {
      add({
        label: `${base} — failed${e.errorMessage ? `: ${e.errorMessage}` : ''}`,
        detail: bits,
        time: e.createdAt,
        type: 'error',
      })
    } else if (e.status === 'queued' && e.scheduledFor) {
      add({
        label: `${base} — scheduled`,
        detail: `${bits} · Fires at ${new Date(e.scheduledFor).toLocaleString()}`,
        time: e.scheduledFor,
        type: 'scheduled',
      })
    } else if (e.status === 'cancelled') {
      add({
        label: `${base} — cancelled${e.errorMessage ? `: ${e.errorMessage}` : ''}`,
        detail: bits,
        time: e.createdAt,
        type: 'info',
      })
    } else if (e.status?.startsWith('skipped_')) {
      const reasonLabel = e.skipReason
        ? e.skipReason.replace(/^skipped_/, '').replace(/_/g, ' ')
        : 'skipped'
      add({
        label: `${base} — skipped (${reasonLabel})`,
        detail: bits,
        time: e.createdAt,
        type: 'error',
      })
    } else {
      add({ label: `${base} — pending`, detail: bits, time: e.createdAt, type: 'info' })
    }
  })

  // Synthetic candidate-step entries — waiting / didn't do X within timeout.
  const nowMs = Date.now()
  const schedulingHours = c.flow?.schedulingTimeoutHours ?? DEFAULT_TIMEOUTS.schedulingTimeoutHours
  const trainingDays = c.flow?.trainingTimeoutDays ?? DEFAULT_TIMEOUTS.trainingTimeoutDays
  const bgCheckDays = c.flow?.backgroundCheckTimeoutDays ?? DEFAULT_TIMEOUTS.backgroundCheckTimeoutDays

  const fmtRemaining = (msUntil: number) => {
    const h = Math.round(msUntil / 3600_000)
    if (h >= 24) return `${Math.round(h / 24)}d`
    if (h >= 1) return `${h}h`
    const m = Math.max(1, Math.round(msUntil / 60_000))
    return `${m}m`
  }

  ;(c.automationExecutions || [])
    .filter(e => e.status === 'sent' && e.sentAt && e.step?.nextStepType)
    .filter(e => {
      const tm = e.step?.timingMode
      return tm !== 'before_meeting' && tm !== 'after_meeting'
    })
    .forEach(e => {
      const nextType = e.step!.nextStepType!
      const sentAt = new Date(e.sentAt!).getTime()
      let label = ''
      let deadlineMs = 0
      let completed = false

      if (nextType === 'scheduling') {
        label = 'book a meeting'
        deadlineMs = sentAt + schedulingHours * 3600_000
        completed = (c.interviewMeetings ?? []).length > 0
          || c.schedulingEvents.some(ev => ev.eventType === 'meeting_scheduled')
      } else if (nextType === 'training') {
        label = 'open training'
        deadlineMs = sentAt + trainingDays * 86400_000
        completed = c.trainingEnrollments.some(en => en.status !== 'not_started' && new Date(en.startedAt).getTime() >= sentAt)
      } else if (nextType === 'background_check') {
        label = 'complete background check'
        deadlineMs = sentAt + bgCheckDays * 86400_000
        completed = (c.backgroundChecks ?? []).some(bc => bc.overallScore !== null && new Date(bc.createdAt).getTime() >= sentAt)
      } else {
        return
      }

      if (completed) return

      const detail = `Automation: ${e.automationRule.name}`
      if (nowMs > deadlineMs) {
        add({
          label: `Candidate didn't ${label}`,
          detail: `${detail} · Expected within ${nextType === 'scheduling' ? `${schedulingHours}h` : nextType === 'training' ? `${trainingDays}d` : `${bgCheckDays}d`} of send`,
          time: new Date(deadlineMs).toISOString(),
          type: 'error',
        })
      } else {
        add({
          label: `Waiting for candidate to ${label}`,
          detail: `${detail} · Expires in ${fmtRemaining(deadlineMs - nowMs)}`,
          time: new Date(deadlineMs).toISOString(),
          type: 'info',
        })
      }
    })

  entries.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
  return entries
}

// Existing candidate page uses `'bounce'`; canonical enum is `'bounced'`.
function normalizeDeliveryStatus(v: string | null): NonNullable<TimelineEntry['delivery']>['status'] {
  if (!v) return 'pending'
  if (v === 'bounce') return 'bounced'
  const known: Array<NonNullable<TimelineEntry['delivery']>['status']> = [
    'pending', 'processed', 'delivered', 'deferred', 'bounced', 'dropped', 'blocked', 'failed',
  ]
  return (known as string[]).includes(v) ? (v as any) : 'pending'
}
