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

interface SourcesSummary {
  meetings: Array<{ id: string; durationSec: number | null; attended: boolean }>
  aiCalls: Array<{ conversationId: string; durationSecs: number; hasTranscript: boolean }>
  captures: Array<{ id: string; mode: string; hasTranscript: boolean }>
}

interface VoiceClipObservation {
  assetType: string
  assetId: string
  durationSec: number | null
  pace: string
  clarity: string
  hesitation: string
  energy: string
  articulation: string
  evidence: string[]
}
interface VideoClipObservation {
  assetType: string
  assetId: string
  durationSec: number | null
  cameraPresence: string
  presentation: string
  engagement: string
  evidence: string[]
}
interface VoiceObservation {
  clips: VoiceClipObservation[]
  summary: string
}
interface VideoObservation {
  clips: VideoClipObservation[]
  summary: string
  unavailableReason?: string
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
  sources?: SourcesSummary
  includeVoice?: boolean
  includeVideo?: boolean
  voiceObservation?: VoiceObservation | null
  videoObservation?: VideoObservation | null
  createdAt: string
  session?: {
    candidateName: string | null
    candidateEmail: string | null
    flow?: { name: string | null } | null
  }
}

type JdSource = 'override' | 'flow' | 'ad' | 'fallback_ad' | 'flow_start' | 'flow_name'
const JD_SOURCE_LABEL: Record<JdSource, string> = {
  override: 'Custom override',
  flow: 'Saved on flow',
  ad: 'Linked ad copy',
  fallback_ad: 'Flow ad copy',
  flow_start: 'Flow start message',
  flow_name: 'Flow name only',
}
const JD_SOURCE_TONE: Record<JdSource, string> = {
  override: 'bg-violet-50 text-violet-700 border-violet-200',
  flow: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  ad: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  fallback_ad: 'bg-sky-50 text-sky-700 border-sky-200',
  flow_start: 'bg-amber-50 text-amber-700 border-amber-200',
  flow_name: 'bg-red-50 text-red-700 border-red-200',
}

