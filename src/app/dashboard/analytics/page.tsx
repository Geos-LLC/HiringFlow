/**
 * Analytics screen — refreshed to match Design/design_handoff_hirefunnel.
 *
 * Layout follows the design handoff:
 *   - PageHeader with eyebrow + actions
 *   - 4 stat cards (Total submissions / Completion / Pass rate / Drop-off)
 *   - Funnel bars (left, wide) + By-source card (right, narrow) side-by-side
 *   - Campaign performance table below
 *
 * Data source unchanged — still pulls from /api/analytics?range=<r>. Sparkline
 * series are not yet returned by the API; Stat cards use `sub` copy instead
 * until a daily count endpoint is added.
 */

'use client'

import { useEffect, useState } from 'react'
import { Button, Badge, Card, Eyebrow, PageHeader, Stat, type BadgeTone } from '@/components/design'
import { SubNav } from '../_components/SubNav'

const ANALYTICS_NAV = [
  { href: '/dashboard/analytics', label: 'Funnel' },
  { href: '/dashboard/analytics/ai-evaluation', label: 'AI Evaluation' },
]
import {
  STATUS_DISPLAY,
  DISPOSITION_DISPLAY,
  type CandidateStatus,
  type CandidateDispositionReason,
} from '@/lib/candidate-status'

interface FunnelData {
  started: number; completed: number; passed: number
  trainingStarted: number; trainingCompleted: number
  invitedToSchedule: number; scheduled: number
}
interface SourceRow {
  source: string; started: number; completed: number; passed: number
  trainingCompleted: number; invitedToSchedule: number; scheduled: number
}
interface AdRow {
  adId: string; adName: string; source: string
  started: number; completed: number; passed: number
  trainingCompleted: number; invitedToSchedule: number; scheduled: number
}
interface StatusBlock {
  byStatus: Record<CandidateStatus, number>
  lostByReason: Record<string, number>
  stalledByReason: Record<string, number>
  reactivated: number
}
interface AnalyticsData {
  funnel: FunnelData
  sources: SourceRow[]
  ads: AdRow[]
  status?: StatusBlock
}

const RANGES = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
] as const

type RangeValue = (typeof RANGES)[number]['value']

function pct(a: number, b: number) {
  if (b === 0) return '—'
  return `${Math.round((a / b) * 100)}%`
}

function pctRaw(a: number, b: number) {
  if (b === 0) return 0
  return Math.round((a / b) * 100)
}

function fmt(n: number) {
  return n.toLocaleString()
}

