/**
 * Analytics > AI Evaluation
 *
 * Recruiter picks one or more candidates from the workspace, optionally edits
 * the auto-resolved position description, hits "Run evaluation" — the engine
 * fetches every transcript/recording the candidate has accumulated (AI calls,
 * self-intro captures, interview meetings) and produces a 0-100 score against
 * JD-derived role-specific criteria.
 *
 * Layout: candidate picker table (left), JD + run controls (right top),
 * comparison table (bottom) showing latest evaluation per selected candidate
 * with criteria as rows and candidates as columns.
 */

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/design'
import { SubNav } from '../../_components/SubNav'

const NAV = [
  { href: '/dashboard/analytics', label: 'Funnel' },
  { href: '/dashboard/analytics/ai-evaluation', label: 'AI Evaluation' },
]

interface Candidate {
  id: string
  candidateName: string | null
  candidateEmail: string | null
  startedAt: string
  flow: { id: string; name: string } | null
}

interface ScoredCriterion {
  name: string
  description: string
  weight: number
  score: number
  evidence: string
}

interface Evaluation {
  id: string
  sessionId: string
  overallScore: number
  recommendation: 'strong_hire' | 'hire' | 'borderline' | 'no_hire'
  summary: string
  criteria: ScoredCriterion[]
  strengths: string[]
  weaknesses: string[]
  positionDescriptionSnapshot: string
  createdAt: string
  session?: { candidateName: string | null; candidateEmail: string | null }
}

const RECOMMENDATION_LABEL: Record<Evaluation['recommendation'], string> = {
  strong_hire: 'Strong hire',
  hire: 'Hire',
  borderline: 'Borderline',
  no_hire: 'No hire',
}
const RECOMMENDATION_COLOR: Record<Evaluation['recommendation'], string> = {
  strong_hire: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  hire: 'bg-sky-50 text-sky-700 border-sky-200',
  borderline: 'bg-amber-50 text-amber-700 border-amber-200',
  no_hire: 'bg-red-50 text-red-700 border-red-200',
}

function scoreColor(score: number): string {
  if (score >= 85) return 'text-emerald-600'
  if (score >= 70) return 'text-sky-600'
  if (score >= 55) return 'text-amber-600'
  return 'text-red-600'
}

function scoreBarColor(score: number): string {
  if (score >= 85) return 'bg-emerald-500'
  if (score >= 70) return 'bg-sky-500'
  if (score >= 55) return 'bg-amber-500'
  return 'bg-red-500'
}

