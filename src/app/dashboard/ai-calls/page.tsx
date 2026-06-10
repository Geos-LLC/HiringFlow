'use client'

import { useState, useEffect } from 'react'
import { SubNav } from '../_components/SubNav'
import { PageHeader } from '@/components/design'

const TRAINING_NAV = [
  { href: '/dashboard/trainings', label: 'Trainings' },
  { href: '/dashboard/ai-calls', label: 'AI Calls' },
]

// Always-on guards for the evaluator prompt. The section editor below only manages
// MANDATORY/PRICING/PROFESSIONALISM/CRITICAL/SCORING/FEEDBACK — these two blocks
// MUST be emitted on every save or evaluations break (role inversion + unparseable
// rationale).
const EVALUATION_PREAMBLE = `**WHO YOU EVALUATE — READ FIRST:**
This is a training simulation. The AI agent in this conversation roleplays as a CUSTOMER calling a cleaning service. The human user is the DISPATCHER/STAFF MEMBER being trained. You MUST evaluate the human user (the dispatcher), NOT the AI agent. In the transcript, the dispatcher being scored is labeled as "user". All criteria below describe behaviors the dispatcher (the human) is expected to perform.`

const OUTPUT_FORMAT_FOOTER = `**OUTPUT FORMAT — REQUIRED:**
Your rationale MUST begin with the lines below, in this exact order, using these exact headers. Bullets must start with "- ". Do not output any other format.

Score: <N>/100 (<Excellent | Good | Needs Improvement | Requires Retraining>)

Areas Done Well:
- <one short sentence per item>

Areas for Improvement:
- <one short sentence per item>`

interface Agent { agent_id: string; name: string }
interface Candidate {
  id: string; name: string; agentId: string; conversationIds: string[]; createdAt: string
  // Bound HiringFlow Session (the actual candidate). Null = unattached.
  sessionId?: string | null
  session?: { id: string; candidateName: string | null; candidateEmail: string | null } | null
}
interface HFCandidate { id: string; candidateName: string | null; candidateEmail: string | null }
interface Conversation {
  conversation_id: string; status: string; start_time_unix_secs: number
  call_duration_secs: number; message_count: number; call_successful: string | null
  transcript_summary: string | null
}
interface ConversationDetail {
  conversation_id: string; status: string; call_duration_secs: number
  transcript: Array<{ role: string; message: string; time_in_call_secs: number }>
  analysis: {
    call_successful: string | null; transcript_summary: string | null
    evaluation_criteria_results: Record<string, { criteria_id: string; result: string; rationale: string }>
    data_collection_results: Record<string, { value: string; rationale: string }>
  } | null
}

