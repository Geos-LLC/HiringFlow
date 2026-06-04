/**
 * Candidate detail — AI Training Calls panel.
 *
 * Lets the recruiter:
 *   - See every AICallCandidate already linked to this Session
 *   - Create a new AICallCandidate agent link pre-bound to this Session
 *     (without leaving the candidate page)
 *   - Map an existing unlinked AICallCandidate to this Session
 *   - Run the AI Evaluation for this candidate inline and see the latest score
 *
 * The evaluation block surfaces below the agent list. Empty state shows a CTA
 * to create a call link.
 */

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

interface Agent { agent_id: string; name: string }
interface LinkedAICandidate {
  id: string
  name: string
  agentId: string
  conversationIds: string[]
  createdAt: string
}
interface AICandidateAny extends LinkedAICandidate {
  sessionId?: string | null
}
interface SourcesSummary {
  meetings: Array<{ id: string; durationSec: number | null; attended: boolean }>
  aiCalls: Array<{ conversationId: string; durationSecs: number; hasTranscript: boolean }>
  captures: Array<{ id: string; mode: string; hasTranscript: boolean }>
}

interface Evaluation {
  id: string
  overallScore: number
  recommendation: 'strong_hire' | 'hire' | 'borderline' | 'no_hire'
  summary: string
  criteria: Array<{ name: string; description: string; weight: number; score: number; evidence: string }>
  strengths: string[]
  weaknesses: string[]
  positionDescriptionSnapshot: string
  sources?: SourcesSummary
  createdAt: string
}

