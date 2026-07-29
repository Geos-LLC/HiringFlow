/**
 * Home — the alive dashboard.
 *
 * A recruiter's 9am triage surface. Answers "what needs me right now?" with
 * people, not metrics. See §4 of the UX vision.
 *
 * Sections (top to bottom):
 *   Good morning strip → Today summary → Next up → Needs attention →
 *   New applicants → Latest activity
 *
 * All data is workspace-scoped and comes from the /api/hf/home endpoint
 * (getHomeData in src/lib/hf-core/home-data.ts). No new schema; every row
 * is derived from existing tables.
 */

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { Card, Eyebrow, Button } from '@/components/design'
import { Timeline } from '@/components/hf'
import type { HomeResponse } from '@/lib/hf-core/home-data'

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
  const dateStr = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[28px] font-semibold text-ink leading-none tracking-tight2 m-0">
            {greeting()}{firstName ? `, ${firstName}` : ''}
          </h1>
          <div className="text-[13px] text-grey-40 mt-1.5">{dateStr}</div>
        </div>
      </header>

      {loading && <div className="text-grey-40 text-sm">Loading…</div>}
      {error && <div className="text-red-600 text-sm">{error}</div>}

      {data && (
        <>
          <TodaySummary summary={data.summary} />
          <NextUp interview={data.nextInterview} />
          <NeedsAttention rows={data.needsAttention} />
          <NewApplicants rows={data.newApplicants} />
          <LatestActivity entries={data.recentActivity} />
        </>
      )}
    </div>
  )
}

// ─── Sections ───────────────────────────────────────────────────────────────

function TodaySummary({ summary }: { summary: HomeResponse['summary'] }) {
  const cards: { label: string; value: number; href: string; tone: string }[] = [
    { label: 'Interviews today', value: summary.interviewsToday, href: '/dashboard/scheduling', tone: 'brand' },
    { label: 'New applicants',   value: summary.newApplicants24h, href: '/dashboard/candidates', tone: 'info' },
    { label: 'Waiting',          value: summary.waiting, href: '/dashboard/candidates?candidateStatus=waiting,stalled', tone: 'warn' },
    { label: 'No-shows 24h',     value: summary.noShows24h, href: '/dashboard/candidates?candidateStatus=lost', tone: 'danger' },
  ]

  const total = cards.reduce((a, c) => a + c.value, 0)
  if (total === 0) {
    return (
      <Card>
        <Eyebrow className="mb-2">Today</Eyebrow>
        <div className="text-[15px] text-ink font-medium">Clear day.</div>
        <div className="text-[13px] text-grey-40">No interviews, no applicants, no waiting candidates.</div>
      </Card>
    )
  }
  return (
    <div>
      <Eyebrow className="mb-2">Today</Eyebrow>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map(c => (
          <Link key={c.label} href={c.href}>
            <Card padding={16} className="hover:border-brand-500 transition-colors cursor-pointer">
              <div className="font-mono text-[10px] uppercase text-grey-40" style={{ letterSpacing: '0.1em' }}>{c.label}</div>
              <div className="text-[26px] font-semibold text-ink mt-1 leading-none">{c.value}</div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}

function NextUp({ interview }: { interview: HomeResponse['nextInterview'] }) {
  if (!interview) return null
  const mins = interview.minutesFromNow
  const when = mins < 0 ? `${Math.abs(mins)} min ago` : mins < 60 ? `in ${mins} min` : new Date(interview.scheduledStart).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const joinable = mins >= -30 && mins <= 15 && !!interview.meetingUri
  return (
    <div>
      <Eyebrow className="mb-2">Next up</Eyebrow>
      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <Link href={`/dashboard/candidates/${interview.candidateId}`} className="text-[16px] font-semibold text-ink hover:text-brand-600">
              {interview.candidateName}
            </Link>
            <div className="text-[12px] text-grey-40 mt-0.5">
              {when} {interview.confirmedAt && <span className="ml-2 text-[color:var(--success-fg)]">· confirmed</span>}
            </div>
          </div>
          {interview.meetingUri && (
            <a href={interview.meetingUri} target="_blank" rel="noreferrer">
              <Button variant={joinable ? 'primary' : 'secondary'}>{joinable ? 'Join' : 'Open link'}</Button>
            </a>
          )}
        </div>
      </Card>
    </div>
  )
}

function NeedsAttention({ rows }: { rows: HomeResponse['needsAttention'] }) {
  if (rows.length === 0) return null
  return (
    <div>
      <Eyebrow className="mb-2">Needs attention ({rows.length})</Eyebrow>
      <Card padding={0}>
        <ul className="divide-y divide-surface-divider">
          {rows.map(r => (
            <li key={r.candidateId} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <Link href={`/dashboard/candidates/${r.candidateId}`} className="text-[14px] font-medium text-ink hover:text-brand-600">
                  {r.candidateName}
                </Link>
                <div className="text-[12px] text-grey-40 mt-0.5">
                  {r.reason}{r.positionLabel && <span> · {r.positionLabel}</span>}
                </div>
              </div>
              <Link href={r.actionHref}>
                <Button size="sm" variant="secondary">{r.actionLabel}</Button>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

function NewApplicants({ rows }: { rows: HomeResponse['newApplicants'] }) {
  if (rows.length === 0) return null
  return (
    <div>
      <Eyebrow className="mb-2">New applicants (last 24h)</Eyebrow>
      <Card padding={0}>
        <ul className="divide-y divide-surface-divider">
          {rows.slice(0, 8).map(r => (
            <li key={r.candidateId} className="flex items-center justify-between gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <Link href={`/dashboard/candidates/${r.candidateId}`} className="text-[13px] font-medium text-ink hover:text-brand-600">
                  {r.candidateName}
                </Link>
                <div className="text-[11px] text-grey-40 mt-0.5">
                  {[r.positionLabel, r.source].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="text-[11px] text-grey-40 shrink-0">{new Date(r.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
            </li>
          ))}
        </ul>
        {rows.length > 8 && (
          <div className="px-5 py-2 border-t border-surface-divider text-[11px]">
            <Link href="/dashboard/candidates" className="text-brand-600 hover:underline">See all {rows.length} →</Link>
          </div>
        )}
      </Card>
    </div>
  )
}

function LatestActivity({ entries }: { entries: HomeResponse['recentActivity'] }) {
  return (
    <div>
      <Card>
        <Timeline
          entries={entries}
          title="Latest activity"
          initial={15}
          emptyLabel="Nothing has happened yet this week."
        />
      </Card>
    </div>
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
  // If it's an email, use the local-part; otherwise, first word of the name.
  if (full.includes('@')) return full.split('@')[0].split('.')[0].charAt(0).toUpperCase() + full.split('@')[0].split('.')[0].slice(1)
  return full.split(/\s+/)[0]
}