// Render the data-sources summary as small icon badges. Used inline anywhere
// we want to show "what got fed to the model". Format: 🎙️ 2 AI calls (3m)
// · 🎬 1 video · 📋 form etc.
function describeSources(s: SourcesSummary | undefined): Array<{ icon: string; label: string; ok: boolean }> {
  if (!s) return []
  const out: Array<{ icon: string; label: string; ok: boolean }> = []

  const aiCallTotal = s.aiCalls.length
  const aiCallWithTranscript = s.aiCalls.filter((c) => c.hasTranscript).length
  if (aiCallTotal > 0) {
    const mins = Math.round(s.aiCalls.reduce((a, b) => a + (b.durationSecs ?? 0), 0) / 60)
    out.push({
      icon: '🎙️',
      label: `${aiCallTotal} AI call${aiCallTotal === 1 ? '' : 's'}${mins ? ` · ${mins}m` : ''}`,
      ok: aiCallWithTranscript > 0,
    })
  }

  const videoCaptures = s.captures.filter((c) => c.mode === 'video' || c.mode === 'audio_video')
  const audioCaptures = s.captures.filter((c) => c.mode === 'audio')
  const textCaptures = s.captures.filter((c) => c.mode === 'text' || c.mode === 'upload')
  if (videoCaptures.length > 0) {
    out.push({
      icon: '🎬',
      label: `${videoCaptures.length} video${videoCaptures.length === 1 ? '' : 's'}`,
      ok: videoCaptures.some((c) => c.hasTranscript),
    })
  }
  if (audioCaptures.length > 0) {
    out.push({
      icon: '🎧',
      label: `${audioCaptures.length} audio`,
      ok: audioCaptures.some((c) => c.hasTranscript),
    })
  }
  if (textCaptures.length > 0) {
    out.push({ icon: '📝', label: `${textCaptures.length} text`, ok: true })
  }

  const meetingsAttended = s.meetings.filter((m) => m.attended).length
  if (meetingsAttended > 0) {
    out.push({
      icon: '🗓️',
      label: `${meetingsAttended} meeting${meetingsAttended === 1 ? '' : 's'}`,
      ok: true,
    })
  }
  return out
}

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime()
  const diff = Date.now() - d
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
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

  // AI Media Observation toggles. Apply to every Run action while checked.
  // Voice is real (gpt-4o-audio-preview on candidate audio). Video stub
  // returns "frame extraction not yet provisioned" — the checkbox is wired
  // so the UI is final, the engine is ready, the Lambda lands later.
  const [includeVoice, setIncludeVoice] = useState(false)
  const [includeVideo, setIncludeVideo] = useState(false)

  // JD override: keyed by sessionId. Undefined = use the default JD; empty
  // string = the recruiter intentionally blanked it. We preload the resolved
  // default JD into the textarea so the recruiter can edit before running.
  const [jdOverrides, setJdOverrides] = useState<Record<string, string>>({})
  // JD source + originating flowId per candidate, so the UI can show
  // "Saved on flow / Linked ad copy / Flow ad copy / Flow name only" and
  // the Save-to-flow button can target the correct flow.
  const [jdMeta, setJdMeta] = useState<Record<string, { source: JdSource; flowId: string | null }>>({})
  const [expandedJd, setExpandedJd] = useState<string | null>(null)
  const [savingJd, setSavingJd] = useState<string | null>(null)
  const [savedJdAt, setSavedJdAt] = useState<Record<string, number>>({})

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

  const previewJd = useCallback(
    async (sessionId: string) => {
      if (jdOverrides[sessionId] !== undefined && jdMeta[sessionId]) {
        return { text: jdOverrides[sessionId], source: jdMeta[sessionId].source, flowId: jdMeta[sessionId].flowId }
      }
      const res = await fetch(`/api/evaluations/preview-position-description?sessionId=${sessionId}`)
      if (!res.ok) return { text: '', source: 'flow_name' as JdSource, flowId: null }
      const data = await res.json()
      return {
        text: data.positionDescription as string,
        source: (data.source as JdSource) ?? 'flow_name',
        flowId: (data.flowId as string | null) ?? null,
      }
    },
    [jdOverrides, jdMeta],
  )

  const openJdEditor = async (sessionId: string) => {
    setExpandedJd(sessionId)
    if (jdOverrides[sessionId] === undefined) {
      const { text, source, flowId } = await previewJd(sessionId)
      setJdOverrides((cur) => ({ ...cur, [sessionId]: text }))
      setJdMeta((cur) => ({ ...cur, [sessionId]: { source, flowId } }))
    }
  }

  // Save the current JD draft to the candidate's flow so every future eval
  // run on candidates of that flow inherits it (no override needed). PATCHes
  // Flow.positionDescription. Refreshes the source label to 'flow' on success.
  const saveJdToFlow = async (sessionId: string) => {
    const meta = jdMeta[sessionId]
    if (!meta?.flowId) return
    const text = jdOverrides[sessionId]
    if (text === undefined) return
    setSavingJd(sessionId)
    try {
      const res = await fetch(`/api/flows/${meta.flowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionDescription: text }),
      })
      if (!res.ok) throw new Error('save failed')
      setJdMeta((cur) => ({ ...cur, [sessionId]: { ...meta, source: 'flow' } }))
      setSavedJdAt((cur) => ({ ...cur, [sessionId]: Date.now() }))
      setTimeout(() => {
        setSavedJdAt((cur) => {
          const next = { ...cur }
          delete next[sessionId]
          return next
        })
      }, 2500)
    } catch {
      setError('Failed to save JD to flow')
    } finally {
      setSavingJd(null)
    }
  }

  const runEvaluation = async (sessionId: string) => {
    setRunning((s) => new Set(s).add(sessionId))
    setError(null)
    try {
      const body: {
        sessionId: string
        positionDescription?: string
        includeVoice?: boolean
        includeVideo?: boolean
      } = { sessionId }
      const override = jdOverrides[sessionId]
      if (override !== undefined) body.positionDescription = override
      if (includeVoice) body.includeVoice = true
      if (includeVideo) body.includeVideo = true

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

        <EvaluationCards
          evaluations={evaluations}
          candidateCache={candidateCache}
          selected={selected}
          onToggleSelect={(id) =>
            setSelected((cur) => {
              const next = new Set(cur)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }
        />

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
                <div className="px-4 py-3 border-b border-surface-border space-y-2">
                  <div className="flex items-center justify-between">
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
                  {/* AI Media Observation toggles. Voice runs gpt-4o-audio
                      observation on the candidate's audio captures + latest
                      AI call. Video stub returns "frame extractor not
                      provisioned" — checkbox is wired for forward
                      compatibility. */}
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <label className="inline-flex items-center gap-1.5 text-[12px] text-grey-20 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={includeVoice}
                        onChange={(e) => setIncludeVoice(e.target.checked)}
                        className="rounded border-surface-border"
                      />
                      🎙️ Include voice observation
                      <span className="text-[10px] text-grey-50 font-normal">
                        (pace, clarity, hesitation, energy, articulation)
                      </span>
                    </label>
                    <label className="inline-flex items-center gap-1.5 text-[12px] text-grey-20 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={includeVideo}
                        onChange={(e) => setIncludeVideo(e.target.checked)}
                        className="rounded border-surface-border"
                      />
                      🎬 Include video observation
                      <span className="text-[10px] text-grey-50 font-normal">
                        (camera presence, presentation, engagement)
                      </span>
                    </label>
                    {includeVideo && (
                      <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                        Video frame extraction not yet provisioned — will skip with notice
                      </span>
                    )}
                  </div>
                </div>
                <div className="divide-y divide-surface-border">
                  {selectedCandidates.map((c) => {
                    const ev = evaluations[c.id]
                    const isRunning = running.has(c.id)
                    const meta = jdMeta[c.id]
                    const sourceBadges = describeSources(ev?.sources)
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
                        {/* Saved-eval surface: timestamp + sources fed to the
                            model. Lets the recruiter open a candidate and see
                            "what got scored" without clicking Run again. */}
                        {ev && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <span className="text-[10px] font-mono uppercase text-grey-40 tracking-wider">
                              Saved · {timeAgo(ev.createdAt)}
                            </span>
                            {sourceBadges.length === 0 && (
                              <span className="text-[10px] text-grey-50">no sources captured</span>
                            )}
                            {sourceBadges.map((b, i) => (
                              <span
                                key={i}
                                className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                                  b.ok
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    : 'bg-amber-50 text-amber-700 border-amber-200'
                                }`}
                                title={b.ok ? 'Transcript available' : 'No transcript — metadata only'}
                              >
                                {b.icon} {b.label}
                              </span>
                            ))}
                          </div>
                        )}
                        {expandedJd === c.id && (
                          <div className="mt-3">
                            <div className="text-[10px] font-mono uppercase text-grey-35 tracking-wider mb-1.5 flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5">
                                <span>Position description</span>
                                {meta && (
                                  <span className={`px-1.5 py-0.5 rounded-full border text-[10px] normal-case font-normal ${JD_SOURCE_TONE[meta.source]}`}>
                                    {JD_SOURCE_LABEL[meta.source]}
                                  </span>
                                )}
                              </div>
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
                            <div className="mt-2 flex items-center justify-between gap-2">
                              <div className="text-[10px] text-grey-50">
                                {meta?.source === 'flow' || meta?.source === 'ad'
                                  ? 'This JD already has rich content. Edit and save to flow to persist for all candidates of this flow.'
                                  : meta?.source === 'flow_name'
                                    ? '⚠ Falling back to the flow name only. Save a real JD to the flow for better evaluations.'
                                    : 'Paste a richer JD if needed, then save to flow so future candidates inherit it.'}
                              </div>
                              {meta?.flowId && (
                                <button
                                  onClick={() => saveJdToFlow(c.id)}
                                  disabled={savingJd === c.id}
                                  className="shrink-0 text-[11px] px-2.5 py-1 rounded-[6px] bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                                >
                                  {savingJd === c.id
                                    ? 'Saving…'
                                    : savedJdAt[c.id]
                                      ? 'Saved!'
                                      : 'Save to flow'}
                                </button>
                              )}
                            </div>
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
            {/* Data sources fed to the model. Empty/amber badges = no transcript
                or metadata-only — eval was constrained by what was actually
                captured. */}
            <tr className="border-b border-surface-border">
              <td className="px-4 py-2.5 text-[11px] font-mono uppercase text-grey-35 align-top">
                Sources evaluated
              </td>
              {orderedCandidates.map((c) => {
                const ev = bySession.get(c.id)!
                const badges = describeSources(ev.sources)
                return (
                  <td key={c.id} className="px-3 py-2.5">
                    {badges.length === 0 ? (
                      <span className="text-[11px] text-grey-50">No recorded material</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {badges.map((b, i) => (
                          <span
                            key={i}
                            className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                              b.ok
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : 'bg-amber-50 text-amber-700 border-amber-200'
                            }`}
                            title={b.ok ? 'Transcript available' : 'No transcript — metadata only'}
                          >
                            {b.icon} {b.label}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="text-[10px] text-grey-50 mt-1.5">
                      Saved {timeAgo(ev.createdAt)}
                    </div>
                  </td>
                )
              })}
            </tr>
            {/* Voice observation (AI media observation, descriptive only).
                Shown only when at least one selected eval had includeVoice. */}
            {orderedCandidates.some((c) => bySession.get(c.id)?.includeVoice) && (
              <tr className="border-b border-surface-border">
                <td className="px-4 py-2.5 text-[11px] font-mono uppercase text-grey-35 align-top">
                  🎙️ Voice
                </td>
                {orderedCandidates.map((c) => {
                  const ev = bySession.get(c.id)!
                  const voice = ev.voiceObservation
                  if (!ev.includeVoice) {
                    return (
                      <td key={c.id} className="px-3 py-2.5 align-top text-[11px] text-grey-50">
                        not included
                      </td>
                    )
                  }
                  if (!voice || voice.clips.length === 0) {
                    return (
                      <td key={c.id} className="px-3 py-2.5 align-top text-[11px] text-grey-50">
                        no audio clips
                      </td>
                    )
                  }
                  // Aggregate one short line per dimension from the first clip
                  // (most representative). Click to drill into a tooltip.
                  const first = voice.clips[0]
                  return (
                    <td key={c.id} className="px-3 py-2.5 align-top text-[11px] text-grey-15">
                      {voice.summary && (
                        <div className="mb-1.5 italic text-grey-25">{voice.summary}</div>
                      )}
                      <dl className="space-y-0.5">
                        <div><dt className="inline font-semibold text-grey-20">Pace: </dt><dd className="inline">{first.pace}</dd></div>
                        <div><dt className="inline font-semibold text-grey-20">Clarity: </dt><dd className="inline">{first.clarity}</dd></div>
                        <div><dt className="inline font-semibold text-grey-20">Hesitation: </dt><dd className="inline">{first.hesitation}</dd></div>
                        <div><dt className="inline font-semibold text-grey-20">Energy: </dt><dd className="inline">{first.energy}</dd></div>
                        <div><dt className="inline font-semibold text-grey-20">Articulation: </dt><dd className="inline">{first.articulation}</dd></div>
                      </dl>
                      {voice.clips.length > 1 && (
                        <div className="text-[10px] text-grey-50 mt-1">+ {voice.clips.length - 1} more clip{voice.clips.length === 2 ? '' : 's'}</div>
                      )}
                    </td>
                  )
                })}
              </tr>
            )}
            {/* Video observation. Stubbed for now — surfaces the unavailable
                reason so the recruiter sees that "video frame extraction
                pipeline is not provisioned yet". */}
            {orderedCandidates.some((c) => bySession.get(c.id)?.includeVideo) && (
              <tr className="border-b border-surface-border">
                <td className="px-4 py-2.5 text-[11px] font-mono uppercase text-grey-35 align-top">
                  🎬 Video
                </td>
                {orderedCandidates.map((c) => {
                  const ev = bySession.get(c.id)!
                  if (!ev.includeVideo) {
                    return (
                      <td key={c.id} className="px-3 py-2.5 align-top text-[11px] text-grey-50">
                        not included
                      </td>
                    )
                  }
                  const video = ev.videoObservation
                  if (!video || video.clips.length === 0) {
                    return (
                      <td key={c.id} className="px-3 py-2.5 align-top text-[11px] text-amber-700">
                        {video?.unavailableReason ?? 'Not available'}
                      </td>
                    )
                  }
                  const first = video.clips[0]
                  return (
                    <td key={c.id} className="px-3 py-2.5 align-top text-[11px] text-grey-15">
                      {video.summary && (
                        <div className="mb-1.5 italic text-grey-25">{video.summary}</div>
                      )}
                      <dl className="space-y-0.5">
                        <div><dt className="inline font-semibold text-grey-20">Presentation: </dt><dd className="inline">{first.presentation}</dd></div>
                        <div><dt className="inline font-semibold text-grey-20">Camera presence: </dt><dd className="inline">{first.cameraPresence}</dd></div>
                        <div><dt className="inline font-semibold text-grey-20">Engagement: </dt><dd className="inline">{first.engagement}</dd></div>
                      </dl>
                    </td>
                  )
                })}
              </tr>
            )}
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

/**
 * Saved-evaluations cards strip. Sits above the picker so the recruiter can
 * see every candidate they've already evaluated without scrolling the picker
 * to find a score badge.
 *
 * Each card shows: name + email, big colored score, recommendation pill,
 * flow, source badges, "Saved Xh ago". Clicking the card toggles the
 * candidate into the selection — same effect as clicking them in the
 * picker, just easier to discover when you already have results.
 *
 * Hidden entirely when there are no saved evaluations.
 *
 * Sorted by score descending so the strongest candidates surface first.
 * Three view modes:
 *   - 'top'  : 8 cards
 *   - 'all'  : every saved evaluation (scrollable grid)
 *   - 'mine' : only currently-selected candidates' evals (debug shortcut)
 */
function EvaluationCards({
  evaluations,
  candidateCache,
  selected,
  onToggleSelect,
}: {
  evaluations: Record<string, Evaluation>
  candidateCache: Map<string, Candidate>
  selected: Set<string>
  onToggleSelect: (sessionId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [recOnly, setRecOnly] = useState<'all' | 'strong_hire' | 'hire' | 'borderline' | 'no_hire'>('all')

  // Build a sorted, optionally-filtered list of saved evaluations.
  const list = useMemo(() => {
    const arr = Object.values(evaluations)
    const filtered = recOnly === 'all' ? arr : arr.filter((e) => e.recommendation === recOnly)
    return filtered.sort((a, b) => b.overallScore - a.overallScore)
  }, [evaluations, recOnly])

  if (list.length === 0) return null

  const visible = expanded ? list : list.slice(0, 8)

  const counts = {
    all: Object.values(evaluations).length,
    strong_hire: Object.values(evaluations).filter((e) => e.recommendation === 'strong_hire').length,
    hire: Object.values(evaluations).filter((e) => e.recommendation === 'hire').length,
    borderline: Object.values(evaluations).filter((e) => e.recommendation === 'borderline').length,
    no_hire: Object.values(evaluations).filter((e) => e.recommendation === 'no_hire').length,
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[11px] font-mono uppercase text-grey-35 tracking-wider">
            Saved evaluations ({list.length})
          </div>
          <div className="text-[12px] text-grey-50">
            Click a card to add the candidate to the comparison.
          </div>
        </div>
        <div className="flex items-center gap-1">
          {(['all', 'strong_hire', 'hire', 'borderline', 'no_hire'] as const).map((key) => {
            const isActive = recOnly === key
            const label =
              key === 'all'
                ? 'All'
                : RECOMMENDATION_LABEL[key as Evaluation['recommendation']]
            const count = counts[key]
            if (count === 0 && key !== 'all') return null
            return (
              <button
                key={key}
                onClick={() => setRecOnly(key)}
                className={`px-2.5 py-1 rounded-[8px] text-[11px] font-medium border transition-colors ${
                  isActive
                    ? key === 'all'
                      ? 'bg-ink text-white border-ink'
                      : RECOMMENDATION_COLOR[key as Evaluation['recommendation']]
                    : 'bg-white text-grey-35 border-surface-border hover:border-grey-50'
                }`}
              >
                {label} <span className="tabular-nums opacity-70">{count}</span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {visible.map((ev) => {
          const cached = candidateCache.get(ev.sessionId)
          const name =
            cached?.candidateName ?? ev.session?.candidateName ?? '(no name)'
          const email =
            cached?.candidateEmail ?? ev.session?.candidateEmail ?? null
          const flowName =
            cached?.flow?.name ?? ev.session?.flow?.name ?? null
          const isSelected = selected.has(ev.sessionId)
          const badges = describeSources(ev.sources)
          return (
            <button
              key={ev.id}
              onClick={() => onToggleSelect(ev.sessionId)}
              className={`text-left bg-white border rounded-[12px] p-3.5 transition-colors hover:border-brand-500 ${
                isSelected ? 'border-brand-500 ring-1 ring-brand-500/30' : 'border-surface-border'
              }`}
              title={ev.summary}
            >
              <div className="flex items-start gap-3 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-ink truncate">{name}</div>
                  <div className="text-[11px] text-grey-40 truncate">{email ?? '—'}</div>
                  {flowName && (
                    <div className="text-[10px] text-grey-50 truncate mt-0.5">{flowName}</div>
                  )}
                </div>
                <div className="text-right">
                  <div className={`text-[22px] font-bold tabular-nums leading-none ${scoreColor(ev.overallScore)}`}>
                    {ev.overallScore}
                  </div>
                  <div className="text-[9px] font-mono text-grey-50 uppercase tracking-wider mt-0.5">
                    /100
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${RECOMMENDATION_COLOR[ev.recommendation]}`}>
                  {RECOMMENDATION_LABEL[ev.recommendation]}
                </span>
                <span className="text-[10px] text-grey-50">{timeAgo(ev.createdAt)}</span>
              </div>
              {badges.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {badges.map((b, i) => (
                    <span
                      key={i}
                      className={`text-[9px] px-1.5 py-0.5 rounded-full border ${
                        b.ok
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : 'bg-amber-50 text-amber-700 border-amber-200'
                      }`}
                    >
                      {b.icon} {b.label}
                    </span>
                  ))}
                </div>
              )}
              {isSelected && (
                <div className="text-[10px] text-brand-600 font-medium mt-2">
                  ✓ In comparison
                </div>
              )}
            </button>
          )
        })}
      </div>
      {list.length > 8 && (
        <div className="mt-3 text-center">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[12px] text-grey-35 hover:text-ink underline-offset-2 hover:underline"
          >
            {expanded ? `Show top 8` : `Show all ${list.length}`}
          </button>
        </div>
      )}
    </div>
  )
}
