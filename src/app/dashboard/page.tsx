/**
 * Home — the alive dashboard.
 *
 * Layout (matches Design/1-home.png):
 *
 *   Header: greeting + subtitle + date pill
 *   Top row: 4 icon summary cards
 *   Middle row: Today's interviews (2/3) + Needs attention (1/3)
 *   Bottom row: Recent replies · New applicants · Just finished training (3-col)
 *
 * Uses the existing top-nav layout (no sidebar). Data comes from
 * /api/hf/home → getHomeData(). No new schema; everything is derived
 * from tables that already exist.
 */

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import type { HomeResponse, HomeInterviewRow, HomeNeedsAttentionRow, HomeReplyRow, HomeApplicantRow, HomeFinishedTrainingRow } from '@/lib/hf-core/home-data'

export default function HomePage() {
  const { data: session } = useSession()
  const [data, setData] = useState<HomeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/api/hf/home')
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const firstName = friendlyName(session?.user?.name || session?.user?.email || null)
  const dateStr = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px] font-semibold text-ink leading-tight tracking-tight2 m-0">
            {greeting()}{firstName ? `, ${firstName}` : ''}! <span aria-hidden>👋</span>
          </h1>
          <div className="text-[14px] text-grey-40 mt-1">Here&apos;s what needs your attention today.</div>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-surface-border bg-white px-3 py-1.5 text-[12px] text-grey-35">
          <CalendarSmallIcon /> {dateStr}
        </span>
      </header>

      {loading && <div className="text-grey-40 text-sm">Loading…</div>}
      {error && <div className="text-red-600 text-sm">{error}</div>}

      {data && (
        <>
          <SummaryRow summary={data.summary} />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2"><TodaysInterviews rows={data.todaysInterviews} /></div>
            <div><NeedsAttention rows={data.needsAttention} /></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <RecentReplies rows={data.recentReplies} />
            <NewApplicants rows={data.newApplicants} />
            <JustFinishedTraining rows={data.justFinishedTraining} />
          </div>
        </>
      )}
    </div>
  )
}

// ─── Summary row ────────────────────────────────────────────────────────────