function describeSources(s: SourcesSummary | undefined): Array<{ icon: string; label: string; ok: boolean }> {
  if (!s) return []
  const out: Array<{ icon: string; label: string; ok: boolean }> = []
  if (s.aiCalls.length > 0) {
    const mins = Math.round(s.aiCalls.reduce((a, b) => a + (b.durationSecs ?? 0), 0) / 60)
    out.push({
      icon: '🎙️',
      label: `${s.aiCalls.length} AI call${s.aiCalls.length === 1 ? '' : 's'}${mins ? ` · ${mins}m` : ''}`,
      ok: s.aiCalls.some((c) => c.hasTranscript),
    })
  }
  const video = s.captures.filter((c) => c.mode === 'video' || c.mode === 'audio_video')
  const audio = s.captures.filter((c) => c.mode === 'audio')
  const text = s.captures.filter((c) => c.mode === 'text' || c.mode === 'upload')
  if (video.length > 0) out.push({ icon: '🎬', label: `${video.length} video${video.length === 1 ? '' : 's'}`, ok: video.some((c) => c.hasTranscript) })
  if (audio.length > 0) out.push({ icon: '🎧', label: `${audio.length} audio`, ok: audio.some((c) => c.hasTranscript) })
  if (text.length > 0) out.push({ icon: '📝', label: `${text.length} text`, ok: true })
  const attended = s.meetings.filter((m) => m.attended).length
  if (attended > 0) out.push({ icon: '🗓️', label: `${attended} meeting${attended === 1 ? '' : 's'}`, ok: true })
  return out
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

export function AICallsPanel({ sessionId, candidateName }: { sessionId: string; candidateName: string | null }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [linkedCandidates, setLinkedCandidates] = useState<LinkedAICandidate[]>([])
  const [unlinkedCandidates, setUnlinkedCandidates] = useState<AICandidateAny[]>([])
  const [selectedAgent, setSelectedAgent] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [showLinkExisting, setShowLinkExisting] = useState(false)

  // Evaluation state
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null)
  const [evalRunning, setEvalRunning] = useState(false)
  const [evalError, setEvalError] = useState<string | null>(null)
  const [jd, setJd] = useState<string | null>(null)
  const [jdEditing, setJdEditing] = useState(false)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [agentsRes, linkedRes, allAiRes, evalsRes] = await Promise.all([
        fetch('/api/ai-calls/agents'),
        fetch(`/api/candidates/${sessionId}/ai-call-candidates`),
        fetch('/api/ai-calls/candidates'),
        fetch(`/api/evaluations?sessionIds=${sessionId}`),
      ])
      const agentsData = agentsRes.ok ? await agentsRes.json() : []
      const linkedData = linkedRes.ok ? await linkedRes.json() : { candidates: [] }
      const allAiData = allAiRes.ok ? await allAiRes.json() : []
      const evalsData = evalsRes.ok ? await evalsRes.json() : { evaluations: [] }

      setAgents(agentsData)
      setLinkedCandidates(linkedData.candidates ?? [])
      const all = Array.isArray(allAiData) ? allAiData : []
      setUnlinkedCandidates(all.filter((c: AICandidateAny) => !c.sessionId))
      const ev = (evalsData.evaluations ?? [])[0] ?? null
      setEvaluation(ev)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const createLink = async () => {
    if (!selectedAgent) return
    setCreating(true)
    try {
      const res = await fetch(`/api/candidates/${sessionId}/ai-call-candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgent, name: candidateName }),
      })
      if (!res.ok) return
      const data = await res.json()
      setLinkedCandidates((cur) => [...cur, data.candidate])

      // Copy the candidate-facing call link to clipboard
      const origin = window.location.origin
      const link = `${origin}/call/${selectedAgent}?name=${encodeURIComponent(candidateName || 'Candidate')}`
      try {
        await navigator.clipboard.writeText(link)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch {
        // Clipboard may be blocked in non-https / sandbox; that's fine.
      }
      setShowCreate(false)
    } finally {
      setCreating(false)
    }
  }

  const linkExisting = async (aiCandidateId: string) => {
    const res = await fetch(`/api/ai-calls/candidates/${aiCandidateId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (!res.ok) return
    const moved = unlinkedCandidates.find((c) => c.id === aiCandidateId)
    if (moved) {
      setLinkedCandidates((cur) => [...cur, { ...moved }])
      setUnlinkedCandidates((cur) => cur.filter((c) => c.id !== aiCandidateId))
    }
    setShowLinkExisting(false)
  }

  const unlinkAgent = async (aiCandidateId: string) => {
    const res = await fetch(`/api/ai-calls/candidates/${aiCandidateId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: null }),
    })
    if (!res.ok) return
    const removed = linkedCandidates.find((c) => c.id === aiCandidateId)
    setLinkedCandidates((cur) => cur.filter((c) => c.id !== aiCandidateId))
    if (removed) setUnlinkedCandidates((cur) => [{ ...removed, sessionId: null }, ...cur])
  }

  const loadJd = async () => {
    if (jd !== null) return
    const res = await fetch(`/api/evaluations/preview-position-description?sessionId=${sessionId}`)
    if (!res.ok) return
    const data = await res.json()
    setJd(data.positionDescription as string)
  }

  const runEvaluation = async () => {
    setEvalRunning(true)
    setEvalError(null)
    try {
      const body: { sessionId: string; positionDescription?: string } = { sessionId }
      if (jdEditing && jd !== null) body.positionDescription = jd
      const res = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setEvaluation(data.evaluation)
      setJdEditing(false)
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : 'Evaluation failed')
    } finally {
      setEvalRunning(false)
    }
  }

  const callLinkFor = (candidateRow: LinkedAICandidate) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    return `${origin}/call/${candidateRow.agentId}?name=${encodeURIComponent(candidateRow.name)}`
  }

  if (loading) {
    return (
      <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
        <div className="text-sm text-grey-40">Loading AI training calls…</div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-grey-15">AI Training Calls & Evaluation</h3>
          <p className="text-[12px] text-grey-50 mt-0.5">
            Voice training call transcripts and AI candidate evaluation against the position description.
          </p>
        </div>
        <div className="flex gap-2">
          {unlinkedCandidates.length > 0 && (
            <button
              onClick={() => setShowLinkExisting(!showLinkExisting)}
              className="text-[12px] px-3 py-1.5 rounded-[8px] border border-surface-border text-grey-20 hover:border-grey-50 hover:text-ink transition-colors"
            >
              Link existing
            </button>
          )}
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="text-[12px] px-3 py-1.5 rounded-[8px] bg-brand-500 text-white font-semibold hover:bg-brand-600 transition-colors"
          >
            + New call link
          </button>
        </div>
      </div>

      {/* Create new agent link inline */}
      {showCreate && (
        <div className="mb-4 p-3 bg-surface rounded-[8px] border border-surface-border">
          <label className="block text-[11px] font-mono uppercase text-grey-35 tracking-wider mb-1.5">
            Agent
          </label>
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm focus:outline-none focus:border-brand-500"
          >
            <option value="">Pick an agent…</option>
            {agents.map((a) => (
              <option key={a.agent_id} value={a.agent_id}>
                {a.name}
              </option>
            ))}
          </select>
          <div className="mt-3 flex gap-2">
            <button
              onClick={createLink}
              disabled={!selectedAgent || creating}
              className="flex-1 px-3 py-2 rounded-[8px] bg-ink text-white text-[12px] font-semibold disabled:opacity-50 hover:bg-grey-15 transition-colors"
            >
              {creating ? 'Creating…' : copied ? 'Created & Copied!' : 'Create & copy candidate link'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="px-3 py-2 rounded-[8px] border border-surface-border text-[12px] text-grey-35 hover:text-ink transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Link existing AICallCandidate */}
      {showLinkExisting && (
        <div className="mb-4 p-3 bg-surface rounded-[8px] border border-surface-border">
          <div className="text-[11px] font-mono uppercase text-grey-35 tracking-wider mb-1.5">
            Pick an unlinked AI call record
          </div>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {unlinkedCandidates.map((c) => (
              <button
                key={c.id}
                onClick={() => linkExisting(c.id)}
                className="w-full text-left px-3 py-2 rounded-[6px] bg-white border border-surface-border hover:border-brand-500 text-[12px] flex items-center justify-between"
              >
                <span className="font-medium text-grey-15">{c.name}</span>
                <span className="text-[10px] text-grey-50">{c.conversationIds.length} calls</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Linked AI call records */}
      {linkedCandidates.length === 0 && !showCreate && (
        <div className="px-3 py-6 bg-surface/50 rounded-[8px] border border-dashed border-surface-border text-center mb-4">
          <div className="text-[12px] text-grey-40">No AI training calls yet.</div>
          <div className="text-[11px] text-grey-50 mt-1">
            Create a call link to send this candidate a training scenario.
          </div>
        </div>
      )}

      {linkedCandidates.length > 0 && (
        <div className="space-y-2 mb-5">
          {linkedCandidates.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-2 px-3 py-2 rounded-[8px] bg-surface/40 border border-surface-border"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-grey-15 truncate">{c.name}</div>
                <div className="text-[10px] text-grey-50">
                  Agent {c.agentId.slice(0, 12)}… · {c.conversationIds.length} call{c.conversationIds.length === 1 ? '' : 's'}
                </div>
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(callLinkFor(c))}
                className="text-[11px] px-2 py-1 rounded-[6px] text-grey-35 hover:text-ink hover:bg-white transition-colors"
                title="Copy candidate call link"
              >
                Copy link
              </button>
              <button
                onClick={() => unlinkAgent(c.id)}
                className="text-grey-50 hover:text-red-500 text-lg leading-none px-1"
                title="Unlink"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Evaluation section */}
      <div className="pt-4 border-t border-surface-border">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[12px] font-semibold text-grey-15">AI Candidate Evaluation</div>
            <div className="text-[11px] text-grey-50">
              Scores transcripts (AI calls, self-intro recordings, meetings) against the position description.
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                await loadJd()
                setJdEditing(!jdEditing)
              }}
              className="text-[11px] px-2 py-1 rounded-[6px] border border-surface-border text-grey-35 hover:border-grey-50 hover:text-ink transition-colors"
            >
              {jdEditing ? 'Hide JD' : 'View JD'}
            </button>
            <button
              onClick={runEvaluation}
              disabled={evalRunning}
              className="text-[11px] px-3 py-1 rounded-[6px] bg-ink text-white font-semibold hover:bg-grey-15 disabled:opacity-50 transition-colors"
            >
              {evalRunning ? 'Evaluating…' : evaluation ? 'Re-run' : 'Run evaluation'}
            </button>
          </div>
        </div>

        {jdEditing && (
          <div className="mb-3">
            <textarea
              value={jd ?? ''}
              onChange={(e) => setJd(e.target.value)}
              rows={6}
              className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-[12px] font-mono focus:outline-none focus:border-brand-500"
              placeholder="Position description…"
            />
            <div className="text-[10px] text-grey-50 mt-1">
              Edited JD is only used for the next evaluation run; it is not saved back to the flow.
            </div>
          </div>
        )}

        {evalError && (
          <div className="mb-3 px-3 py-2 rounded-[6px] border border-red-200 bg-red-50 text-red-700 text-[12px]">
            {evalError}
          </div>
        )}

        {evaluation ? (
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className={`text-2xl font-bold tabular-nums ${scoreColor(evaluation.overallScore)}`}>
                {evaluation.overallScore}
                <span className="text-[12px] text-grey-50 font-normal">/100</span>
              </div>
              <div className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${RECOMMENDATION_COLOR[evaluation.recommendation]}`}>
                {RECOMMENDATION_LABEL[evaluation.recommendation]}
              </div>
              <Link
                href="/dashboard/analytics/ai-evaluation"
                className="ml-auto text-[11px] text-grey-40 hover:text-ink"
              >
                Compare in Analytics →
              </Link>
            </div>
            {/* Source badges — confirms which transcripts/recordings actually
                got fed to the model. Amber = no transcript available so only
                metadata reached the prompt. */}
            {describeSources(evaluation.sources).length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mb-3">
                <span className="text-[10px] font-mono uppercase text-grey-40 tracking-wider">
                  Evaluated:
                </span>
                {describeSources(evaluation.sources).map((b, i) => (
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
            <div className="text-[12px] text-grey-15 mb-3">{evaluation.summary}</div>
            <div className="space-y-1.5">
              {evaluation.criteria.map((c) => (
                <div key={c.name} className="flex items-center gap-2 text-[11px]">
                  <span className="w-44 truncate text-grey-20" title={c.description}>
                    {c.name}
                  </span>
                  <span className={`font-mono w-8 tabular-nums ${scoreColor(c.score)}`}>{c.score}</span>
                  <div className="flex-1 h-1.5 bg-surface rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        c.score >= 85 ? 'bg-emerald-500' : c.score >= 70 ? 'bg-sky-500' : c.score >= 55 ? 'bg-amber-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${c.score}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              {evaluation.strengths.length > 0 && (
                <div>
                  <div className="text-[10px] font-mono uppercase text-emerald-600 tracking-wider mb-1">
                    Strengths
                  </div>
                  <ul className="text-[11px] text-grey-15 space-y-0.5 list-disc list-inside">
                    {evaluation.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {evaluation.weaknesses.length > 0 && (
                <div>
                  <div className="text-[10px] font-mono uppercase text-red-600 tracking-wider mb-1">
                    Weaknesses
                  </div>
                  <ul className="text-[11px] text-grey-15 space-y-0.5 list-disc list-inside">
                    {evaluation.weaknesses.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="text-[10px] text-grey-50 mt-3">
              Last run {new Date(evaluation.createdAt).toLocaleString()}
            </div>
          </div>
        ) : (
          <div className="text-[12px] text-grey-50">
            No evaluation yet. Click <span className="font-medium text-grey-20">Run evaluation</span> to score the candidate.
          </div>
        )}
      </div>
    </div>
  )
}