export default function AIEvaluationPage() {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [evaluations, setEvaluations] = useState<Record<string, Evaluation>>({})
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  // JD override: keyed by sessionId. Empty string = use the default JD.
  // We preload the default JD into the textarea so the recruiter can edit
  // before running.
  const [jdOverrides, setJdOverrides] = useState<Record<string, string>>({})
  const [expandedJd, setExpandedJd] = useState<string | null>(null)

  // Load candidates + existing evaluations on mount.
  useEffect(() => {
    void (async () => {
      try {
        const [candidatesRes, evalsRes] = await Promise.all([
          fetch('/api/candidates'),
          fetch('/api/evaluations'),
        ])
        const candidatesData = await candidatesRes.json()
        const evalsData = await evalsRes.json()
        // /api/candidates returns either { candidates: [] } or [] depending on
        // the route shape. Handle both.
        const list: Candidate[] = Array.isArray(candidatesData)
          ? candidatesData
          : candidatesData.candidates ?? []
        setCandidates(list)
        const map: Record<string, Evaluation> = {}
        for (const e of (evalsData.evaluations ?? []) as Evaluation[]) {
          if (!map[e.sessionId]) map[e.sessionId] = e
        }
        setEvaluations(map)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    const arr = q
      ? candidates.filter(
          (c) =>
            (c.candidateName ?? '').toLowerCase().includes(q) ||
            (c.candidateEmail ?? '').toLowerCase().includes(q),
        )
      : candidates
    return arr.slice(0, 100)
  }, [candidates, search])

  const selectedCandidates = useMemo(
    () => candidates.filter((c) => selected.has(c.id)),
    [candidates, selected],
  )

  const selectedEvaluations = useMemo(
    () => selectedCandidates.map((c) => evaluations[c.id]).filter(Boolean) as Evaluation[],
    [selectedCandidates, evaluations],
  )

  // Union of criteria names across all selected evaluations. The comparison
  // table renders one row per unique name; cells show "—" when a candidate's
  // rubric didn't include that criterion (different JDs → different criteria).
  const allCriteriaNames = useMemo(() => {
    const seen = new Map<string, ScoredCriterion>()
    for (const ev of selectedEvaluations) {
      for (const c of ev.criteria) {
        if (!seen.has(c.name)) seen.set(c.name, c)
      }
    }
    return Array.from(seen.keys())
  }, [selectedEvaluations])

  const toggleSelect = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const previewJd = useCallback(async (sessionId: string) => {
    if (jdOverrides[sessionId] !== undefined) return jdOverrides[sessionId]
    const res = await fetch(`/api/evaluations/preview-position-description?sessionId=${sessionId}`)
    if (!res.ok) return ''
    const data = await res.json()
    return data.positionDescription as string
  }, [jdOverrides])

  const openJdEditor = async (sessionId: string) => {
    setExpandedJd(sessionId)
    if (jdOverrides[sessionId] === undefined) {
      const jd = await previewJd(sessionId)
      setJdOverrides((cur) => ({ ...cur, [sessionId]: jd }))
    }
  }

  const runEvaluation = async (sessionId: string) => {
    setRunning((s) => new Set(s).add(sessionId))
    setError(null)
    try {
      const body: { sessionId: string; positionDescription?: string } = { sessionId }
      const override = jdOverrides[sessionId]
      if (override !== undefined) body.positionDescription = override

      const res = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Evaluation failed')
      setEvaluations((cur) => ({ ...cur, [sessionId]: data.evaluation }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Evaluation failed')
    } finally {
      setRunning((s) => {
        const next = new Set(s)
        next.delete(sessionId)
        return next
      })
    }
  }

  const runAll = async () => {
    for (const c of selectedCandidates) {
      // serially — OpenAI bursts can rate-limit and parallel runs would also
      // mask which one failed in the error toast.
      await runEvaluation(c.id)
    }
  }

  if (loading) {
    return (
      <div className="-mx-6 lg:-mx-[132px]">
        <PageHeader eyebrow="Workspace" title="Analytics" description="AI candidate evaluation." />
        <div className="px-8 py-6">
          <SubNav items={NAV} />
          <div className="py-16 text-center text-grey-35 font-mono text-[12px] uppercase tracking-wide">
            Loading candidates…
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow="Workspace"
        title="Analytics"
        description="Run AI evaluations against the candidate's position description and compare scores side-by-side."
      />

      <div className="px-8 py-6">
        <SubNav items={NAV} />

        {error && (
          <div className="mb-4 px-4 py-3 rounded-[10px] border border-red-200 bg-red-50 text-red-700 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-6">
          {/* Left — candidate picker */}
          <div className="bg-white border border-surface-border rounded-[12px] overflow-hidden">
            <div className="px-4 py-3 border-b border-surface-border">
              <div className="text-[11px] font-mono uppercase text-grey-35 tracking-wider mb-2">
                Select candidates ({selected.size})
              </div>
              <input
                type="search"
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm focus:outline-none focus:border-brand-500"
              />
            </div>
            <div className="max-h-[480px] overflow-y-auto">
              {filtered.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-grey-40">
                  {search ? 'No candidates match.' : 'No candidates yet.'}
                </div>
              )}
              {filtered.map((c) => {
                const isSelected = selected.has(c.id)
                const hasEval = !!evaluations[c.id]
                return (
                  <button
                    key={c.id}
                    onClick={() => toggleSelect(c.id)}
                    className={`w-full px-4 py-2.5 flex items-center gap-3 text-left border-b border-surface-border hover:bg-surface-light transition-colors ${
                      isSelected ? 'bg-brand-50/40' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}}
                      className="pointer-events-none"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-ink truncate">
                        {c.candidateName || '(no name)'}
                      </div>
                      <div className="text-[11px] text-grey-40 truncate">
                        {c.candidateEmail ?? '—'} · {c.flow?.name ?? 'no flow'}
                      </div>
                    </div>
                    {hasEval && (
                      <span
                        className={`shrink-0 font-mono text-[11px] tabular-nums font-semibold ${scoreColor(
                          evaluations[c.id].overallScore,
                        )}`}
                      >
                        {evaluations[c.id].overallScore}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Right — selected list + JD editor + run */}
          <div className="space-y-4">
            {selectedCandidates.length === 0 ? (
              <div className="bg-white border border-dashed border-surface-border rounded-[12px] px-6 py-12 text-center">
                <div className="text-sm text-grey-40 mb-1">No candidates selected</div>
                <div className="text-[12px] text-grey-50">
                  Pick one or more candidates from the left to run evaluations and compare scores.
                </div>
              </div>
            ) : (
              <div className="bg-white border border-surface-border rounded-[12px]">
                <div className="px-4 py-3 border-b border-surface-border flex items-center justify-between">
                  <div className="text-[11px] font-mono uppercase text-grey-35 tracking-wider">
                    Run evaluation
                  </div>
                  <button
                    onClick={runAll}
                    disabled={running.size > 0}
                    className="px-3 py-1.5 rounded-[8px] bg-brand-500 text-white text-[12px] font-semibold hover:bg-brand-600 disabled:opacity-50 transition-colors"
                  >
                    {running.size > 0 ? `Running ${running.size}…` : `Run all (${selectedCandidates.length})`}
                  </button>
                </div>
                <div className="divide-y divide-surface-border">
                  {selectedCandidates.map((c) => {
                    const ev = evaluations[c.id]
                    const isRunning = running.has(c.id)
                    return (
                      <div key={c.id} className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-ink truncate">
                              {c.candidateName || '(no name)'}
                            </div>
                            <div className="text-[11px] text-grey-40 truncate">
                              {c.flow?.name ?? '—'}
                            </div>
                          </div>
                          {ev && (
                            <div className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${RECOMMENDATION_COLOR[ev.recommendation]}`}>
                              {ev.overallScore} · {RECOMMENDATION_LABEL[ev.recommendation]}
                            </div>
                          )}
                          <button
                            onClick={() => openJdEditor(c.id)}
                            className="text-[11px] px-2 py-1 rounded-[6px] border border-surface-border text-grey-35 hover:border-grey-50 hover:text-ink transition-colors"
                          >
                            {jdOverrides[c.id] !== undefined ? 'Edit JD' : 'View JD'}
                          </button>
                          <button
                            onClick={() => runEvaluation(c.id)}
                            disabled={isRunning}
                            className="text-[11px] px-2.5 py-1 rounded-[6px] bg-ink text-white font-semibold hover:bg-grey-15 disabled:opacity-50 transition-colors"
                          >
                            {isRunning ? 'Running…' : ev ? 'Re-run' : 'Run'}
                          </button>
                        </div>
                        {expandedJd === c.id && (
                          <div className="mt-3">
                            <div className="text-[10px] font-mono uppercase text-grey-35 tracking-wider mb-1.5 flex items-center justify-between">
                              <span>Position description</span>
                              <button
                                onClick={() => setExpandedJd(null)}
                                className="text-grey-40 hover:text-ink"
                              >
                                Close
                              </button>
                            </div>
                            <textarea
                              value={jdOverrides[c.id] ?? ''}
                              onChange={(e) =>
                                setJdOverrides((cur) => ({ ...cur, [c.id]: e.target.value }))
                              }
                              rows={8}
                              className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-[12px] font-mono focus:outline-none focus:border-brand-500"
                              placeholder="Paste a custom JD for this candidate, or leave the default…"
                            />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {selectedEvaluations.length > 0 && (
              <ComparisonTable
                candidates={selectedCandidates}
                evaluations={selectedEvaluations}
                criteriaNames={allCriteriaNames}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ComparisonTable({
  candidates,
  evaluations,
  criteriaNames,
}: {
  candidates: Candidate[]
  evaluations: Evaluation[]
  criteriaNames: string[]
}) {
  // Map sessionId → evaluation for column lookup
  const bySession = useMemo(() => {
    const m = new Map<string, Evaluation>()
    for (const e of evaluations) m.set(e.sessionId, e)
    return m
  }, [evaluations])

  const orderedCandidates = candidates.filter((c) => bySession.has(c.id))

  return (
    <div className="bg-white border border-surface-border rounded-[12px] overflow-hidden">
      <div className="px-4 py-3 border-b border-surface-border">
        <div className="text-[11px] font-mono uppercase text-grey-35 tracking-wider">
          Comparison
        </div>
        <div className="text-[12px] text-grey-40 mt-0.5">
          Criteria differ per role — dashes mean a candidate's JD didn't include that axis.
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-border bg-surface-light/50">
              <th className="px-4 py-2.5 text-left text-[11px] font-mono uppercase text-grey-35 tracking-wider min-w-[200px]">
                Criterion
              </th>
              {orderedCandidates.map((c) => (
                <th
                  key={c.id}
                  className="px-3 py-2.5 text-left text-[11px] font-medium text-ink min-w-[160px]"
                >
                  {c.candidateName || '(no name)'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-surface-border bg-surface-light/30">
              <td className="px-4 py-2.5 text-[12px] font-mono uppercase text-grey-35">Overall</td>
              {orderedCandidates.map((c) => {
                const ev = bySession.get(c.id)!
                return (
                  <td key={c.id} className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={`text-[16px] font-bold tabular-nums ${scoreColor(ev.overallScore)}`}>
                        {ev.overallScore}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${RECOMMENDATION_COLOR[ev.recommendation]}`}>
                        {RECOMMENDATION_LABEL[ev.recommendation]}
                      </span>
                    </div>
                  </td>
                )
              })}
            </tr>
            {criteriaNames.map((name) => (
              <tr key={name} className="border-b border-surface-border">
                <td className="px-4 py-2.5 text-[12px] text-ink font-medium">{name}</td>
                {orderedCandidates.map((c) => {
                  const ev = bySession.get(c.id)!
                  const crit = ev.criteria.find((x) => x.name === name)
                  if (!crit) {
                    return (
                      <td key={c.id} className="px-3 py-2.5 text-[12px] text-grey-50">
                        —
                      </td>
                    )
                  }
                  return (
                    <td key={c.id} className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className={`text-[13px] font-semibold tabular-nums w-8 ${scoreColor(crit.score)}`}>
                          {crit.score}
                        </span>
                        <div className="flex-1 h-1.5 bg-surface-light rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${scoreBarColor(crit.score)}`}
                            style={{ width: `${crit.score}%` }}
                          />
                        </div>
                      </div>
                      <div className="text-[10px] text-grey-50 mt-1 line-clamp-2" title={crit.evidence}>
                        {crit.evidence}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
            <tr className="border-b border-surface-border">
              <td className="px-4 py-2.5 text-[12px] text-ink font-medium align-top">Strengths</td>
              {orderedCandidates.map((c) => {
                const ev = bySession.get(c.id)!
                return (
                  <td key={c.id} className="px-3 py-2.5 align-top">
                    {ev.strengths.length === 0 ? (
                      <span className="text-[12px] text-grey-50">—</span>
                    ) : (
                      <ul className="text-[11px] text-grey-15 space-y-1 list-disc list-inside">
                        {ev.strengths.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                )
              })}
            </tr>
            <tr className="border-b border-surface-border">
              <td className="px-4 py-2.5 text-[12px] text-ink font-medium align-top">Weaknesses</td>
              {orderedCandidates.map((c) => {
                const ev = bySession.get(c.id)!
                return (
                  <td key={c.id} className="px-3 py-2.5 align-top">
                    {ev.weaknesses.length === 0 ? (
                      <span className="text-[12px] text-grey-50">—</span>
                    ) : (
                      <ul className="text-[11px] text-grey-15 space-y-1 list-disc list-inside">
                        {ev.weaknesses.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                )
              })}
            </tr>
            <tr>
              <td className="px-4 py-2.5 text-[12px] text-ink font-medium align-top">Summary</td>
              {orderedCandidates.map((c) => {
                const ev = bySession.get(c.id)!
                return (
                  <td key={c.id} className="px-3 py-2.5 align-top text-[11px] text-grey-15">
                    {ev.summary}
                  </td>
                )
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
