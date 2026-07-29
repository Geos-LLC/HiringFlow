/**
 * Stage panel components — the plugins referenced by StagePanel ids.
 *
 * Each panel is small, focused, self-hiding when empty (per UX rule #2
 * "empty state or hide the panel"). They accept only the slice of the
 * StageOverviewResponse they need — no direct fetching from panels.
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import { Card, Eyebrow, Badge, Button } from '@/components/design'
import type {
  StageOverviewCandidate,
  StageOverviewMeeting,
  StageOverviewBooking,
  StageOverviewReminder,
} from '@/lib/hf-core/stage-overview'

// ─── Candidates here ────────────────────────────────────────────────────────

export function StageCandidatesPanel({ candidates }: { candidates: StageOverviewCandidate[] }) {
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <Eyebrow>Candidates here ({candidates.length})</Eyebrow>
      </div>
      {candidates.length === 0 ? (
        <div className="text-[13px] text-grey-40">No one is at this stage right now.</div>
      ) : (
        <ul className="divide-y divide-surface-divider">
          {candidates.slice(0, 25).map(c => (
            <li key={c.id} className="py-2">
              <Link href={`/dashboard/candidates/${c.id}`} className="flex items-center justify-between gap-3 group">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink group-hover:text-brand-600">{c.name}</div>
                  <div className="text-[11px] text-grey-40">
                    {[
                      c.email,
                      c.daysInStage != null ? `${c.daysInStage}d in stage` : null,
                      c.nextMeetingAt ? `Next: ${new Date(c.nextMeetingAt).toLocaleString()}` : null,
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <StatusChip status={c.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 25 && (
        <div className="text-[11px] text-grey-40 mt-3">Showing first 25 of {candidates.length}.</div>
      )}
    </Card>
  )
}

function StatusChip({ status }: { status: string }) {
  const tone = status === 'hired' ? 'success' : status === 'lost' ? 'danger' : status === 'stalled' ? 'warn' : status === 'waiting' ? 'info' : 'neutral'
  return <Badge tone={tone as any}>{status}</Badge>
}

// ─── Today's interviews ─────────────────────────────────────────────────────

export function StageTodaysInterviewsPanel({ interviews }: { interviews: StageOverviewMeeting[] }) {
  if (interviews.length === 0) {
    return (
      <Card>
        <Eyebrow className="mb-2">Today&apos;s interviews</Eyebrow>
        <div className="text-[13px] text-grey-40">No interviews scheduled today.</div>
      </Card>
    )
  }
  const nowMs = Date.now()
  return (
    <Card>
      <Eyebrow className="mb-3">Today&apos;s interviews ({interviews.length})</Eyebrow>
      <ul className="divide-y divide-surface-divider">
        {interviews.map(m => {
          const startMs = new Date(m.scheduledStart).getTime()
          const minsFromNow = Math.round((startMs - nowMs) / 60000)
          const joinable = minsFromNow >= -30 && minsFromNow <= 15 && !!m.meetingUri
          return (
            <li key={m.id} className="py-2 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <Link href={`/dashboard/candidates/${m.candidateId}`} className="text-[13px] font-medium text-ink hover:text-brand-600">
                  {m.candidateName || 'Anonymous'}
                </Link>
                <div className="text-[11px] text-grey-40">
                  {new Date(m.scheduledStart).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  {' – '}
                  {new Date(m.scheduledEnd).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  {m.confirmedAt && <span className="ml-2 text-[color:var(--success-fg)]">· confirmed</span>}
                </div>
              </div>
              {m.meetingUri && (
                <a href={m.meetingUri} target="_blank" rel="noreferrer">
                  <Button size="sm" variant={joinable ? 'primary' : 'secondary'}>{joinable ? 'Join' : 'Link'}</Button>
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

// ─── Booking pages ──────────────────────────────────────────────────────────

export function StageBookingPanel({ bookings }: { bookings: StageOverviewBooking[] }) {
  if (bookings.length === 0) {
    return (
      <Card>
        <div className="flex items-center justify-between mb-2">
          <Eyebrow>Booking page</Eyebrow>
          <Link href="/dashboard/scheduling"><Button size="sm" variant="secondary">Create booking page</Button></Link>
        </div>
        <div className="text-[13px] text-grey-40">
          No booking page set. Candidates have no way to schedule from this stage.
        </div>
      </Card>
    )
  }
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <Eyebrow>Booking pages ({bookings.length})</Eyebrow>
        <Link href="/dashboard/scheduling"><Button size="sm" variant="ghost">Manage →</Button></Link>
      </div>
      <ul className="divide-y divide-surface-divider">
        {bookings.slice(0, 5).map(b => (
          <li key={b.id} className="py-2 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-ink">
                {b.name}
                {b.isDefault && <Badge tone="brand" className="ml-2">Default</Badge>}
              </div>
              <div className="text-[11px] text-grey-40 truncate">
                {b.provider} · {b.assignedMemberIds.length} host{b.assignedMemberIds.length === 1 ? '' : 's'}
                {b.schedulingUrl && <span> · {b.schedulingUrl}</span>}
              </div>
            </div>
            <Link href="/dashboard/scheduling"><Button size="sm" variant="ghost">Edit</Button></Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ─── Reminders (before_meeting automations) ────────────────────────────────

export function StageRemindersPanel({
  reminders,
  pipelineId,
  stageId,
}: {
  reminders: StageOverviewReminder[]
  pipelineId: string
  stageId: string
}) {
  const addUrl = `/dashboard/automations?triggerType=before_meeting&pipelineId=${encodeURIComponent(pipelineId)}&stageId=${encodeURIComponent(stageId)}`
  if (reminders.length === 0) {
    return (
      <Card>
        <div className="flex items-center justify-between mb-2">
          <Eyebrow>Reminders</Eyebrow>
          <Link href={addUrl}><Button size="sm" variant="secondary">Add reminder</Button></Link>
        </div>
        <div className="text-[13px] text-grey-40">
          No reminders configured. Candidates get no nudge before their interview.
        </div>
      </Card>
    )
  }
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <Eyebrow>Reminders ({reminders.length})</Eyebrow>
        <Link href={addUrl}><Button size="sm" variant="ghost">Add →</Button></Link>
      </div>
      <ul className="divide-y divide-surface-divider">
        {reminders.map(r => (
          <li key={r.id} className="py-2 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-ink flex items-center gap-2">
                {r.name}
                {!r.isActive && <Badge tone="neutral">Paused</Badge>}
              </div>
              <div className="text-[11px] text-grey-40">
                {r.minutesBefore != null ? formatMinutesBefore(r.minutesBefore) : 'No offset set'}
                {' · '}
                {r.channel === 'both' ? 'Email + SMS' : r.channel === 'sms' ? 'SMS' : 'Email'}
                {' · '}
                {r.stepCount} step{r.stepCount === 1 ? '' : 's'}
              </div>
            </div>
            <Link href={`/dashboard/automations?ruleId=${r.id}`}><Button size="sm" variant="ghost">Edit</Button></Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function formatMinutesBefore(m: number): string {
  if (m >= 1440) return `${Math.round(m / 1440)}d before`
  if (m >= 60) return `${Math.round(m / 60)}h before`
  return `${m}m before`
}
