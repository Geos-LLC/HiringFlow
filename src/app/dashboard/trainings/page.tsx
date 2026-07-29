/**
 * Trainings & Automation hub — matches Design/6-training-automation.png.
 *
 * Aggregate view over the workspace's training programs and automation
 * rules. The full-featured programs list (create modals, uploads, rename)
 * lives one click away at /dashboard/trainings/manage — this page is a
 * dashboard, not a manager.
 */

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/design'
import { SubNav } from '../_components/SubNav'
import { Avatar } from '../pipelines/_stage-shell'

const TRAINING_NAV = [
  { href: '/dashboard/trainings', label: 'Trainings' },
  { href: '/dashboard/ai-calls', label: 'AI Calls' },
]

interface HubProgram {
  id: string; title: string; slug: string; isPublished: boolean; required: boolean
  sectionCount: number; enrollmentCount: number; completionCount: number
  completionRatePct: number; avgDaysToComplete: number | null
}
interface HubEnrolled {
  enrollmentId: string; candidateId: string; candidateName: string; positionLabel: string | null
  trainingId: string; trainingTitle: string; progressPct: number; status: string; startedAt: string
}
interface HubAutomation {
  id: string; name: string; triggerType: string; isActive: boolean; channel: string
}
interface HubResponse {
  summary: {
    candidatesInTraining: number
    completedThisWeek: number
    avgCompletionDays: number | null
    completionRatePct: number
  }
  programs: HubProgram[]
  candidatesInTraining: HubEnrolled[]
  automations: HubAutomation[]
}

export default function TrainingsHubPage() {
  const [data, setData] = useState<HubResponse | null>(null)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'trainings' | 'automations'>('trainings')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/api/hf/trainings-hub')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const filteredPrograms = data?.programs.filter(p => {
    if (!search.trim()) return true
    return p.title.toLowerCase().includes(search.toLowerCase())
  }) ?? []

  return (
    <div>
      <PageHeader
        title="Trainings & Automation"
        description="Manage candidate training programs and hiring workflow automations."
        actions={
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search trainings, automations…"
              className="px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white w-[220px]"
            />
            <Link
              href="/dashboard/trainings/manage"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[10px] bg-brand-500 text-white text-[13px] font-medium hover:bg-brand-600"
            >
              + New training
            </Link>
          </div>
        }
      />

      <SubNav items={TRAINING_NAV} />

      <div className="mt-4 flex items-center gap-2 border-b border-surface-divider">
        <TabButton active={tab === 'trainings'} onClick={() => setTab('trainings')}>Trainings</TabButton>
        <TabButton active={tab === 'automations'} onClick={() => setTab('automations')}>Automations</TabButton>
      </div>

      {loading && <div className="mt-6 text-grey-40 text-sm">Loading…</div>}
      {error && <div className="mt-6 text-red-600 text-sm">{error}</div>}

      {data && tab === 'trainings' && (
        <>
          <SummaryRow summary={data.summary} />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
            <div className="lg:col-span-2">
              <ProgramsTable programs={filteredPrograms} />
            </div>
            <div className="flex flex-col gap-4">
              <StarterPreview program={data.programs[0] ?? null} />
              <AutomationRulesCard automations={data.automations} />
            </div>
          </div>
          <div className="mt-4">
            <CandidatesInTraining rows={data.candidatesInTraining} />
          </div>
        </>
      )}

      {data && tab === 'automations' && (
        <div className="mt-6 text-[13px] text-grey-40">
          Manage all automation rules on the{' '}
          <Link href="/dashboard/automations" className="text-brand-600 hover:underline font-medium">
            full Automations page →
          </Link>
        </div>
      )}
    </div>
  )
}

// ─── Sections ───────────────────────────────────────────────────────────────

function TabButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
        active ? 'border-brand-500 text-ink' : 'border-transparent text-grey-40 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