function SummaryRow({ summary }: { summary: HomeResponse['summary'] }) {
  const cards = [
    { label: 'Interviews today', value: summary.interviewsToday, href: '/dashboard/scheduling', icon: <CalendarIcon />,   ring: 'bg-[#E6EFF8] text-[color:var(--info-fg)]' },
    { label: 'New applicants',    value: summary.newApplicants24h, href: '/dashboard/candidates',  icon: <UserPlusIcon />,  ring: 'bg-[#FFF3DF] text-[color:var(--brand-fg)]' },
    { label: 'Waiting for review',value: summary.waiting, href: '/dashboard/candidates?candidateStatus=waiting,stalled', icon: <ClockIcon />, ring: 'bg-[#FEF2D0] text-[color:var(--warn-fg)]' },
    { label: 'No-show (24h)',     value: summary.noShows24h, href: '/dashboard/candidates?candidateStatus=lost', icon: <AlertIcon />, ring: 'bg-[#FDE4E1] text-[color:var(--danger-fg)]' },
  ]
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map(c => (
        <Link key={c.label} href={c.href} className="group">
          <div className="bg-white border border-surface-border rounded-[14px] p-4 flex items-center gap-3 hover:border-grey-60 transition-colors">
            <span className={`inline-flex items-center justify-center w-10 h-10 rounded-full ${c.ring}`}>{c.icon}</span>
            <div>
              <div className="text-[20px] font-semibold text-ink leading-none tabular-nums">{c.value}</div>
              <div className="text-[12px] text-grey-40 mt-1">{c.label}</div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}

// ─── Today's interviews ─────────────────────────────────────────────────────

function TodaysInterviews({ rows }: { rows: HomeInterviewRow[] }) {
  return (
    <Panel title="Today's interviews" count={rows.length} empty={rows.length === 0 && 'No interviews scheduled today.'}>
      <ul className="divide-y divide-surface-divider">
        {rows.map(r => {
          const joinable = r.minutesFromNow >= -30 && r.minutesFromNow <= 15 && !!r.meetingUri
          const time = new Date(r.scheduledStart).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          return (
            <li key={r.meetingId} className="flex items-center gap-3 py-3">
              <Avatar name={r.candidateName} />
              <div className="min-w-0 flex-1">
                <Link href={`/dashboard/candidates/${r.candidateId}`} className="text-[14px] font-medium text-ink hover:text-brand-600 block">
                  {r.candidateName}
                </Link>
                <div className="text-[12px] text-grey-40 flex items-center gap-2 flex-wrap">
                  <span className="tabular-nums">{time}</span>
                  {r.meetingUri && <span className="truncate text-grey-50">{shortMeetLink(r.meetingUri)}</span>}
                  {r.confirmedAt && <span className="text-[color:var(--success-fg)]">· confirmed</span>}
                </div>
              </div>
              {r.meetingUri && (
                <a href={r.meetingUri} target="_blank" rel="noreferrer">
                  <button className={`text-[12px] font-medium px-3 py-1.5 rounded-[10px] ${joinable ? 'bg-brand-500 text-white hover:bg-brand-600' : 'border border-surface-border text-ink hover:bg-surface-light'}`}>
                    {joinable ? 'Join' : 'Open'}
                  </button>
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

// ─── Needs attention ────────────────────────────────────────────────────────

function NeedsAttention({ rows }: { rows: HomeNeedsAttentionRow[] }) {
  const shown = rows.slice(0, 4)
  return (
    <Panel title="Needs attention" count={rows.length} empty={rows.length === 0 && 'Nothing needs you right now.'} footer={rows.length > shown.length ? { label: `View all (${rows.length}) →`, href: '/dashboard/candidates?candidateStatus=waiting,stalled' } : undefined}>
      <ul className="divide-y divide-surface-divider">
        {shown.map(r => (
          <li key={r.candidateId} className="flex items-center gap-3 py-3">
            <Avatar name={r.candidateName} />
            <div className="min-w-0 flex-1">
              <Link href={`/dashboard/candidates/${r.candidateId}`} className="text-[14px] font-medium text-ink hover:text-brand-600 block">
                {r.candidateName}
              </Link>
              <div className="text-[12px] text-grey-40 truncate">
                <span className="text-grey-35">{r.reason.split('—')[0].trim()}</span>
                {r.positionLabel && <span> · {r.positionLabel}</span>}
              </div>
            </div>
            <Link href={r.actionHref}>
              <button className="text-[12px] font-medium px-3 py-1.5 rounded-[10px] bg-brand-500 text-white hover:bg-brand-600">
                {r.actionLabel}
              </button>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

// ─── Bottom 3-col strip ─────────────────────────────────────────────────────

function RecentReplies({ rows }: { rows: HomeReplyRow[] }) {
  const shown = rows.slice(0, 4)
  return (
    <Panel title="Recent replies" count={rows.length} empty={rows.length === 0 && 'No SMS replies yet.'} footer={rows.length > shown.length ? { label: 'View all replies →', href: '/dashboard/candidates' } : undefined}>
      <ul className="divide-y divide-surface-divider">
        {shown.map(r => (
          <li key={`${r.candidateId}_${r.at}`} className="flex items-center gap-3 py-2.5">
            <Avatar name={r.candidateName} size="sm" />
            <div className="min-w-0 flex-1">
              <Link href={`/dashboard/candidates/${r.candidateId}`} className="text-[13px] font-medium text-ink hover:text-brand-600 block truncate">
                {r.candidateName}
              </Link>
              <div className="text-[11px] text-grey-40 truncate">
                <span className={r.kind === 'confirmed' ? 'text-[color:var(--success-fg)]' : 'text-[color:var(--danger-fg)]'}>
                  {r.kind === 'confirmed' ? 'Confirmed' : 'Cancelled'}
                </span>
                {r.positionLabel && <span className="text-grey-50"> · {r.positionLabel}</span>}
              </div>
            </div>
            <TimeAgo iso={r.at} />
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function NewApplicants({ rows }: { rows: HomeApplicantRow[] }) {
  const shown = rows.slice(0, 4)
  return (
    <Panel title="New applicants" count={rows.length} empty={rows.length === 0 && 'No new applicants today.'} footer={rows.length > shown.length ? { label: 'View all applicants →', href: '/dashboard/candidates' } : undefined}>
      <ul className="divide-y divide-surface-divider">
        {shown.map(r => (
          <li key={r.candidateId} className="flex items-center gap-3 py-2.5">
            <Avatar name={r.candidateName} size="sm" />
            <div className="min-w-0 flex-1">
              <Link href={`/dashboard/candidates/${r.candidateId}`} className="text-[13px] font-medium text-ink hover:text-brand-600 block truncate">
                {r.candidateName}
              </Link>
              <div className="text-[11px] text-grey-40 truncate">
                {r.positionLabel || r.source || 'Applicant'}
              </div>
            </div>
            <TimeAgo iso={r.startedAt} />
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function JustFinishedTraining({ rows }: { rows: HomeFinishedTrainingRow[] }) {
  const shown = rows.slice(0, 4)
  return (
    <Panel title="Just finished training" count={rows.length} empty={rows.length === 0 && 'No training completions yet.'} footer={rows.length > shown.length ? { label: 'View all →', href: '/dashboard/candidates' } : undefined}>
      <ul className="divide-y divide-surface-divider">
        {shown.map(r => (
          <li key={`${r.candidateId}_${r.completedAt}`} className="flex items-center gap-3 py-2.5">
            <Avatar name={r.candidateName} size="sm" />
            <div className="min-w-0 flex-1">
              <Link href={`/dashboard/candidates/${r.candidateId}`} className="text-[13px] font-medium text-ink hover:text-brand-600 block truncate">
                {r.candidateName}
              </Link>
              <div className="text-[11px] text-grey-40 truncate">
                {r.positionLabel || r.trainingTitle}
              </div>
            </div>
            <TimeAgo iso={r.completedAt} />
          </li>
        ))}
      </ul>
    </Panel>
  )
}

// ─── Shared bits ────────────────────────────────────────────────────────────

function Panel({
  title, count, children, empty, footer,
}: {
  title: string
  count?: number
  children: React.ReactNode
  empty?: string | false
  footer?: { label: string; href: string }
}) {
  return (
    <div className="bg-white border border-surface-border rounded-[14px]">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-[14px] font-semibold text-ink m-0 flex items-center gap-2">
          {title}
          {typeof count === 'number' && count > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-surface-weak text-[11px] font-medium text-grey-35 tabular-nums">
              {count}
            </span>
          )}
        </h2>
      </header>
      <div className="px-4">
        {empty ? <div className="text-[13px] text-grey-40 py-4">{empty}</div> : children}
      </div>
      {footer && (
        <div className="border-t border-surface-divider px-4 py-2.5">
          <Link href={footer.href} className="text-[12px] text-brand-600 hover:text-brand-700 font-medium">
            {footer.label}
          </Link>
        </div>
      )}
    </div>
  )
}

function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const initials = (name || 'A')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0]!.toUpperCase()).join('')
  const bg = avatarBg(name)
  const cls = size === 'sm' ? 'w-7 h-7 text-[11px]' : 'w-8 h-8 text-[12px]'
  return (
    <span
      aria-hidden
      className={`inline-flex items-center justify-center rounded-full font-semibold text-white shrink-0 ${cls}`}
      style={{ background: bg }}
    >
      {initials}
    </span>
  )
}

function avatarBg(name: string): string {
  // Deterministic pastel-ish palette from name hash. Matches the mock's
  // varied avatar colors (green / pink / purple / blue / teal).
  const palette = ['#4B9F6F', '#C5638A', '#7B6BD6', '#5D8AC7', '#3F9E9C', '#C68A3F', '#8CA24C', '#9E6BB0']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function TimeAgo({ iso }: { iso: string }) {
  const ms = Date.now() - new Date(iso).getTime()
  const label = ms < 60_000 ? 'now'
    : ms < 3600_000 ? `${Math.floor(ms / 60_000)}m ago`
    : ms < 86_400_000 ? `${Math.floor(ms / 3600_000)}h ago`
    : `${Math.floor(ms / 86_400_000)}d ago`
  return (
    <span className="text-[11px] text-grey-50 font-mono tabular-nums shrink-0" style={{ letterSpacing: '0.02em' }}>
      {label}
    </span>
  )
}

function shortMeetLink(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '').split('?')[0]
}

// ─── Icons (top row) ────────────────────────────────────────────────────────

function CalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}
function UserPlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="20" y1="8" x2="20" y2="14" />
      <line x1="23" y1="11" x2="17" y2="11" />
    </svg>
  )
}
function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}
function AlertIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}
function CalendarSmallIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5)  return 'Good night'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function friendlyName(full: string | null): string | null {
  if (!full) return null
  if (full.includes('@')) {
    const local = full.split('@')[0].split('.')[0]
    return local.charAt(0).toUpperCase() + local.slice(1)
  }
  return full.split(/\s+/)[0]
}
