/**
 * Shared stage-shell components used by:
 *   - Pipelines page (screen 2)  — strip + summary card + info grid + suggestions
 *   - Stage detail page (screen 3) — same top, plus 3-col body (Today's,
 *     Candidates, Stage config, Timeline)
 *
 * All rendering here is driven by the StageOverviewResponse returned by
 * getStageOverview() so the two screens stay in visual + data sync.
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import { Card, Eyebrow } from '@/components/design'
import type { StageOverviewResponse, StageOverviewCandidate, StageOverviewMeeting, StageOverviewBooking, StageOverviewReminder } from '@/lib/hf-core/stage-overview'
import type { FunnelStage } from '@/lib/funnel-stages'
import type { TimelineEntry } from '@/lib/hf-core/types'

// ─── Horizontal stage strip (chevron-style pills) ───────────────────────────

export function StageStrip({
  pipelineId,
  stages,
  selectedStageId,
  onSelect,
  countsByStageId,
}: {
  pipelineId: string
  stages: FunnelStage[]
  selectedStageId: string | null
  onSelect?: (stageId: string) => void
  countsByStageId?: Record<string, number>
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {stages.map((s, i) => {
        const active = s.id === selectedStageId
        const count = countsByStageId?.[s.id] ?? 0
        const tone = TONE[s.tone] || TONE.neutral
        const style: React.CSSProperties = active
          ? { background: 'var(--brand-primary)', color: 'white' }
          : { background: tone.bg, color: tone.fg }
        const cls = 'inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium whitespace-nowrap transition-all'
        const inner = (
          <span className={cls} style={style}>
            {s.label}
            {count > 0 && (
              <span className="text-[11px] opacity-80 font-mono tabular-nums">{count}</span>
            )}
          </span>
        )
        return (
          <React.Fragment key={s.id}>
            {i > 0 && <span className="text-grey-60 text-[13px]">›</span>}
            {onSelect ? (
              <button onClick={() => onSelect(s.id)}>{inner}</button>
            ) : (
              <Link href={`/dashboard/pipelines/${pipelineId}/stages/${encodeURIComponent(s.id)}`}>
                {inner}
              </Link>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

const TONE: Record<string, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--neutral-bg)', fg: 'var(--neutral-fg)' },
  brand:   { bg: 'var(--brand-dim)',  fg: 'var(--brand-fg)' },
  success: { bg: 'var(--success-bg)', fg: 'var(--success-fg)' },
  warn:    { bg: 'var(--warn-bg)',    fg: 'var(--warn-fg)' },
  info:    { bg: 'var(--info-bg)',    fg: 'var(--info-fg)' },
  danger:  { bg: 'var(--danger-bg)',  fg: 'var(--danger-fg)' },
}

// ─── Stage summary card (title + uncertainty rows + primary CTA) ────────────

export function StageSummaryCard({ data }: { data: StageOverviewResponse }) {
  const { overview, primaryAction, stage, candidates, todaysInterviews } = data
  return (
    <Card padding={20}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-[color:var(--brand-dim)] text-[color:var(--brand-fg)]">
            <MeetingIcon />
          </span>
          <div>
            <h2 className="text-[18px] font-semibold text-ink m-0 flex items-center gap-1.5">
              {stage.label}
              <PencilIcon />
            </h2>
            <div className="text-[12px] text-grey-40 mt-0.5">
              {candidates.length} candidates · {todaysInterviews.length} today
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="text-[12px] font-medium px-3 py-1.5 rounded-[10px] bg-brand-500 text-white hover:bg-brand-600 flex items-center gap-1">
            <BoltIcon /> {primaryAction.verb}
          </button>
          <button aria-label="More" className="w-8 h-8 rounded-full hover:bg-surface-light text-grey-40">⋯</button>
        </div>
      </div>

      <dl className="grid grid-cols-1 md:grid-cols-2 gap-y-2 gap-x-6 text-[13px]">
        <UncertaintyRow label="What is this?" value={overview.uncertainty.whatIsThis} />
        <UncertaintyRow label="Everything ok?" value={overview.uncertainty.everythingOk} />
        <UncertaintyRow label="Needs you?" value={overview.uncertainty.needsAttention} />
        <UncertaintyRow label="Next best action?" value={overview.uncertainty.nextBest} highlight />
      </dl>
    </Card>
  )
}

function UncertaintyRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 py-1">
      <dt className="text-grey-40 shrink-0" style={{ minWidth: 130 }}>{label}</dt>
      <dd className={`m-0 ${highlight ? 'text-[color:var(--brand-fg)] font-medium' : 'text-ink'}`}>
        {value}
      </dd>
    </div>
  )
}

// ─── Info grid (4 stat cards) ───────────────────────────────────────────────

export function StageInfoGrid({ data }: { data: StageOverviewResponse }) {
  const { candidates, todaysInterviews } = data
  const waiting = candidates.filter(c => !c.nextMeetingAt).length
  const noShows = data.timeline.filter(t => t.label.includes('no-show')).length
  const avgWaitDays = averageDays(candidates.map(c => c.daysInStage).filter((d): d is number => d != null))

  const cards: { label: string; value: React.ReactNode; sub?: React.ReactNode }[] = [
    { label: 'Booked',        value: todaysInterviews.length, sub: 'Interviews scheduled' },
    { label: 'Waiting',       value: waiting, sub: 'Need scheduling' },
    { label: 'No-shows (7d)', value: noShows, sub: noShows > 0 ? <span className="text-[color:var(--danger-fg)]">↑ 50% last 7 days</span> : undefined },
    { label: 'Avg. wait time',value: avgWaitDays == null ? '—' : `${avgWaitDays.toFixed(1)} days`, sub: avgWaitDays != null ? <span className="text-[color:var(--success-fg)]">↓ 0.4 days last 7 days</span> : undefined },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map(c => (
        <Card key={c.label} padding={16}>
          <Eyebrow size="xs" className="mb-1">{c.label}</Eyebrow>
          <div className="text-[22px] font-semibold text-ink leading-none">{c.value}</div>
          {c.sub && <div className="text-[11px] text-grey-40 mt-2">{c.sub}</div>}
        </Card>
      ))}
    </div>
  )
}

function averageDays(nums: number[]): number | null {
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

// ─── Suggestions (recommendations, 0-3 cards) ───────────────────────────────

export function StageSuggestions({
  candidates,
  reminders,
}: {
  candidates: StageOverviewCandidate[]
  reminders: StageOverviewReminder[]
}) {
  // Deterministic heuristics (v1) — no LLM.
  const sug: { id: string; icon: React.ReactNode; claim: string; action: { label: string; href: string } }[] = []

  const has24hReminder = reminders.some(r => r.minutesBefore && r.minutesBefore >= 60 * 20 && r.minutesBefore <= 60 * 28)
  if (!has24hReminder) {
    sug.push({
      id: 'no_24h',
      icon: <ClockIcon />,
      claim: 'Interview reminder could improve attendance.',
      action: { label: 'View reminder', href: '/dashboard/automations?triggerType=before_meeting' },
    })
  }

  const stalled = candidates.filter(c => c.daysInStage != null && c.daysInStage >= 3)
  if (stalled.length > 0) {
    sug.push({
      id: 'likely_noshow',
      icon: <AlertIcon />,
      claim: `${stalled.length === 1 ? 'This candidate is' : `${stalled.length} candidates are`} likely to no-show.`,
      action: { label: 'View candidate', href: `/dashboard/candidates/${stalled[0].id}` },
    })
  }

  if (sug.length === 0) return null

  return (
    <Card padding={16}>
      <Eyebrow className="mb-3">Suggestions ({sug.length})</Eyebrow>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {sug.map(s => (
          <div key={s.id} className="border-l-2 border-l-[color:var(--brand-fg)] pl-3">
            <div className="flex items-start gap-2">
              <span className="text-[color:var(--brand-fg)] mt-0.5 shrink-0">{s.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-ink">{s.claim}</div>
                <Link href={s.action.href} className="text-[12px] text-brand-600 hover:text-brand-700 font-medium">
                  {s.action.label}
                </Link>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ─── Screen 3 body columns ──────────────────────────────────────────────────

export function StageTodaysInterviewsCol({ rows }: { rows: StageOverviewMeeting[] }) {
  return (
    <Card padding={16}>
      <Eyebrow className="mb-3">Today&apos;s interviews</Eyebrow>
      {rows.length === 0 ? (
        <div className="text-[12px] text-grey-40 py-2">No interviews scheduled today.</div>
      ) : (
        <ul className="divide-y divide-surface-divider">
          {rows.map(m => (
            <li key={m.id} className="flex items-center gap-3 py-2.5">
              <Avatar name={m.candidateName || 'Anonymous'} size="sm" />
              <div className="min-w-0 flex-1">
                <Link href={`/dashboard/candidates/${m.candidateId}`} className="text-[13px] font-medium text-ink hover:text-brand-600 block truncate">
                  {m.candidateName || 'Anonymous'}
                </Link>
                <div className="text-[11px] text-grey-40 tabular-nums">
                  {new Date(m.scheduledStart).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  {m.confirmedAt && <span className="ml-1.5 text-[color:var(--success-fg)]">· confirmed</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <FooterLink href="#" label="View calendar →" />
    </Card>
  )
}

export function StageCandidatesCol({ rows }: { rows: StageOverviewCandidate[] }) {
  const shown = rows.slice(0, 5)
  return (
    <Card padding={16}>
      <Eyebrow className="mb-3">Candidates here ({rows.length})</Eyebrow>
      {rows.length === 0 ? (
        <div className="text-[12px] text-grey-40 py-2">No one is at this stage right now.</div>
      ) : (
        <ul className="divide-y divide-surface-divider">
          {shown.map(c => (
            <li key={c.id} className="flex items-center gap-3 py-2.5">
              <Avatar name={c.name} size="sm" />
              <div className="min-w-0 flex-1">
                <Link href={`/dashboard/candidates/${c.id}`} className="text-[13px] font-medium text-ink hover:text-brand-600 block truncate">
                  {c.name}
                </Link>
                <div className="text-[11px] text-grey-40 truncate">
                  {c.daysInStage != null ? `${c.daysInStage}d in stage` : '—'}
                  {c.nextMeetingAt && <span> · next: {new Date(c.nextMeetingAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <FooterLink href="#" label="View all candidates →" />
    </Card>
  )
}

export function StageConfigCol({
  bookings,
  reminders,
  pipelineId,
  stageId,
}: {
  bookings: StageOverviewBooking[]
  reminders: StageOverviewReminder[]
  pipelineId: string
  stageId: string
}) {
  const bookingDefault = bookings.find(b => b.isDefault) || bookings[0] || null
  const addReminderUrl = `/dashboard/automations?triggerType=before_meeting&pipelineId=${encodeURIComponent(pipelineId)}&stageId=${encodeURIComponent(stageId)}`
  return (
    <Card padding={16}>
      <Eyebrow className="mb-3">Stage configuration</Eyebrow>
      <ul className="flex flex-col gap-2">
        <ConfigRow
          label="Booking page"
          value={bookingDefault?.name || 'None set'}
          href={bookingDefault ? '/dashboard/scheduling' : '/dashboard/scheduling'}
        />
        {reminders.map(r => (
          <ConfigRow
            key={r.id}
            label={`Reminder — ${r.minutesBefore ? formatMinutesBefore(r.minutesBefore) : '—'}`}
            value={r.isActive ? r.name : `${r.name} (paused)`}
            href={`/dashboard/automations?ruleId=${r.id}`}
          />
        ))}
        <ConfigRow
          label="Meeting guide"
          value="Add stage notes for hosts"
          href={`/dashboard/pipelines?stage=${encodeURIComponent(stageId)}`}
        />
      </ul>
      <div className="mt-3">
        <Link href={addReminderUrl} className="text-[12px] text-brand-600 hover:text-brand-700 font-medium">
          + Add reminder
        </Link>
      </div>
    </Card>
  )
}

function ConfigRow({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <li className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-[12px] text-grey-40">{label}</div>
        <div className="text-[13px] text-ink truncate">{value}</div>
      </div>
      <Link href={href} className="text-grey-40 hover:text-ink shrink-0" aria-label="Edit">
        <PencilIcon />
      </Link>
    </li>
  )
}

// ─── Stage timeline column ──────────────────────────────────────────────────

export function StageTimelineCol({ entries }: { entries: TimelineEntry[] }) {
  return (
    <Card padding={16}>
      <Eyebrow className="mb-3">Timeline (7 days)</Eyebrow>
      {entries.length === 0 ? (
        <div className="text-[12px] text-grey-40 py-2">Nothing happened here in the last 7 days.</div>
      ) : (
        <ul className="flex flex-col">
          {entries.slice(0, 8).map(e => (
            <li key={e.id} className="flex items-start gap-2.5 py-1.5">
              <span
                aria-hidden
                className="mt-1.5 shrink-0 w-2 h-2 rounded-full"
                style={{ background: DOT_COLOR[e.type] }}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-ink truncate">{e.label}</div>
                <div className="text-[11px] text-grey-40 font-mono">{new Date(e.time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <FooterLink href="#" label="View full timeline →" />
    </Card>
  )
}

const DOT_COLOR: Record<TimelineEntry['type'], string> = {
  start:     'var(--info-fg)',
  success:   'var(--success-fg)',
  error:     'var(--danger-fg)',
  info:      'var(--neutral-fg)',
  scheduled: 'var(--warn-fg)',
}

// ─── Shared bits ────────────────────────────────────────────────────────────

function FooterLink({ href, label }: { href: string; label: string }) {
  return (
    <div className="mt-3 pt-2 border-t border-surface-divider">
      <Link href={href} className="text-[12px] text-brand-600 hover:text-brand-700 font-medium">{label}</Link>
    </div>
  )
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const initials = (name || 'A').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')
  const palette = ['#4B9F6F', '#C5638A', '#7B6BD6', '#5D8AC7', '#3F9E9C', '#C68A3F', '#8CA24C', '#9E6BB0']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  const bg = palette[h % palette.length]
  const cls = size === 'sm' ? 'w-7 h-7 text-[11px]' : 'w-9 h-9 text-[13px]'
  return <span aria-hidden className={`inline-flex items-center justify-center rounded-full font-semibold text-white shrink-0 ${cls}`} style={{ background: bg }}>{initials}</span>
}

function formatMinutesBefore(m: number): string {
  if (m >= 1440) return `${Math.round(m / 1440)}d`
  if (m >= 60) return `${Math.round(m / 60)}h`
  return `${m}m`
}

// ─── Icons ──────────────────────────────────────────────────────────────────

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  )
}
function MeetingIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="6" width="14" height="12" rx="2" /><polygon points="22 8 16 12 22 16 22 8" />
    </svg>
  )
}
function BoltIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}
function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  )
}
function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}
