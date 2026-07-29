/**
 * Position detail — matches Design/5-position.png.
 *
 * Layout:
 *   Breadcrumb strip
 *   Header: title + status pill + edit + orange "Hire candidate" CTA
 *   4 stat cards
 *   2-col body:
 *     LEFT (2/3): Pipeline performance chart · Top sources chart · Recent candidates
 *     RIGHT (1/3): Position details sidebar (metadata + docs)
 *
 * The Position-metadata sidebar (employment type, pay range, start date,
 * job description) is not yet in the schema; those fields render as
 * placeholders. The rest — candidates, pipeline funnel, sources — is
 * live workspace data pulled from analytics.
 */

'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Avatar } from '../../pipelines/_stage-shell'

interface PositionResponse {
  position: {
    slug: string; label: string; isActive: boolean
    hiringManager: string; activeSinceDays: number | null
  }
  summary: {
    totalApplicants: number; activeCandidates: number
    startedThisWeek: number; avgDaysToHire: number | null
  }
  pipelinePerformance: { stage: string; count: number; pct: number }[]
  topSources: { source: string; count: number; pct: number }[]
  ads: { id: string; name: string; source: string; createdAt: string }[]
  recentCandidates: {
    id: string; name: string; email: string | null; status: string
    pipelineStatus: string | null; flowName: string | null; lastActivityAt: string
  }[]
}

