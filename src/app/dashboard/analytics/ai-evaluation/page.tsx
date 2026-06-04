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
  // Funnel stage id (e.g. 'training_in_progress'). Lined up with the active
  // pipeline's stages[] so the picker can filter to a single column.
  pipelineStatus: string | null
}

interface Stage {
  id: string
  label: string
  tone?: string
  color?: string
}

interface Pipeline {
  id: string
  name: string
  isDefault: boolean
  stages: Stage[]
  flowCount: number
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

  // Pipeline + stage filters. Each pipeline owns its own stage list, so
  // changing the pipeline resets the stage filter to "All". `pipelineId=''`
  // means "All pipelines" (no server-side filter applied); same for stage.
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [pipelineId, setPipelineId] = useState('')
  const [stageId, setStageId] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  // Preserve previously-loaded candidate metadata across filter changes.
  // When the recruiter selects three candidates from pipeline A and then
  // switches to pipeline B, the selection (and the comparison table) must
  // still render the candidates from A even though they're no longer in the
  // filtered list. Without this stash, selectedCandidates collapses to []
  // every time the filter narrows.
  const [candidateCache, setCandidateCache] = useState<Map<string, Candidate>>(new Map())

  // JD override: keyed by sessionId. Empty string = use the default JD.
  // We preload the default JD into the textarea so the recruiter can edit
  // before running.
  const [jdOverrides, setJdOverrides] = useState<Record<string, string>>({})
  const [expandedJd, setExpandedJd] = useState<string | null>(null)

  // Initial load: pipelines + first candidates page + existing evaluations.
  useEffect(() => {
    void (async () => {
      try {
        const [candidatesRes, evalsRes, pipelinesRes] = await Promise.all([
          fetch('/api/candidates'),
          fetch('/api/evaluations'),
          fetch('/api/pipelines'),
        ])
        const candidatesData = await candidatesRes.json()
        const evalsData = await evalsRes.json()
        const pipelinesData = pipelinesRes.ok ? await pipelinesRes.json() : []
        // /api/candidates returns either { candidates: [] } or [] depending on
        // the route shape. Handle both.
        const list: Candidate[] = Array.isArray(candidatesData)
          ? candidatesData
          : candidatesData.candidates ?? []
        setCandidates(list)
        setCandidateCache((cur) => {
          const next = new Map(cur)
          for (const c of list) next.set(c.id, c)
          return next
        })
        const map: Record<string, Evaluation> = {}
        for (const e of (evalsData.evaluations ?? []) as Evaluation[]) {
          if (!map[e.sessionId]) map[e.sessionId] = e
        }
        setEvaluations(map)
        setPipelines(Array.isArray(pipelinesData) ? pipelinesData : [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // Refetch candidates when pipeline / stage filter changes. Skips the first
  // run (loading=true) — the initial load above already populated the list.
  useEffect(() => {
    if (loading) return
    const params = new URLSearchParams()
    if (pipelineId) params.set('pipelineId', pipelineId)
    if (stageId) params.set('status', stageId)
    setRefreshing(true)
    void (async () => {
      try {
        const res = await fetch(`/api/candidates?${params.toString()}`)
        const data = await res.json()
        const list: Candidate[] = Array.isArray(data) ? data : data.candidates ?? []
        setCandidates(list)
        setCandidateCache((cur) => {
          const next = new Map(cur)
          for (const c of list) next.set(c.id, c)
          return next
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        setRefreshing(false)
      }
    })()
  }, [pipelineId, stageId, loading])

  // Stages of the active pipeline. Empty when "All pipelines" is selected.
  const activeStages = useMemo<Stage[]>(() => {
    if (!pipelineId) return []
    const p = pipelines.find((x) => x.id === pipelineId)
    return p?.stages ?? []
  }, [pipelines, pipelineId])

  // Selecting a different pipeline resets the stage filter — pipelines own
  // their own stage lists so the previously selected stage id likely doesn't
  // exist in the new pipeline.
  const onPipelineChange = (id: string) => {
    setPipelineId(id)
    setStageId('')
  }

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

  // Resolve selected ids through the cache so previously-loaded candidates
  // still render after a filter change hides them from `candidates`.
  const selectedCandidates = useMemo(
    () =>
      Array.from(selected)
        .map((id) => candidateCache.get(id))
        .filter((c): c is Candidate => c !== undefined),
    [selected, candidateCache],
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
            <div className="px-4 py-3 border-b border-surface-border space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-mono uppercase text-grey-35 tracking-wider">
                  Select candidates ({selected.size})
                </div>
                {selected.size > 0 && (
                  <button
                    onClick={() => setSelected(new Set())}
                    className="text-[10px] text-grey-40 hover:text-ink underline-offset-2 hover:underline"
                  >
                    Clear selection
                  </button>
                )}
              </div>
              {/* Pipeline + stage filters. Same filter shape the candidates
                  kanban uses (server resolves via /api/candidates?pipelineId=&status=).
                  Selections survive filter changes — see candidateCache. */}
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={pipelineId}
                  onChange={(e) => onPipelineChange(e.target.value)}
                  className="px-2.5 py-1.5 border border-surface-border rounded-[8px] text-[12px] focus:outline-none focus:border-brand-500 bg-white"
                  title="Filter by pipeline"
                >
                  <option value="">All pipelines</option>
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.flowCount})
                    </option>
                  ))}
                </select>
                <select
                  value={stageId}
                  onChange={(e) => setStageId(e.target.value)}
                  disabled={!pipelineId || activeStages.length === 0}
                  className="px-2.5 py-1.5 border border-surface-border rounded-[8px] text-[12px] focus:outline-none focus:border-brand-500 bg-white disabled:bg-surface disabled:text-grey-50"
                  title={pipelineId ? 'Filter by stage' : 'Pick a pipeline first'}
                >
                  <option value="">All stages</option>
                  {activeStages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="search"
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm focus:outline-none focus:border-brand-500"
              />
              {refreshing && (
                <div className="text-[10px] font-mono uppercase text-grey-40 tracking-wider">
                  Refreshing…
                </div>
              )}
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
                // Resolve the stage label from the active pipeline, falling
                // back to the raw stage id when no pipeline is selected
                // (cross-pipeline view).
                const stageLabel = c.pipelineStatus
                  ? activeStages.find((s) => s.id === c.pipelineStatus)?.label ?? c.pipelineStatus
                  : null
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
                      <div className="text-[11px] text-grey-40 truncate flex items-center gap-1.5">
                        <span className="truncate">{c.candidateEmail ?? '—'}</span>
                        <span>·</span>
                        <span className="truncate">{c.flow?.name ?? 'no flow'}</span>
                        {stageLabel && (
                          <>
                            <span>·</span>
                            <span className="shrink-0 px-1 rounded bg-surface text-grey-35 text-[10px] font-medium truncate max-w-[80px]">
                              {stageLabel}
                            </span>
                          </>
                        )}
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