// Find the biggest single-step drop in the funnel. Used by the Drop-off stat.
function biggestDropoff(stages: Array<{ label: string; value: number }>): { label: string; pct: number } | null {
  let worst: { label: string; pct: number } | null = null
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1].value
    if (prev === 0) continue
    const lost = prev - stages[i].value
    const lostPct = Math.round((lost / prev) * 100)
    if (!worst || lostPct > worst.pct) worst = { label: stages[i].label, pct: lostPct }
  }
  return worst
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<RangeValue>('all')

  useEffect(() => {
    setLoading(true)
    fetch(`/api/analytics?range=${range}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [range])

  if (loading || !data) {
    return (
      <div className="py-16 text-center text-grey-35 font-mono text-[12px] uppercase tracking-wide">
        Loading analytics…
      </div>
    )
  }

  const { funnel, sources, ads } = data

  const stages: Array<{ label: string; value: number }> = [
    { label: 'Started',              value: funnel.started },
    { label: 'Completed',            value: funnel.completed },
    { label: 'Passed',               value: funnel.passed },
    { label: 'Training started',     value: funnel.trainingStarted },
    { label: 'Training done',        value: funnel.trainingCompleted },
    { label: 'Invited to schedule',  value: funnel.invitedToSchedule },
    { label: 'Scheduled',            value: funnel.scheduled },
  ]
  const maxVal = Math.max(...stages.map((s) => s.value), 1)
  const drop = biggestDropoff(stages)

  const totalSourceStarted = sources.reduce((s, r) => s + r.started, 0) || 1
  const sortedSources = [...sources].sort((a, b) => b.started - a.started)

  const rangeLabel = RANGES.find((r) => r.value === range)?.label ?? 'All time'
  const completionPct = pctRaw(funnel.completed, funnel.started)
  const passRate = pctRaw(funnel.passed, funnel.completed)

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow={`Workspace · ${rangeLabel}`}
        title="Analytics"
        description="Candidate funnel performance across all published flows."
        actions={
          <>
            <RangePicker value={range} onChange={setRange} />
            <Button variant="secondary" size="sm" iconLeft={<span>↓</span>}>Export CSV</Button>
          </>
        }
      />

      <div className="px-8 py-6 space-y-5">
        <SubNav items={ANALYTICS_NAV} />
        {/* Status cards (orthogonal to the funnel — counts of where
            candidates currently sit on the active/stalled/lost/hired
            axis). Sits above the funnel stats so recruiters see the
            "right now" picture before the historical funnel cliff. */}
        {data.status && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
            <Stat
              label="Active candidates"
              value={fmt((data.status.byStatus.active ?? 0) + (data.status.byStatus.waiting ?? 0))}
              sub={`${fmt(data.status.byStatus.waiting ?? 0)} waiting`}
            />
            <Stat
              label="Stalled candidates"
              value={fmt(data.status.byStatus.stalled ?? 0)}
              sub={data.status.reactivated > 0 ? `${fmt(data.status.reactivated)} reactivated` : 'Auto-detected daily'}
            />
            <Stat
              label="Lost candidates"
              value={fmt(data.status.byStatus.lost ?? 0)}
              sub="Final negative outcomes"
            />
            <Stat
              label="Hired candidates"
              value={fmt(data.status.byStatus.hired ?? 0)}
              sub="Confirmed hires"
            />
          </div>
        )}

        {/* Top stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
          <Stat
            label="Total submissions"
            value={fmt(funnel.started)}
            sub={`${fmt(funnel.completed)} completed`}
          />
          <Stat
            label="Completion rate"
            value={`${completionPct}%`}
            sub={`${fmt(funnel.completed)} of ${fmt(funnel.started)}`}
          />
          <Stat
            label="Pass rate"
            value={`${passRate}%`}
            sub={`${fmt(funnel.passed)} of ${fmt(funnel.completed)} completed`}
          />
          <Stat
            label="Drop-off point"
            value={drop ? drop.label : '—'}
            delta={drop ? `${drop.pct}% lost` : undefined}
            deltaTone="warn"
            sub={drop ? 'Biggest single-stage drop' : 'No data yet'}
          />
        </div>

        {/* Funnel + By source */}
        <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-3.5">
          <Card padding={24}>
            <div className="flex items-baseline justify-between mb-5">
              <div>
                <Eyebrow size="xs" className="mb-1">Funnel</Eyebrow>
                <div className="text-[17px] font-semibold text-ink">All flows</div>
              </div>
            </div>
            <div className="space-y-3.5">
              {stages.map((s, i) => {
                const prev = i > 0 ? stages[i - 1].value : null
                const lost = prev !== null ? prev - s.value : 0
                const stagePct = Math.round((s.value / maxVal) * 100)
                return (
                  <div key={s.label}>
                    <div className="flex justify-between text-[13px] mb-1.5">
                      <span className="font-medium text-ink">{s.label}</span>
                      <span className="text-grey-35">
                        {fmt(s.value)}
                        {prev !== null && (
                          <span className="font-mono ml-2 text-grey-50">{pct(s.value, prev)}</span>
                        )}
                      </span>
                    </div>
                    <div className="relative h-6 rounded-[6px] overflow-hidden" style={{ background: 'var(--weak-track)' }}>
                      <div
                        className="h-full rounded-[6px] transition-all duration-500"
                        style={{
                          width: `${Math.max(stagePct, s.value > 0 ? 2 : 0)}%`,
                          background: 'linear-gradient(90deg, var(--brand-primary), rgba(255,149,0,0.75))',
                        }}
                      />
                      {i > 0 && lost > 0 && (
                        <div
                          className="absolute right-2 top-1 font-mono text-[10px]"
                          style={{ color: 'var(--danger-fg)' }}
                        >
                          −{fmt(lost)}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          <Card padding={24}>
            <Eyebrow size="xs" className="mb-1">By source</Eyebrow>
            <div className="text-[17px] font-semibold text-ink mb-5">Where candidates come from</div>
            {sortedSources.length === 0 ? (
              <div className="text-[13px] text-grey-35 py-6 text-center">No source data yet</div>
            ) : (
              <div className="space-y-2.5">
                {sortedSources.map((row) => {
                  const pctWidth = Math.round((row.started / totalSourceStarted) * 100)
                  return (
                    <div key={row.source} className="flex items-center gap-2.5 text-[13px]">
                      <div className="w-[90px] capitalize text-ink">{row.source || '—'}</div>
                      <div className="flex-1 h-1.5 rounded-[3px] overflow-hidden" style={{ background: 'var(--weak-track)' }}>
                        <div className="h-full" style={{ width: `${pctWidth}%`, background: 'var(--brand-primary)' }} />
                      </div>
                      <div className="w-14 text-right font-mono text-[12px] text-grey-35">{fmt(row.started)}</div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </div>

        {/* Drop-off vs lost split — paired side-by-side cards showing where
            candidates fall out of the funnel (stalled = recoverable signal)
            and the structured reasons for true terminal loss. The funnel
            cliff above shows the count; these cards explain WHY. */}
        {data.status && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            <ReasonBreakdown
              eyebrow="Drop-off"
              title="Stalled reasons"
              reasons={data.status.stalledByReason}
              tone="warn"
            />
            <ReasonBreakdown
              eyebrow="Lost"
              title="Lost reasons"
              reasons={data.status.lostByReason}
              tone="danger"
            />
          </div>
        )}

        {/* Sources breakdown table */}
        <Card padding={0}>
          <div className="px-5 py-4 border-b border-surface-divider flex items-center justify-between">
            <div>
              <Eyebrow size="xs" className="mb-0.5">Detail</Eyebrow>
              <div className="text-[15px] font-semibold text-ink">Source performance</div>
            </div>
          </div>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left" style={{ background: 'var(--surface-light, #FCFAF6)' }}>
                {['Source', 'Started', 'Completed', 'Passed', 'Training', 'Invited', 'Scheduled', 'Pass rate'].map((h, i) => (
                  <th
                    key={h}
                    className={`px-4 py-2.5 font-mono text-[10px] uppercase text-grey-35 border-b border-surface-divider ${i === 0 ? 'text-left' : 'text-right'}`}
                    style={{ letterSpacing: '0.1em' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-10 text-grey-35">No source data yet</td></tr>
              ) : sources.map((s) => {
                const pr = pctRaw(s.passed, s.started)
                const tone: BadgeTone = pr >= 50 ? 'success' : pr >= 25 ? 'brand' : 'neutral'
                return (
                  <tr key={s.source} className="border-b border-surface-divider last:border-0 hover:bg-surface-light">
                    <td className="px-4 py-3 font-medium text-ink capitalize">{s.source || '—'}</td>
                    <td className="px-4 py-3 text-right font-mono text-ink">{fmt(s.started)}</td>
                    <td className="px-4 py-3 text-right font-mono text-grey-35">{fmt(s.completed)}</td>
                    <td className="px-4 py-3 text-right font-mono text-grey-35">{fmt(s.passed)}</td>
                    <td className="px-4 py-3 text-right font-mono text-grey-35">{fmt(s.trainingCompleted)}</td>
                    <td className="px-4 py-3 text-right font-mono text-grey-35">{fmt(s.invitedToSchedule)}</td>
                    <td className="px-4 py-3 text-right font-mono text-grey-35">{fmt(s.scheduled)}</td>
                    <td className="px-4 py-3 text-right">
                      <Badge tone={tone}>{pct(s.passed, s.started)}</Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>

        {/* Campaign / Ad performance */}
        <Card padding={0}>
          <div className="px-5 py-4 border-b border-surface-divider flex items-center justify-between">
            <div>
              <Eyebrow size="xs" className="mb-0.5">Detail</Eyebrow>
              <div className="text-[15px] font-semibold text-ink">Campaign performance</div>
            </div>
          </div>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left" style={{ background: 'var(--surface-light, #FCFAF6)' }}>
                {['Campaign', 'Source', 'Started', 'Completed', 'Passed', 'Training', 'Invited', 'Scheduled', 'Completion'].map((h, i) => (
                  <th
                    key={h}
                    className={`px-4 py-2.5 font-mono text-[10px] uppercase text-grey-35 border-b border-surface-divider ${i < 2 ? 'text-left' : 'text-right'}`}
                    style={{ letterSpacing: '0.1em' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ads.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-10 text-grey-35">No campaign data yet</td></tr>
              ) : ads.map((a) => {
                const cr = pctRaw(a.completed, a.started)
                const tone: BadgeTone = cr >= 50 ? 'success' : cr >= 25 ? 'brand' : 'neutral'
                return (
                  <tr key={a.adId} className="border-b border-surface-divider last:border-0 hover:bg-surface-light">
                    <td className="px-4 py-3 font-medium text-ink">{a.adName}</td>
                    <td className="px-4 py-3"><Badge tone="brand">{a.source}</Badge></td>
                    <td className="px-4 py-3 text-right font-mono text-ink">{fmt(a.started)}</td>
                    <td className="px-4 py-3 text-right font-mono text-grey-35">{fmt(a.completed)}</td>
                    <td className="px-4 py-3 text-right font-mono text-grey-35">{fmt(a.passed)}</td>
                    <td className="px-4 py-3 text-right font-mono text-grey-35">{fmt(a.trainingCompleted)}</td>
                    <td className="px-4 py-3 text-right font-mono text-grey-35">{fmt(a.invitedToSchedule)}</td>
                    <td className="px-4 py-3 text-right font-mono text-grey-35">{fmt(a.scheduled)}</td>
                    <td className="px-4 py-3 text-right">
                      <Badge tone={tone}>{pct(a.completed, a.started)}</Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  )
}

/**
 * Reason breakdown card — compact horizontal-bar summary of disposition
 * reasons. Used for both Stalled and Lost so the analytics page can show
 * "why are these candidates stuck / lost" side-by-side. Sorted by count
 * descending; bars normalized to the largest reason in this card so each
 * card scales independently (lost might have 50, stalled might have 3 —
 * we don't want lost reasons to crush the stalled visualization).
 */
function ReasonBreakdown({
  eyebrow,
  title,
  reasons,
  tone,
}: {
  eyebrow: string
  title: string
  reasons: Record<string, number>
  tone: 'warn' | 'danger'
}) {
  const entries = Object.entries(reasons)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
  const total = entries.reduce((s, [, v]) => s + v, 0)
  const max = entries[0]?.[1] ?? 0
  const barColor = tone === 'danger' ? 'var(--danger-fg)' : '#D97706'

  return (
    <Card padding={20}>
      <Eyebrow size="xs" className="mb-1">{eyebrow}</Eyebrow>
      <div className="text-[15px] font-semibold text-ink mb-1">{title}</div>
      <div className="text-[12px] text-grey-35 mb-4">{fmt(total)} candidate{total === 1 ? '' : 's'}</div>
      {entries.length === 0 ? (
        <div className="text-[13px] text-grey-35 py-4 text-center">No data in this range</div>
      ) : (
        <div className="space-y-2">
          {entries.map(([reason, count]) => {
            const label = (reason in DISPOSITION_DISPLAY)
              ? DISPOSITION_DISPLAY[reason as CandidateDispositionReason]
              : reason
            const pctOfMax = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0
            return (
              <div key={reason} className="flex items-center gap-2.5 text-[12px]">
                <div className="w-[170px] truncate text-ink" title={label}>{label}</div>
                <div className="flex-1 h-1.5 rounded-[3px] overflow-hidden" style={{ background: 'var(--weak-track)' }}>
                  <div className="h-full rounded-[3px]" style={{ width: `${pctOfMax}%`, background: barColor }} />
                </div>
                <div className="w-10 text-right font-mono text-grey-35">{fmt(count)}</div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

/** Range picker — segmented pill control, style matches the refreshed system. */
function RangePicker({ value, onChange }: { value: RangeValue; onChange: (v: RangeValue) => void }) {
  return (
    <div className="inline-flex bg-surface-light border border-surface-border rounded-[10px] p-0.5">
      {RANGES.map((r) => (
        <button
          key={r.value}
          onClick={() => onChange(r.value)}
          className={`px-3 py-1.5 text-[12px] rounded-[8px] font-medium transition-colors ${
            value === r.value ? 'bg-white text-ink shadow-sm' : 'text-grey-35 hover:text-ink'
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}