export default function PositionDetailPage() {
  const params = useParams()
  const position = params.position as string
  const [data, setData] = useState<PositionResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/hf/positions/${position}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [position])

  if (loading) return <div className="text-grey-40 text-sm">Loading position…</div>
  if (error || !data) {
    return (
      <div className="text-grey-40 text-sm">
        {error || 'Position not found.'}{' '}
        <Link href="/dashboard/positions" className="text-brand-600 underline">Back to Positions</Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Breadcrumb strip */}
      <nav className="text-[12px] text-grey-40 flex items-center gap-2 flex-wrap">
        <Link href="/dashboard/pipelines" className="hover:text-ink">Pipelines</Link>
        <span>·</span>
        <span>Cleaner Hiring Pipeline</span>
        <span className="mx-2 text-grey-60">/</span>
        <Link href="/dashboard/positions" className="hover:text-ink">Positions</Link>
        <span>·</span>
        <span className="text-ink font-medium">{data.position.label}</span>
        <span className="ml-auto text-grey-40">Hiring Manager: {data.position.hiringManager}</span>
      </nav>

      {/* Header */}
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-[26px] font-semibold text-ink m-0 leading-tight">{data.position.label}</h1>
          {data.position.isActive && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[color:var(--success-bg)] text-[color:var(--success-fg)] text-[11px] font-mono uppercase" style={{ letterSpacing: '0.04em' }}>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[color:var(--success-fg)]" />
              Active
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button className="text-[13px] px-3 py-2 rounded-[10px] border border-surface-border text-ink hover:bg-surface-light">
            Edit position
          </button>
          <button className="text-[13px] px-4 py-2 rounded-[10px] bg-brand-500 text-white font-medium hover:bg-brand-600">
            + Hire candidate
          </button>
        </div>
      </header>

      {/* Stats + right sidebar starts */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
        <div className="flex flex-col gap-4">
          <SummaryRow summary={data.summary} />
          <PipelinePerfCard rows={data.pipelinePerformance} />
          <TopSourcesCard rows={data.topSources} />
          <RecentCandidatesCard rows={data.recentCandidates} />
        </div>

        <aside className="flex flex-col gap-4">
          <PositionDetailsCard position={data.position} />
          <DocumentsCard />
        </aside>
      </div>
    </div>
  )
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function SummaryRow({ summary }: { summary: PositionResponse['summary'] }) {
  const cards = [
    { label: 'Total applicants',    value: summary.totalApplicants,    sub: summary.startedThisWeek > 0 ? `↑ ${summary.startedThisWeek} this week` : '—' },
    { label: 'Active candidates',   value: summary.activeCandidates,   sub: 'In pipeline' },
    { label: 'Started this week',   value: summary.startedThisWeek,    sub: 'Last 7 days' },
    { label: 'Avg. days to hire',   value: summary.avgDaysToHire == null ? '—' : `${summary.avgDaysToHire.toFixed(0)} days`, sub: 'From application' },
  ]
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map(c => (
        <div key={c.label} className="bg-white border border-surface-border rounded-[14px] p-4">
          <div className="font-mono text-[10px] uppercase text-grey-40" style={{ letterSpacing: '0.1em' }}>{c.label}</div>
          <div className="text-[22px] font-semibold text-ink mt-1 leading-none">{c.value}</div>
          <div className="text-[11px] text-grey-40 mt-1.5">{c.sub}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Pipeline performance bar chart ─────────────────────────────────────────

function PipelinePerfCard({ rows }: { rows: PositionResponse['pipelinePerformance'] }) {
  return (
    <div className="bg-white border border-surface-border rounded-[14px] p-4">
      <h3 className="text-[14px] font-semibold text-ink m-0 mb-3">Pipeline performance</h3>
      {rows.length === 0 || rows.every(r => r.count === 0) ? (
        <div className="text-[12px] text-grey-40 py-2">No applicants for this position yet.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(r => (
            <li key={r.stage} className="grid grid-cols-[160px_1fr_auto] items-center gap-3">
              <span className="text-[13px] text-ink truncate">{r.stage}</span>
              <div className="h-6 bg-surface-weak rounded-md overflow-hidden">
                <div
                  className="h-full rounded-md"
                  style={{ width: `${r.pct}%`, background: stageColor(r.stage) }}
                />
              </div>
              <span className="text-[12px] text-grey-40 tabular-nums w-14 text-right">
                {r.count} · {r.pct}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function stageColor(stage: string): string {
  const s = stage.toLowerCase()
  if (s.includes('applicat')) return 'var(--info-fg)'
  if (s.includes('train')) return 'var(--brand-fg)'
  if (s.includes('interview') || s.includes('meet')) return 'var(--warn-fg)'
  if (s.includes('hire')) return 'var(--success-fg)'
  return 'var(--neutral-fg)'
}

// ─── Top sources bar chart ──────────────────────────────────────────────────

function TopSourcesCard({ rows }: { rows: PositionResponse['topSources'] }) {
  return (
    <div className="bg-white border border-surface-border rounded-[14px] p-4">
      <h3 className="text-[14px] font-semibold text-ink m-0 mb-3">Top sources</h3>
      {rows.length === 0 ? (
        <div className="text-[12px] text-grey-40 py-2">No attributed applicants yet.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(r => (
            <li key={r.source} className="grid grid-cols-[120px_1fr_auto] items-center gap-3">
              <span className="text-[13px] text-ink capitalize truncate">{r.source}</span>
              <div className="h-5 bg-surface-weak rounded-md overflow-hidden">
                <div className="h-full rounded-md bg-brand-500" style={{ width: `${r.pct}%` }} />
              </div>
              <span className="text-[12px] text-grey-40 tabular-nums w-14 text-right">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Recent candidates table ────────────────────────────────────────────────

function RecentCandidatesCard({ rows }: { rows: PositionResponse['recentCandidates'] }) {
  return (
    <div className="bg-white border border-surface-border rounded-[14px]">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <h3 className="text-[14px] font-semibold text-ink m-0">Recent candidates</h3>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase text-grey-40 border-t border-surface-divider">
              <th className="px-4 py-2 font-medium">Candidate</th>
              <th className="px-4 py-2 font-medium">Stage</th>
              <th className="px-4 py-2 font-medium">Last activity</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-divider">
            {rows.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-grey-40 text-center">No candidates for this position yet.</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id} className="hover:bg-surface-light">
                <td className="px-4 py-3">
                  <Link href={`/dashboard/candidates/${r.id}`} className="flex items-center gap-2 group">
                    <Avatar name={r.name} size="sm" />
                    <span className="font-medium text-ink group-hover:text-brand-600">{r.name}</span>
                  </Link>
                </td>
                <td className="px-4 py-3 text-grey-35">{prettyStage(r.pipelineStatus)}</td>
                <td className="px-4 py-3 text-grey-40 tabular-nums text-[12px]">
                  {new Date(r.lastActivityAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                </td>
                <td className="px-4 py-3">
                  <StatusPill status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-surface-divider px-4 py-2.5">
        <Link href="/dashboard/candidates" className="text-[12px] text-brand-600 hover:text-brand-700 font-medium">
          View all candidates →
        </Link>
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const tone = status === 'hired' ? 'success' : status === 'lost' ? 'danger' : status === 'stalled' ? 'warn' : 'brand'
  const map: Record<string, { bg: string; fg: string }> = {
    success: { bg: 'var(--success-bg)', fg: 'var(--success-fg)' },
    danger:  { bg: 'var(--danger-bg)',  fg: 'var(--danger-fg)'  },
    warn:    { bg: 'var(--warn-bg)',    fg: 'var(--warn-fg)'    },
    brand:   { bg: 'var(--brand-dim)',  fg: 'var(--brand-fg)'   },
  }
  const s = map[tone] || map.brand
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, letterSpacing: '0.04em', fontWeight: 600 }}>
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: 'currentColor' }} />
      {status}
    </span>
  )
}

function prettyStage(v: string | null): string {
  if (!v) return '—'
  return v.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
}

// ─── Right sidebar ──────────────────────────────────────────────────────────

function PositionDetailsCard({ position }: { position: PositionResponse['position'] }) {
  return (
    <div className="bg-white border border-surface-border rounded-[14px] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold text-ink m-0">Position details</h3>
        <button className="text-[11px] text-grey-40 hover:text-ink font-medium">Edit</button>
      </div>
      {position.activeSinceDays != null && (
        <div className="text-[12px] text-grey-40 mb-3">
          This position has been active for {position.activeSinceDays} day{position.activeSinceDays === 1 ? '' : 's'}
        </div>
      )}
      <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-[12px]">
        <MetaRow label="Employment type" value="—" />
        <MetaRow label="Location" value="—" />
        <MetaRow label="Schedule" value="—" />
        <MetaRow label="Pay" value="—" />
        <MetaRow label="Start date" value="—" />
        <MetaRow label="Reports to" value="—" />
      </dl>
      <div className="mt-3 pt-3 border-t border-surface-divider">
        <h4 className="text-[12px] font-semibold text-ink m-0 mb-1.5">Job description</h4>
        <p className="text-[12px] text-grey-40">
          No description added yet. This surface will pull from the Ad&apos;s <span className="font-mono">bodyText</span> once wired.
        </p>
      </div>
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-grey-40">{label}</dt>
      <dd className="m-0 text-ink">{value}</dd>
    </>
  )
}

function DocumentsCard() {
  return (
    <div className="bg-white border border-surface-border rounded-[14px] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold text-ink m-0">Documents &amp; Assets</h3>
        <button className="text-[11px] text-grey-40 hover:text-ink font-medium">Add</button>
      </div>
      <div className="text-[12px] text-grey-40">
        No documents attached to this position yet.
      </div>
    </div>
  )
}