export default function AICallsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [candidateName, setCandidateName] = useState('')
  const [candidateCopied, setCandidateCopied] = useState(false)

  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loadingCalls, setLoadingCalls] = useState(false)
  const [callError, setCallError] = useState('')
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null)
  const [selectedConv, setSelectedConv] = useState<ConversationDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [candidateConvs, setCandidateConvs] = useState<ConversationDetail[]>([])
  const [loadingCandidateConvs, setLoadingCandidateConvs] = useState(false)

  // Assign modal
  const [showAssign, setShowAssign] = useState(false)
  const [assignConvId, setAssignConvId] = useState('')
  const [assignCandidateId, setAssignCandidateId] = useState('')

  // HiringFlow candidates (Session rows) for the "Link to candidate" picker on
  // each AICallCandidate card. Loaded once on mount alongside the rest.
  const [hfCandidates, setHfCandidates] = useState<HFCandidate[]>([])
  const [linkOpenId, setLinkOpenId] = useState<string | null>(null)
  const [linkSearch, setLinkSearch] = useState('')

  // Criteria editor
  const [tab, setTab] = useState<'candidates' | 'criteria'>('candidates')
  const [criteriaLoading, setCriteriaLoading] = useState(false)
  const [criteriaSaving, setCriteriaSaving] = useState(false)
  const [criteriaSaved, setCriteriaSaved] = useState(false)
  const [criteriaId, setCriteriaId] = useState('')
  const [criteriaName, setCriteriaName] = useState('')
  // Parsed sections
  const [mandatoryItems, setMandatoryItems] = useState<string[]>([])
  const [pricingItems, setPricingItems] = useState<string[]>([])
  const [profItems, setProfItems] = useState<string[]>([])
  const [criticalItems, setCriticalItems] = useState<string[]>([])
  const [scoringItems, setScoringItems] = useState<string[]>([])
  const [feedbackText, setFeedbackText] = useState('')

  useEffect(() => {
    Promise.all([
      fetch('/api/workspace/settings').then(r => r.json()),
      fetch('/api/ai-calls/agents').then(r => r.ok ? r.json() : []),
      fetch('/api/ai-calls/candidates').then(r => r.ok ? r.json() : []),
      fetch('/api/candidates').then(r => r.ok ? r.json() : []),
    ]).then(([ws, agentList, candList, hfList]) => {
      setAgents(agentList)
      setCandidates(candList)
      // /api/candidates returns either a bare array or { candidates }
      const list: HFCandidate[] = Array.isArray(hfList) ? hfList : (hfList.candidates ?? [])
      setHfCandidates(list)
      const s = (ws.settings || {}) as Record<string, string>
      if (s.elevenlabs_agent_id) { setAgentId(s.elevenlabs_agent_id); fetchConversations() }
      setLoading(false)
    })
  }, [])

  const selectAgent = async (id: string) => {
    setAgentId(id); setSelectedCandidate(null); setSelectedConv(null)
    // Read-then-merge: a raw { settings: { elevenlabs_agent_id } } PATCH used
    // to wipe every other key (e.g. captureStepsEnabled), silently disabling
    // candidate-side audio recording across the whole workspace.
    const cur = await fetch('/api/workspace/settings').then(r => r.ok ? r.json() : null).catch(() => null)
    const currentSettings = (cur?.settings && typeof cur.settings === 'object') ? cur.settings : {}
    await fetch('/api/workspace/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { ...currentSettings, elevenlabs_agent_id: id } }),
    })
    if (id) fetchConversations()
  }

  const fetchConversations = async () => {
    setLoadingCalls(true); setCallError('')
    const r = await fetch('/api/ai-calls/conversations')
    if (r.ok) setConversations((await r.json()).conversations || [])
    else { const err = await r.json().catch(() => ({})); setCallError(err.error || 'Failed') }
    setLoadingCalls(false)
  }

  const createCandidateLink = async () => {
    if (!candidateName.trim() || !agentId) return
    // Save candidate
    const r = await fetch('/api/ai-calls/candidates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: candidateName.trim(), agentId }),
    })
    if (r.ok) {
      const c = await r.json()
      setCandidates(prev => [c, ...prev])
    }
    // Copy link
    const origin = process.env.NEXT_PUBLIC_APP_URL || window.location.origin
    const link = `${origin}/call/${agentId}?name=${encodeURIComponent(candidateName.trim())}`
    navigator.clipboard.writeText(link)
    setCandidateCopied(true); setTimeout(() => setCandidateCopied(false), 2000)
    setCandidateName('')
  }

  const viewCandidateConvs = async (cand: Candidate) => {
    setSelectedCandidate(cand); setSelectedConv(null); setCandidateConvs([])
    setLoadingCandidateConvs(true)

    // Auto-link: find unassigned conversations that started after candidate was created
    const allAssignedIds = candidates.flatMap(c => c.conversationIds)
    const candidateCreatedAt = Math.floor(new Date(cand.createdAt).getTime() / 1000)
    const unassigned = conversations.filter(c =>
      !allAssignedIds.includes(c.conversation_id) &&
      c.start_time_unix_secs >= candidateCreatedAt - 60 // within 1 min before creation is ok
    )

    // Auto-assign unassigned conversations to this candidate (most likely theirs)
    let updatedIds = [...cand.conversationIds]
    for (const conv of unassigned) {
      // Only auto-assign if no other candidate was created between this candidate and the conversation
      const otherCandidatesAfter = candidates.filter(c =>
        c.id !== cand.id &&
        Math.floor(new Date(c.createdAt).getTime() / 1000) > candidateCreatedAt &&
        Math.floor(new Date(c.createdAt).getTime() / 1000) <= conv.start_time_unix_secs
      )
      if (otherCandidatesAfter.length === 0 && !updatedIds.includes(conv.conversation_id)) {
        updatedIds.push(conv.conversation_id)
        // Save to backend
        await fetch(`/api/ai-calls/candidates/${cand.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: conv.conversation_id }),
        })
      }
    }

    // Update local state
    if (updatedIds.length !== cand.conversationIds.length) {
      setCandidates(prev => prev.map(c => c.id === cand.id ? { ...c, conversationIds: updatedIds } : c))
      cand = { ...cand, conversationIds: updatedIds }
    }

    // Fetch details for all linked conversations
    if (updatedIds.length === 0) { setLoadingCandidateConvs(false); return }
    const details = await Promise.all(
      updatedIds.map(async cid => {
        const r = await fetch(`/api/ai-calls/conversations/${cid}`)
        return r.ok ? r.json() : null
      })
    )
    setCandidateConvs(details.filter(Boolean))
    setLoadingCandidateConvs(false)
  }

  const assignConversation = async () => {
    if (!assignConvId || !assignCandidateId) return
    await fetch(`/api/ai-calls/candidates/${assignCandidateId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: assignConvId }),
    })
    // Refresh
    const r = await fetch('/api/ai-calls/candidates')
    if (r.ok) setCandidates(await r.json())
    setShowAssign(false); setAssignConvId(''); setAssignCandidateId('')
    if (selectedCandidate) {
      const updated = candidates.find(c => c.id === selectedCandidate.id)
      if (updated) viewCandidateConvs(updated)
    }
  }

  const deleteCandidate = async (id: string) => {
    if (!confirm('Remove this candidate?')) return
    await fetch(`/api/ai-calls/candidates/${id}`, { method: 'DELETE' })
    setCandidates(prev => prev.filter(c => c.id !== id))
    if (selectedCandidate?.id === id) { setSelectedCandidate(null); setCandidateConvs([]) }
  }

  // Bind / unbind an AICallCandidate to a HiringFlow Session. PATCH accepts
  // sessionId=null to unlink.
  const linkToSession = async (aiCandidateId: string, sessionId: string | null) => {
    const res = await fetch(`/api/ai-calls/candidates/${aiCandidateId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (!res.ok) return
    const session = sessionId ? hfCandidates.find((c) => c.id === sessionId) : null
    setCandidates((prev) =>
      prev.map((c) =>
        c.id === aiCandidateId
          ? {
              ...c,
              sessionId,
              session: session
                ? { id: session.id, candidateName: session.candidateName, candidateEmail: session.candidateEmail }
                : null,
            }
          : c,
      ),
    )
    setLinkOpenId(null)
    setLinkSearch('')
  }

  const fetchCriteria = async () => {
    setCriteriaLoading(true)
    const r = await fetch('/api/ai-calls/agent/criteria')
    if (r.ok) {
      const data = await r.json()
      setCriteriaId(data.criteriaId)
      setCriteriaName(data.criteriaName)
      // Parse the prompt into sections
      const prompt = data.prompt || ''
      const sections: Record<string, string[]> = {}
      let current = ''
      for (const line of prompt.split('\n')) {
        const t = line.trim()
        if (!t) continue
        const hm = t.match(/^\*\*(.+?)\*\*/)
        if (hm && !t.startsWith('- ')) { current = hm[1]; sections[current] = []; continue }
        if (t.startsWith('- ') && current) sections[current].push(t.slice(2))
      }
      const keys = Object.keys(sections)
      setMandatoryItems(sections[keys.find(k => k.toUpperCase().includes('MANDATORY')) || ''] || [''])
      setPricingItems(sections[keys.find(k => k.toUpperCase().includes('PRICING')) || ''] || [''])
      setProfItems(sections[keys.find(k => k.toUpperCase().includes('PROFESSIONAL')) || ''] || [''])
      setCriticalItems(sections[keys.find(k => k.toUpperCase().includes('CRITICAL')) || ''] || [''])
      setScoringItems(sections[keys.find(k => k.toUpperCase().includes('SCORING')) || ''] || [''])
      const fb = keys.find(k => k.toUpperCase().includes('FEEDBACK'))
      setFeedbackText(fb ? sections[fb].join(' ') : '')
    }
    setCriteriaLoading(false)
  }

  const buildPrompt = () => {
    let p = EVALUATION_PREAMBLE
    const addSection = (title: string, items: string[]) => {
      const filtered = items.filter(i => i.trim())
      if (filtered.length === 0) return
      p += `\n\n**${title}:**\n` + filtered.map(i => `- ${i}`).join('\n')
    }
    addSection('MANDATORY QUESTIONS (Must ask ALL)', mandatoryItems)
    addSection('PRICING & SCHEDULING', pricingItems)
    addSection('PROFESSIONALISM', profItems)
    addSection('CRITICAL ERRORS (-5 points each)', criticalItems)
    addSection('SCORING', scoringItems)
    if (feedbackText.trim()) p += `\n\n**FEEDBACK:**\n${feedbackText}`
    p += `\n\n${OUTPUT_FORMAT_FOOTER}`
    return p.trim()
  }

  const saveCriteria = async () => {
    setCriteriaSaving(true)
    await fetch('/api/ai-calls/agent/criteria', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ criteriaId, criteriaName, prompt: buildPrompt() }),
    })
    setCriteriaSaving(false); setCriteriaSaved(true); setTimeout(() => setCriteriaSaved(false), 2000)
  }

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
  const formatDate = (unix: number) => new Date(unix * 1000).toLocaleString()
  const formatDateStr = (s: string) => new Date(s).toLocaleDateString()
  const formatDuration = (s: number) => s ? `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}` : '—'

  // Stats
  const passed = conversations.filter(c => c.call_successful === 'success').length
  const failed = conversations.filter(c => c.call_successful === 'failure').length

  if (loading) return <div className="py-14 text-center font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>Loading…</div>

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow="Voice agents"
        title="AI Calls"
        description="Voice agent conversations and candidate evaluations."
      />
      <div className="px-8 pt-5">
        <SubNav items={TRAINING_NAV} />
      </div>
      <div className="px-8 py-4">

      {/* Agent + create link */}
      <div className="bg-white rounded-[12px] border border-surface-border p-5 mb-6">
        <div className="flex items-center gap-4 mb-4">
          <div className="flex-1">
            <label className="block text-xs font-medium text-grey-20 mb-1">Agent</label>
            <select value={agentId} onChange={e => selectAgent(e.target.value)} className="w-full px-4 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="">Select an agent...</option>
              {agents.map(a => <option key={a.agent_id} value={a.agent_id}>{a.name}</option>)}
            </select>
          </div>
        </div>
        {agentId && (
          <div className="pt-4 border-t border-surface-border">
            <label className="block text-xs font-medium text-grey-20 mb-1">Create call link for candidate</label>
            <div className="flex gap-2">
              <input type="text" value={candidateName} onChange={e => setCandidateName(e.target.value)} placeholder="Candidate name" className="flex-1 px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" onKeyDown={e => e.key === 'Enter' && createCandidateLink()} />
              <button onClick={createCandidateLink} disabled={!candidateName.trim()} className={`px-5 py-2.5 text-xs font-medium rounded-[8px] disabled:opacity-50 ${candidateCopied ? 'bg-green-100 text-green-700' : 'bg-brand-500 text-white hover:bg-brand-600'}`}>
                {candidateCopied ? 'Saved & Copied!' : 'Save & Copy Link'}
              </button>
            </div>
          </div>
        )}
      </div>

      {agentId && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <div className="bg-white rounded-[8px] border border-surface-border p-4">
              <div className="text-[28px] font-bold text-grey-15">{candidates.length}</div>
              <div className="text-xs text-grey-40">Candidates</div>
            </div>
            <div className="bg-white rounded-[8px] border border-surface-border p-4">
              <div className="text-[28px] font-bold text-grey-15">{conversations.length}</div>
              <div className="text-xs text-grey-40">Total Calls</div>
            </div>
            <div className="bg-white rounded-[8px] border border-surface-border p-4">
              <div className="text-[28px] font-bold text-green-600">{passed}</div>
              <div className="text-xs text-grey-40">Passed</div>
            </div>
            <div className="bg-white rounded-[8px] border border-surface-border p-4">
              <div className="text-[28px] font-bold text-red-500">{failed}</div>
              <div className="text-xs text-grey-40">Failed</div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-5 border-b border-surface-border">
            <button onClick={() => setTab('candidates')} className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'candidates' ? 'border-brand-500 text-brand-600' : 'border-transparent text-grey-40 hover:text-grey-20'}`}>
              Candidates
            </button>
            <button onClick={() => { setTab('criteria'); if (!mandatoryItems[0]) fetchCriteria() }} className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'criteria' ? 'border-brand-500 text-brand-600' : 'border-transparent text-grey-40 hover:text-grey-20'}`}>
              Evaluation Criteria
            </button>
          </div>

          {/* Criteria editor tab */}
          {tab === 'criteria' && (
            <div className="max-w-3xl">
              {criteriaLoading ? (
                <div className="text-center py-12 text-grey-40">Loading criteria from ElevenLabs...</div>
              ) : (
                <div className="space-y-5">
                  {/* Helper to render editable list */}
                  {(() => {
                    const EditableList = ({ title, items, setItems, color }: { title: string; items: string[]; setItems: (v: string[]) => void; color: string }) => (
                      <div className={`bg-white rounded-[12px] border border-surface-border p-5`}>
                        <div className="flex items-center justify-between mb-3">
                          <h4 className={`text-xs font-semibold uppercase tracking-wide ${color}`}>{title}</h4>
                          <button onClick={() => setItems([...items, ''])} className="text-xs text-brand-500 hover:text-brand-600">+ Add</button>
                        </div>
                        <div className="space-y-2">
                          {items.map((item, i) => (
                            <div key={i} className="flex gap-2">
                              <input
                                type="text"
                                value={item}
                                onChange={e => { const n = [...items]; n[i] = e.target.value; setItems(n) }}
                                placeholder="Enter item..."
                                className="flex-1 px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                              />
                              {items.length > 1 && (
                                <button onClick={() => setItems(items.filter((_, j) => j !== i))} className="text-grey-50 hover:text-red-500 text-lg px-1">&times;</button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )

                    return (
                      <>
                        <EditableList title="Mandatory Questions (Must ask ALL)" items={mandatoryItems} setItems={setMandatoryItems} color="text-[#FF9500]" />
                        <EditableList title="Pricing & Scheduling" items={pricingItems} setItems={setPricingItems} color="text-[#FF9500]" />
                        <EditableList title="Professionalism" items={profItems} setItems={setProfItems} color="text-[#FF9500]" />
                        <EditableList title="Critical Errors (-5 points each)" items={criticalItems} setItems={setCriticalItems} color="text-red-600" />

                        <div className="bg-white rounded-[12px] border border-surface-border p-5">
                          <h4 className="text-xs font-semibold text-grey-40 uppercase tracking-wide mb-3">Scoring</h4>
                          <div className="space-y-2">
                            {scoringItems.map((item, i) => (
                              <div key={i} className="flex gap-2">
                                <input
                                  type="text"
                                  value={item}
                                  onChange={e => { const n = [...scoringItems]; n[i] = e.target.value; setScoringItems(n) }}
                                  placeholder="e.g. 90-100: Excellent"
                                  className="flex-1 px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                                />
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="bg-white rounded-[12px] border border-surface-border p-5">
                          <h4 className="text-xs font-semibold text-grey-40 uppercase tracking-wide mb-3">Feedback Instructions</h4>
                          <textarea
                            value={feedbackText}
                            onChange={e => setFeedbackText(e.target.value)}
                            rows={2}
                            placeholder="e.g. Provide Score of the call. Provide specific areas done well and areas needing improvement."
                            className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                        </div>

                        <button onClick={saveCriteria} disabled={criteriaSaving} className={`btn-primary px-8 disabled:opacity-50 ${criteriaSaved ? 'bg-green-600 hover:bg-green-600' : ''}`}>
                          {criteriaSaving ? 'Saving to ElevenLabs...' : criteriaSaved ? 'Saved!' : 'Save Evaluation Criteria'}
                        </button>
                      </>
                    )
                  })()}
                </div>
              )}
            </div>
          )}

          {tab === 'candidates' && (
          <div className="flex gap-6">
            {/* Candidates list */}
            <div className="w-80 flex-shrink-0">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-grey-15">Candidates ({candidates.length})</h3>
                <button onClick={fetchConversations} className="text-xs text-brand-500 hover:text-brand-600">Refresh</button>
              </div>

              {candidates.length === 0 ? (
                <div className="bg-white rounded-[12px] border border-surface-border p-6 text-center text-grey-40 text-sm">
                  Create a candidate link above to get started
                </div>
              ) : (
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {candidates.map(c => {
                    const candidatePageUrl = `${baseUrl}/call/${c.agentId}?name=${encodeURIComponent(c.name)}`
                    return (
                    <button
                      key={c.id}
                      onClick={() => viewCandidateConvs(c)}
                      className={`w-full text-left bg-white rounded-[8px] border p-4 transition-colors ${selectedCandidate?.id === c.id ? 'border-brand-500 bg-brand-50' : 'border-surface-border hover:border-brand-300'}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-grey-15">{c.name}</span>
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface text-grey-40 font-medium">
                            {c.conversationIds.length} call{c.conversationIds.length !== 1 ? 's' : ''}
                          </span>
                          <a
                            href={candidatePageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open candidate page"
                            className="text-grey-50 hover:text-brand-500 ml-1 inline-flex items-center"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                          </a>
                          <button
                            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(candidatePageUrl) }}
                            title="Copy candidate link"
                            className="text-grey-50 hover:text-brand-500 ml-0.5 inline-flex items-center"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); deleteCandidate(c.id) }} className="text-xs text-grey-50 hover:text-red-500 ml-1">&times;</button>
                        </div>
                      </div>
                      <div className="text-xs text-grey-50 mt-1 flex items-center justify-between gap-2">
                        <span>Created {formatDateStr(c.createdAt)}</span>
                        {/* Candidate-mapping pill. Shows the bound HF
                            candidate when linked; otherwise a Link button that
                            opens an inline picker. */}
                        {c.sessionId && c.session ? (
                          <span className="inline-flex items-center gap-1 text-[10px]" onClick={(e) => e.stopPropagation()}>
                            <a
                              href={`/dashboard/candidates/${c.sessionId}`}
                              className="px-2 py-0.5 rounded-full bg-brand-50 text-brand-600 font-medium hover:bg-brand-100"
                              title="Open candidate"
                            >
                              {c.session.candidateName || c.session.candidateEmail || 'Candidate'}
                            </a>
                            <button
                              onClick={(e) => { e.stopPropagation(); void linkToSession(c.id, null) }}
                              className="text-grey-50 hover:text-red-500"
                              title="Unlink"
                            >
                              ×
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); setLinkOpenId(linkOpenId === c.id ? null : c.id); setLinkSearch('') }}
                            className="text-[10px] px-2 py-0.5 rounded-full border border-dashed border-surface-border text-grey-40 hover:border-brand-500 hover:text-brand-600"
                          >
                            + Link to candidate
                          </button>
                        )}
                      </div>
                      {linkOpenId === c.id && (
                        <div onClick={(e) => e.stopPropagation()} className="mt-2 bg-surface rounded-[6px] p-2 border border-surface-border">
                          <input
                            type="search"
                            placeholder="Search candidates…"
                            value={linkSearch}
                            onChange={(e) => setLinkSearch(e.target.value)}
                            className="w-full px-2 py-1 text-xs border border-surface-border rounded-[6px] focus:outline-none focus:border-brand-500"
                            autoFocus
                          />
                          <div className="max-h-40 overflow-y-auto mt-1">
                            {hfCandidates
                              .filter((hf) => {
                                const q = linkSearch.toLowerCase().trim()
                                if (!q) return true
                                return (
                                  (hf.candidateName ?? '').toLowerCase().includes(q) ||
                                  (hf.candidateEmail ?? '').toLowerCase().includes(q)
                                )
                              })
                              .slice(0, 8)
                              .map((hf) => (
                                <button
                                  key={hf.id}
                                  onClick={() => void linkToSession(c.id, hf.id)}
                                  className="w-full text-left px-2 py-1.5 text-xs hover:bg-white rounded-[4px]"
                                >
                                  <div className="font-medium text-grey-15">{hf.candidateName || '(no name)'}</div>
                                  <div className="text-[10px] text-grey-50">{hf.candidateEmail ?? '—'}</div>
                                </button>
                              ))}
                          </div>
                        </div>
                      )}
                    </button>
                  )})}
                </div>
              )}

              {/* Unassigned conversations */}
              {conversations.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-medium text-grey-40">Unassigned Conversations</h4>
                    <button onClick={() => setShowAssign(true)} className="text-[10px] text-brand-500 hover:text-brand-600">Assign</button>
                  </div>
                  <div className="space-y-1">
                    {conversations.filter(c => !candidates.some(cand => cand.conversationIds.includes(c.conversation_id))).slice(0, 5).map(c => (
                      <div key={c.conversation_id} className="text-xs bg-surface rounded-[6px] px-3 py-2 flex items-center justify-between">
                        <div>
                          <span className="text-grey-35">{formatDate(c.start_time_unix_secs)}</span>
                          <span className="text-grey-50 ml-2">{formatDuration(c.call_duration_secs)}</span>
                        </div>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${c.call_successful === 'success' ? 'bg-green-100 text-green-700' : c.call_successful === 'failure' ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-grey-40'}`}>
                          {c.call_successful === 'success' ? 'Pass' : c.call_successful === 'failure' ? 'Fail' : '?'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Detail panel */}
            <div className="flex-1">
              {selectedCandidate ? (
                <div>
                  <h3 className="text-lg font-semibold text-grey-15 mb-4">{selectedCandidate.name}</h3>

                  {loadingCandidateConvs ? (
                    <div className="text-center py-12 text-grey-40">Loading conversations...</div>
                  ) : candidateConvs.length === 0 ? (
                    <div className="bg-white rounded-[12px] border border-surface-border p-8 text-center">
                      <p className="text-grey-40 mb-3">No conversations linked yet.</p>
                      <p className="text-xs text-grey-50">Assign unassigned conversations from the left panel, or the candidate needs to make a call.</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {candidateConvs.map(conv => {
                        // Parse evaluation rationale into sections
                        const rationale = Object.values(conv.analysis?.evaluation_criteria_results || {})[0]?.rationale || ''
                        const parseEvaluation = (text: string) => {
                          const scoreMatch = text.match(/Score:\s*(\d+)\/(\d+)\s*\(([^)]+)\)/)
                          const score = scoreMatch ? { value: parseInt(scoreMatch[1]), total: parseInt(scoreMatch[2]), label: scoreMatch[3] } : null

                          const doneWell: string[] = []
                          const needsImprovement: string[] = []
                          let section: 'none' | 'well' | 'improve' = 'none'

                          for (const line of text.split('\n')) {
                            const t = line.trim()
                            if (t.toLowerCase().includes('areas done well') || t.toLowerCase().includes('done well')) { section = 'well'; continue }
                            if (t.toLowerCase().includes('areas needing improvement') || t.toLowerCase().includes('needing improvement')) { section = 'improve'; continue }
                            if (t.startsWith('- ') && section === 'well') doneWell.push(t.slice(2))
                            if (t.startsWith('- ') && section === 'improve') needsImprovement.push(t.slice(2))
                          }

                          return { score, doneWell, needsImprovement }
                        }

                        const evalData = parseEvaluation(rationale)
                        const criteriaName = Object.values(conv.analysis?.evaluation_criteria_results || {})[0]?.criteria_id || 'Call Evaluation'

                        return (
                        <div key={conv.conversation_id} className="space-y-4">
                          {/* 1. CALL EVALUATION */}
                          <div className="bg-white rounded-[12px] border border-surface-border p-5">
                            <div className="flex items-center justify-between mb-4">
                              <h3 className="text-sm font-semibold text-grey-15">{criteriaName.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}</h3>
                              <span className="text-xs text-grey-50">{formatDuration(conv.call_duration_secs)}</span>
                            </div>

                            {/* Score */}
                            {evalData.score && (
                              <div className="flex items-center gap-4 mb-4">
                                <div className={`text-3xl font-bold ${evalData.score.value >= 90 ? 'text-green-600' : evalData.score.value >= 80 ? 'text-blue-600' : evalData.score.value >= 70 ? 'text-yellow-600' : 'text-red-600'}`}>
                                  {evalData.score.value}/{evalData.score.total}
                                </div>
                                <div>
                                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                                    evalData.score.value >= 90 ? 'bg-green-100 text-green-700' :
                                    evalData.score.value >= 80 ? 'bg-blue-100 text-blue-700' :
                                    evalData.score.value >= 70 ? 'bg-yellow-100 text-yellow-700' :
                                    'bg-red-100 text-red-700'
                                  }`}>{evalData.score.label}</span>
                                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium ml-2 ${
                                    conv.analysis?.call_successful === 'success' ? 'bg-green-100 text-green-700' :
                                    conv.analysis?.call_successful === 'failure' ? 'bg-red-100 text-red-600' :
                                    'bg-gray-100 text-grey-40'
                                  }`}>{conv.analysis?.call_successful === 'success' ? 'Passed' : conv.analysis?.call_successful === 'failure' ? 'Failed' : 'Pending'}</span>
                                </div>
                              </div>
                            )}

                            {/* Done well */}
                            {evalData.doneWell.length > 0 && (
                              <div className="mb-3">
                                <h4 className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-1.5">Areas Done Well</h4>
                                <ul className="space-y-1">
                                  {evalData.doneWell.map((item, j) => (
                                    <li key={j} className="flex items-start gap-2">
                                      <svg className="w-3.5 h-3.5 text-green-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                                      <span className="text-xs text-grey-15">{item}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Needs improvement */}
                            {evalData.needsImprovement.length > 0 && (
                              <div>
                                <h4 className="text-xs font-semibold text-yellow-700 uppercase tracking-wide mb-1.5">Needs Improvement</h4>
                                <ul className="space-y-1">
                                  {evalData.needsImprovement.map((item, j) => (
                                    <li key={j} className="flex items-start gap-2">
                                      <svg className="w-3.5 h-3.5 text-yellow-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                      <span className="text-xs text-grey-15">{item}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Fallback: show raw rationale if parsing found nothing */}
                            {!evalData.score && !evalData.doneWell.length && !evalData.needsImprovement.length && rationale && (
                              <p className="text-xs text-grey-35 whitespace-pre-wrap">{rationale}</p>
                            )}
                          </div>

                          {/* 2. RECORDING */}
                          <div className="bg-white rounded-[12px] border border-surface-border p-5">
                            <h3 className="text-sm font-semibold text-grey-15 mb-3">Recording</h3>
                            <audio
                              controls
                              preload="metadata"
                              src={`/api/ai-calls/conversations/${conv.conversation_id}/audio`}
                              className="w-full"
                            />
                          </div>

                          {/* 3. CALL SUMMARY */}
                          {conv.analysis?.transcript_summary && (
                            <div className="bg-white rounded-[12px] border border-surface-border p-5">
                              <h3 className="text-sm font-semibold text-grey-15 mb-2">Call Summary</h3>
                              <p className="text-sm text-grey-35 leading-relaxed">{conv.analysis.transcript_summary}</p>
                            </div>
                          )}

                          {/* 3. TRANSCRIPT */}
                          {conv.transcript && conv.transcript.length > 0 && (
                            <div className="bg-white rounded-[12px] border border-surface-border p-5">
                              <details>
                                <summary className="text-sm font-semibold text-grey-15 cursor-pointer hover:text-brand-500">Transcript ({conv.transcript.length} messages)</summary>
                                <div className="mt-3 space-y-1.5 max-h-[350px] overflow-y-auto">
                                  {conv.transcript.map((turn, i) => (
                                    <div key={i} className={`flex gap-2 ${turn.role === 'user' ? 'flex-row-reverse' : ''}`}>
                                      <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[9px] font-bold ${turn.role === 'user' ? 'bg-blue-100 text-blue-600' : 'bg-brand-100 text-brand-600'}`}>{turn.role === 'user' ? 'U' : 'AI'}</div>
                                      <p className={`text-xs px-2 py-1.5 rounded-[6px] max-w-[80%] ${turn.role === 'user' ? 'bg-blue-50' : 'bg-surface'} text-grey-15`}>{turn.message}</p>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            </div>
                          )}
                        </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="bg-white rounded-[12px] border border-surface-border p-12 text-center text-grey-40">
                  Select a candidate to view their conversations and evaluations
                </div>
              )}
            </div>
          </div>

          )}

          {/* Assign modal */}
          {showAssign && (
            <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
              <div className="bg-white rounded-[12px] shadow-2xl p-6 w-full max-w-[400px]" onClick={e => e.stopPropagation()}>
                <h2 className="text-lg font-semibold text-grey-15 mb-4">Assign Conversation</h2>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-grey-20 mb-1">Conversation</label>
                    <select value={assignConvId} onChange={e => setAssignConvId(e.target.value)} className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-sm">
                      <option value="">Select...</option>
                      {conversations.filter(c => !candidates.some(cand => cand.conversationIds.includes(c.conversation_id))).map(c => (
                        <option key={c.conversation_id} value={c.conversation_id}>{formatDate(c.start_time_unix_secs)} — {formatDuration(c.call_duration_secs)} — {c.call_successful || 'pending'}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-grey-20 mb-1">Candidate</label>
                    <select value={assignCandidateId} onChange={e => setAssignCandidateId(e.target.value)} className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-sm">
                      <option value="">Select...</option>
                      {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex gap-3 mt-4">
                  <button onClick={() => setShowAssign(false)} className="btn-secondary flex-1">Cancel</button>
                  <button onClick={assignConversation} disabled={!assignConvId || !assignCandidateId} className="btn-primary flex-1 disabled:opacity-50">Assign</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
      </div>
    </div>
  )
}