function SummaryRow({ summary }: { summary: HubResponse['summary'] }) {
  const cards = [
    { label: 'Candidates in training', value: summary.candidatesInTraining, sub: 'Currently enrolled', tone: 'brand' },
    { label: 'Completed this week',    value: summary.completedThisWeek,    sub: 'Last 7 days',        tone: 'success' },
    { label: 'Average completion',     value: summary.avgCompletionDays == null ? '—' : `${summary.avgCompletionDays.toFixed(1)} days`, sub: 'From start to finish', tone: 'info' },
    { label: 'Completion rate',        value: `${summary.completionRatePct}%`, sub: 'Overall',            tone: 'warn' },
  ]
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
      {cards.map(c => (
        <div key={c.label} className="bg-white border border-surface-border rounded-[14px] p-4 flex items-center gap-3">
          <span className={`inline-flex items-center justify-center w-10 h-10 rounded-full ${toneRing(c.tone)}`}>
            <TrainingIcon />
          </span>
          <div>
            <div className="text-[20px] font-semibold text-ink leading-none tabular-nums">{c.value}</div>
            <div className="text-[12px] text-grey-40 mt-1">{c.label}</div>
            <div className="text-[10px] text-grey-50 mt-0.5">{c.sub}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function ProgramsTable({ programs }: { programs: HubProgram[] }) {
  return (
    <div className="bg-white border border-surface-border rounded-[14px]">
      <header className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="text-[14px] font-semibold text-ink m-0">Trainings programs</h2>
        <Link href="/dashboard/trainings/manage" className="text-[12px] text-brand-600 hover:text-brand-700 font-medium">
          Manage programs →
        </Link>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase text-grey-40 border-t border-surface-divider">
              <th className="px-4 py-2 font-medium">Program</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Avg. time</th>
              <th className="px-4 py-2 font-medium">Completion rate</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-divider">
            {programs.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-grey-40 text-center">No training programs yet.</td></tr>
            )}
            {programs.map(p => (
              <tr key={p.id} className="hover:bg-surface-light">
                <td className="px-4 py-3">
                  <Link href={`/dashboard/trainings/${p.id}`} className="font-medium text-ink hover:text-brand-600">
                    {p.title}
                  </Link>
                  <div className="text-[11px] text-grey-40 mt-0.5">
                    {p.sectionCount} section{p.sectionCount === 1 ? '' : 's'}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${p.required ? 'bg-[color:var(--brand-dim)] text-[color:var(--brand-fg)]' : 'bg-surface-weak text-grey-35'}`}>
                    {p.required ? 'Required' : 'Optional'}
                  </span>
                </td>
                <td className="px-4 py-3 tabular-nums text-grey-35">
                  {p.avgDaysToComplete == null ? '—' : `${p.avgDaysToComplete.toFixed(1)}d`}
                </td>
                <td className="px-4 py-3">
                  <ProgressBar pct={p.completionRatePct} label={`${p.completionRatePct}%`} />
                </td>
                <td className="px-4 py-3 text-right">
                  <Link href={`/dashboard/trainings/${p.id}`} className="text-grey-40 hover:text-ink">→</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StarterPreview({ program }: { program: HubProgram | null }) {
  if (!program) return null
  return (
    <div className="bg-white border border-surface-border rounded-[14px] p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[14px] font-semibold text-ink m-0">{program.title}</h3>
        <span className="text-[11px] text-grey-40">Practice program</span>
      </div>
      <ol className="mt-3 flex flex-col gap-1.5">
        {Array.from({ length: Math.min(5, program.sectionCount || 5) }).map((_, i) => (
          <li key={i} className="flex items-center gap-2 text-[13px]">
            <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${i < 3 ? 'bg-[color:var(--success-bg)] text-[color:var(--success-fg)]' : 'bg-surface-weak text-grey-50'}`}>
              {i < 3 ? '✓' : i + 1}
            </span>
            <span className={i < 3 ? 'text-grey-35' : 'text-ink'}>Section {i + 1}</span>
          </li>
        ))}
      </ol>
      <div className="mt-3 pt-3 border-t border-surface-divider text-[11px] text-grey-40">
        {program.sectionCount} sections · {program.avgDaysToComplete == null ? '—' : `${program.avgDaysToComplete.toFixed(1)} days`} avg
      </div>
    </div>
  )
}

function AutomationRulesCard({ automations }: { automations: HubAutomation[] }) {
  return (
    <div className="bg-white border border-surface-border rounded-[14px]">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <h3 className="text-[14px] font-semibold text-ink m-0">Automation rules</h3>
        <Link href="/dashboard/automations" className="text-[11px] text-brand-600 hover:text-brand-700 font-medium">
          View all →
        </Link>
      </header>
      <ul className="divide-y divide-surface-divider">
        {automations.slice(0, 6).map(a => (
          <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-6 h-6 rounded-full bg-surface-weak inline-flex items-center justify-center text-grey-40">
              <AutomationIcon />
            </span>
            <div className="min-w-0 flex-1">
              <Link href={`/dashboard/automations?ruleId=${a.id}`} className="text-[13px] font-medium text-ink hover:text-brand-600 truncate block">
                {a.name}
              </Link>
              <div className="text-[10px] text-grey-40">{a.triggerType.replace(/_/g, ' ')}</div>
            </div>
            <span className={`inline-flex items-center h-5 w-9 rounded-full transition-colors ${a.isActive ? 'bg-brand-500' : 'bg-surface-weak'}`}>
              <span className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${a.isActive ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CandidatesInTraining({ rows }: { rows: HubEnrolled[] }) {
  return (
    <div className="bg-white border border-surface-border rounded-[14px]">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-[14px] font-semibold text-ink m-0">Candidates in training</h2>
        <Link href="/dashboard/candidates" className="text-[12px] text-brand-600 hover:text-brand-700 font-medium">
          View all →
        </Link>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase text-grey-40 border-t border-surface-divider">
              <th className="px-4 py-2 font-medium">Candidate</th>
              <th className="px-4 py-2 font-medium">Program</th>
              <th className="px-4 py-2 font-medium">Progress</th>
              <th className="px-4 py-2 font-medium">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-divider">
            {rows.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-grey-40 text-center">Nobody is currently in a training.</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.enrollmentId} className="hover:bg-surface-light">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Avatar name={r.candidateName} size="sm" />
                    <div>
                      <Link href={`/dashboard/candidates/${r.candidateId}`} className="font-medium text-ink hover:text-brand-600 block">
                        {r.candidateName}
                      </Link>
                      {r.positionLabel && <div className="text-[11px] text-grey-40">{r.positionLabel}</div>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-grey-35">{r.trainingTitle}</td>
                <td className="px-4 py-3" style={{ minWidth: 180 }}>
                  <ProgressBar pct={r.progressPct} label={`${r.progressPct}%`} />
                </td>
                <td className="px-4 py-3 text-grey-40 tabular-nums text-[12px]">
                  {new Date(r.startedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Bits ───────────────────────────────────────────────────────────────────

function ProgressBar({ pct, label }: { pct: number; label?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-surface-weak rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: pct >= 80 ? 'var(--success-fg)' : pct >= 40 ? 'var(--brand-primary)' : 'var(--warn-fg)' }}
        />
      </div>
      {label && <span className="text-[11px] text-grey-40 tabular-nums w-9 text-right">{label}</span>}
    </div>
  )
}

function toneRing(tone: string): string {
  switch (tone) {
    case 'brand':   return 'bg-[#FFF3DF] text-[color:var(--brand-fg)]'
    case 'success': return 'bg-[#E6F4EA] text-[color:var(--success-fg)]'
    case 'info':    return 'bg-[#E6EFF8] text-[color:var(--info-fg)]'
    case 'warn':    return 'bg-[#FEF2D0] text-[color:var(--warn-fg)]'
    default:        return 'bg-surface-weak text-grey-40'
  }
}

function TrainingIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" />
    </svg>
  )
}
function AutomationIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}
