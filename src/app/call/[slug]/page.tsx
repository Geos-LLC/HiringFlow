'use client'

import { useParams, useSearchParams } from 'next/navigation'
import Script from 'next/script'
import { useEffect, useRef, useState } from 'react'

interface Conversation {
  conversation_id: string; status: string; start_time_unix_secs: number
  call_duration_secs: number; message_count: number; call_successful: string | null
  transcript_summary: string | null
  evaluation_score?: number | null
  evaluation_total?: number | null
  evaluation_label?: string | null
}

const scoreColor = (v: number) =>
  v >= 90 ? 'text-green-600' : v >= 80 ? 'text-blue-600' : v >= 70 ? 'text-yellow-600' : 'text-red-600'
const scoreBadge = (v: number) =>
  v >= 90 ? 'bg-green-100 text-green-700' : v >= 80 ? 'bg-blue-100 text-blue-700' : v >= 70 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'

// ElevenLabs returns 'success' | 'failure' | 'unknown' for call_successful.
// 'unknown' = transcript too thin to grade (e.g. candidate disconnected before
// the dispatcher said anything). null = evaluation still pending.
const statusPill = (callSuccessful: string | null | undefined) => {
  if (callSuccessful === 'success') return { label: 'Passed', className: 'bg-green-100 text-green-700' }
  if (callSuccessful === 'failure') return { label: 'Failed', className: 'bg-red-100 text-red-600' }
  if (callSuccessful === 'unknown') return { label: 'Not Finished', className: 'bg-amber-100 text-amber-700' }
  return { label: 'Pending', className: 'bg-gray-100 text-[#8A8A8C]' }
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

interface AgentCriteria { id: string; name: string; prompt: string }

export default function CandidateCallPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const agentId = params.slug as string
  const candidateName = searchParams.get('name') || ''
  const widgetContainerRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<'call' | 'history'>('call')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [selectedConv, setSelectedConv] = useState<ConversationDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [callCards, setCallCards] = useState<Conversation[]>([])
  const [loadingCards, setLoadingCards] = useState(false)
  const [agentName, setAgentName] = useState('')
  const [criteria, setCriteria] = useState<AgentCriteria[]>([])

  // Fetch agent criteria on mount
  useEffect(() => {
    fetch(`/api/public/ai-calls/${agentId}/agent`).then(r => r.ok ? r.json() : null).then(d => {
      if (d) { setAgentName(d.name || ''); setCriteria(d.criteria || []) }
    }).catch(() => {})
  }, [agentId])

  useEffect(() => {
    const createWidget = () => {
      if (!widgetContainerRef.current) return
      const existing = widgetContainerRef.current.querySelector('elevenlabs-convai')
      if (existing) existing.remove()

      const widget = document.createElement('elevenlabs-convai')
      widget.setAttribute('agent-id', agentId)
      widget.setAttribute('avatar-orb-color-1', '#FF9500')
      widget.setAttribute('avatar-orb-color-2', '#EA8500')
      widget.setAttribute('action-text', 'Start Call')
      widget.setAttribute('start-call-text', 'Start Call')
      widget.setAttribute('end-call-text', 'End Call')
      widget.setAttribute('listening-text', 'Listening...')
      widget.setAttribute('speaking-text', 'Speaking...')
      if (candidateName) {
        widget.setAttribute('dynamic-variables', JSON.stringify({ candidate_name: candidateName }))
      }
      widgetContainerRef.current.appendChild(widget)
    }

    const interval = setInterval(() => {
      if (customElements.get('elevenlabs-convai')) {
        clearInterval(interval)
        createWidget()
      }
    }, 100)
    return () => clearInterval(interval)
  }, [agentId, candidateName])

  const fetchConversationsList = async () => {
    const url = candidateName
      ? `/api/public/ai-calls/${agentId}/link?name=${encodeURIComponent(candidateName)}`
      : `/api/public/ai-calls/${agentId}`
    const r = await fetch(url)
    if (r.ok) {
      const data = await r.json()
      return data.conversations || []
    }
    return []
  }

  const fetchHistory = async () => {
    setLoadingHistory(true)
    const convs = await fetchConversationsList()
    setConversations(convs)
    setLoadingHistory(false)
  }

  const refreshCallCards = async () => {
    setLoadingCards(true)
    const convs = await fetchConversationsList()
    setCallCards(convs)
    setLoadingCards(false)
  }

  // Load call cards on mount
  useEffect(() => { refreshCallCards() }, [agentId, candidateName])

  const viewDetail = async (convId: string) => {
    setLoadingDetail(true)
    const r = await fetch(`/api/public/ai-calls/${agentId}?id=${convId}`)
    if (r.ok) setSelectedConv(await r.json())
    setLoadingDetail(false)
  }

  const formatDate = (unix: number) => new Date(unix * 1000).toLocaleString()
  const formatDuration = (s: number) => s ? `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}` : '—'

  return (
    <div className="min-h-screen bg-white flex flex-col" style={{ fontFamily: '"Be Vietnam Pro", system-ui, sans-serif' }}>
      <Script src="https://elevenlabs.io/convai-widget/index.js" strategy="afterInteractive" />

      {/* Header */}
      <div className="bg-white border-b border-[#F1F1F3] px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-[#FF9500] rounded-[6px] flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
          </div>
          <div>
            <h1 className="text-sm font-semibold text-[#262626]">{candidateName ? `${candidateName} — ${agentName || 'AI Call'}` : agentName || 'AI Voice Call'}</h1>
            <p className="text-[11px] text-[#8A8A8C]">Powered by HireFunnel</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-[#F7F7F8] rounded-[8px] p-1">
          <button onClick={() => setTab('call')} className={`px-4 py-1.5 text-xs rounded-[6px] font-medium transition-colors ${tab === 'call' ? 'bg-white text-[#262626] shadow-sm' : 'text-[#8A8A8C]'}`}>
            Call
          </button>
          <button onClick={() => { setTab('history'); if (conversations.length === 0) fetchHistory() }} className={`px-4 py-1.5 text-xs rounded-[6px] font-medium transition-colors ${tab === 'history' ? 'bg-white text-[#262626] shadow-sm' : 'text-[#8A8A8C]'}`}>
            My Results
          </button>
        </div>
      </div>

      {/* Call tab */}
      {tab === 'call' && (
        <div className="flex-1 overflow-y-auto relative">
          {/* Full page checklist content */}
          {criteria.length > 0 && (() => {
            const parseSections = (text: string) => {
              const sections: Array<{ title: string; items: string[]; isScoring?: boolean }> = []
              let currentTitle = ''
              let currentItems: string[] = []
              let isScoring = false
              for (const line of text.split('\n')) {
                const trimmed = line.trim()
                if (!trimmed) continue
                const headerMatch = trimmed.match(/^\*\*(.+?)\*\*:?$/) || trimmed.match(/^\*\*(.+?)\*\*/)
                if (headerMatch && !trimmed.startsWith('- ')) {
                  if (currentTitle) sections.push({ title: currentTitle, items: currentItems, isScoring })
                  currentTitle = headerMatch[1].replace(/\*\*/g, '')
                  currentItems = []
                  isScoring = currentTitle.toUpperCase().includes('SCORING')
                  continue
                }
                if (trimmed.startsWith('- ')) currentItems.push(trimmed.slice(2))
              }
              if (currentTitle) sections.push({ title: currentTitle, items: currentItems, isScoring })
              return sections
            }
            const prompt = criteria[0]?.prompt || ''
            const sections = parseSections(prompt)
            const checklist = sections.filter(s => !s.isScoring && !s.title.toUpperCase().includes('FEEDBACK') && !s.title.toUpperCase().includes('CRITICAL'))
            const scoring = sections.filter(s => s.isScoring)
            const critical = sections.filter(s => s.title.toUpperCase().includes('CRITICAL'))

            return (
              <div className="max-w-3xl mx-auto px-6 py-6">
                <h3 className="text-lg font-semibold text-[#262626] mb-5">
                  {agentName || 'Call'} — Evaluation Checklist
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                  {checklist.map((section, i) => (
                    <div key={i} className="bg-[#FFF7ED] rounded-[12px] p-4">
                      <h4 className="text-xs font-semibold text-[#FF9500] uppercase tracking-wide mb-2">{section.title}</h4>
                      <ul className="space-y-1">
                        {section.items.map((item, j) => (
                          <li key={j} className="flex items-start gap-2">
                            <svg className="w-3.5 h-3.5 text-[#FF9500] mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                            <span className="text-sm text-[#262626]">{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>

                {critical.length > 0 && (
                  <div className="bg-red-50 rounded-[12px] p-4 mb-5">
                    <h4 className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2">{critical[0].title}</h4>
                    <ul className="space-y-1">
                      {critical[0].items.map((item, j) => (
                        <li key={j} className="flex items-start gap-2">
                          <svg className="w-3.5 h-3.5 text-red-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          <span className="text-sm text-red-700">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {scoring.length > 0 && (
                  <div className="bg-[#F7F7F8] rounded-[12px] p-4">
                    <h4 className="text-xs font-semibold text-[#59595A] uppercase tracking-wide mb-2">Scoring</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      {scoring[0].items.map((item, j) => {
                        const [range, label] = item.split(':').map(s => s.trim())
                        const colors = ['bg-green-100 text-green-700', 'bg-blue-100 text-blue-700', 'bg-yellow-100 text-yellow-700', 'bg-red-100 text-red-700']
                        return (
                          <div key={j} className={`rounded-[8px] p-3 text-center ${colors[j] || 'bg-gray-100 text-gray-700'}`}>
                            <div className="text-sm font-bold">{range}</div>
                            <div className="text-[10px] font-medium">{label}</div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Completed call cards */}
          {callCards.length > 0 && (
            <div className="max-w-3xl mx-auto px-6 py-5 border-t border-[#F1F1F3]">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-[#262626]">Your Calls</h3>
                <button onClick={refreshCallCards} className="text-xs text-[#FF9500] hover:text-[#EA8500]">Refresh</button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {callCards.map((c, i) => (
                    <button
                      key={c.conversation_id}
                      onClick={async () => { setTab('history'); await fetchHistory(); viewDetail(c.conversation_id) }}
                      className="bg-white rounded-[10px] border border-[#F1F1F3] p-4 text-left hover:border-[#FF9500] hover:shadow-sm transition-all"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-medium text-[#262626]">Call {callCards.length - i}</span>
                        {typeof c.evaluation_score === 'number' ? (
                          <div className="flex items-center gap-2">
                            <span className={`text-lg font-bold ${scoreColor(c.evaluation_score)}`}>{c.evaluation_score}/{c.evaluation_total || 100}</span>
                            {c.evaluation_label && (
                              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${scoreBadge(c.evaluation_score)}`}>{c.evaluation_label}</span>
                            )}
                          </div>
                        ) : (() => {
                          const pill = statusPill(c.call_successful)
                          return <span className={`text-sm px-3 py-1 rounded-full font-semibold ${pill.className}`}>{pill.label}</span>
                        })()}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[#8A8A8C]">{formatDuration(c.call_duration_secs)} &middot; {formatDate(c.start_time_unix_secs)}</span>
                        <span className="text-xs text-[#FF9500] font-medium">View evaluation →</span>
                      </div>
                    </button>
                  ))}
              </div>
            </div>
          )}

        </div>
      )}

      {/* History tab */}
      {tab === 'history' && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[#262626]">Your Conversations</h2>
              <button onClick={fetchHistory} className="text-xs text-[#FF9500] hover:text-[#EA8500] font-medium">Refresh</button>
            </div>

            {loadingHistory ? (
              <div className="text-center py-12 text-[#8A8A8C]">Loading...</div>
            ) : conversations.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-[#8A8A8C]">No conversations yet. Go to the Call tab to start one.</p>
              </div>
            ) : (
              <div className="flex gap-6">
                {/* Table */}
                <div className="flex-1 bg-white rounded-[12px] border border-[#F1F1F3] overflow-hidden">
                  <table className="min-w-full">
                    <thead>
                      <tr className="border-b border-[#F1F1F3] bg-[#F7F7F8]">
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-[#8A8A8C] uppercase">Call</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-[#8A8A8C] uppercase">Result</th>
                        <th className="px-4 py-2.5 text-right text-xs font-medium text-[#8A8A8C] uppercase">Duration</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F1F3]">
                      {conversations.map((c, i) => (
                        <tr key={c.conversation_id} onClick={() => viewDetail(c.conversation_id)} className={`cursor-pointer hover:bg-[#FAFAFA] transition-colors ${selectedConv?.conversation_id === c.conversation_id ? 'bg-[#FFF7ED]' : ''}`}>
                          <td className="px-4 py-3">
                            <div className="text-sm font-medium text-[#262626]">Call {conversations.length - i}</div>
                            <div className="text-xs text-[#8A8A8C]">{formatDate(c.start_time_unix_secs)}</div>
                          </td>
                          <td className="px-4 py-3">
                            {typeof c.evaluation_score === 'number' ? (
                              <div className="flex items-center gap-2">
                                <span className={`text-base font-bold ${scoreColor(c.evaluation_score)}`}>{c.evaluation_score}/{c.evaluation_total || 100}</span>
                                {c.evaluation_label && (
                                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${scoreBadge(c.evaluation_score)}`}>{c.evaluation_label}</span>
                                )}
                              </div>
                            ) : (() => {
                              const pill = statusPill(c.call_successful)
                              return <span className={`text-sm px-3 py-1 rounded-full font-semibold ${pill.className}`}>{pill.label}</span>
                            })()}
                          </td>
                          <td className="px-4 py-3 text-sm text-[#262626] text-right">{formatDuration(c.call_duration_secs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Detail — same structure as admin AI Calls page */}
                {selectedConv && (
                  <div className="w-[420px] flex-shrink-0 space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 180px)' }}>
                    {loadingDetail ? (
                      <div className="text-center py-12 text-[#8A8A8C]">Loading...</div>
                    ) : (() => {
                      // Parse evaluation rationale
                      const rationale = Object.values(selectedConv.analysis?.evaluation_criteria_results || {})[0]?.rationale || ''
                      // Try multiple score patterns
                      const scoreMatch = rationale.match(/Score:\s*(\d+)\/(\d+)\s*\(([^)]+)\)/) || rationale.match(/(\d+)\/100\s*\(([^)]+)\)/) || rationale.match(/(\d+)\s*\/\s*100/)
                      let score: { value: number; total: number; label: string } | null = null
                      if (scoreMatch) {
                        if (scoreMatch[3]) score = { value: parseInt(scoreMatch[1]), total: parseInt(scoreMatch[2]), label: scoreMatch[3] }
                        else if (scoreMatch[2] && isNaN(parseInt(scoreMatch[2]))) score = { value: parseInt(scoreMatch[1]), total: 100, label: scoreMatch[2] }
                        else score = { value: parseInt(scoreMatch[1]), total: parseInt(scoreMatch[2]) || 100, label: parseInt(scoreMatch[1]) >= 90 ? 'Excellent' : parseInt(scoreMatch[1]) >= 80 ? 'Good' : parseInt(scoreMatch[1]) >= 70 ? 'Needs Improvement' : 'Requires Retraining' }
                      }
                      const doneWell: string[] = []
                      const needsImprovement: string[] = []
                      let section: 'none' | 'well' | 'improve' = 'none'
                      for (const line of rationale.split('\n')) {
                        const t = line.trim()
                        if (t.toLowerCase().includes('done well') || t.toLowerCase().includes('strengths')) { section = 'well'; continue }
                        if (t.toLowerCase().includes('improvement') || t.toLowerCase().includes('weaknesses') || t.toLowerCase().includes('areas for')) { section = 'improve'; continue }
                        if (t.startsWith('- ') && section === 'well') doneWell.push(t.slice(2))
                        if (t.startsWith('- ') && section === 'improve') needsImprovement.push(t.slice(2))
                      }
                      const criteriaName = Object.values(selectedConv.analysis?.evaluation_criteria_results || {})[0]?.criteria_id || 'Call Evaluation'
                      const callResult = selectedConv.analysis?.call_successful

                      return (
                        <>
                          {/* 1. CALL EVALUATION */}
                          <div className="bg-white rounded-[12px] border border-[#F1F1F3] p-5">
                            <div className="flex items-center justify-between mb-3">
                              <h3 className="text-sm font-semibold text-[#262626]">{criteriaName.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}</h3>
                              <span className="text-xs text-[#8A8A8C]">{formatDuration(selectedConv.call_duration_secs)}</span>
                            </div>

                            {/* Always show result prominently */}
                            <div className="flex items-center gap-3 mb-4">
                              {score ? (
                                <div className={`text-3xl font-bold ${score.value >= 90 ? 'text-green-600' : score.value >= 80 ? 'text-blue-600' : score.value >= 70 ? 'text-yellow-600' : 'text-red-600'}`}>
                                  {score.value}/{score.total}
                                </div>
                              ) : (
                                <div className={`w-14 h-14 rounded-full flex items-center justify-center ${callResult === 'success' ? 'bg-green-100' : callResult === 'failure' ? 'bg-red-100' : 'bg-gray-100'}`}>
                                  {callResult === 'success' ? (
                                    <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                  ) : callResult === 'failure' ? (
                                    <svg className="w-7 h-7 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                  ) : (
                                    <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01" /></svg>
                                  )}
                                </div>
                              )}
                              <div>
                                {score && <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${score.value >= 90 ? 'bg-green-100 text-green-700' : score.value >= 80 ? 'bg-blue-100 text-blue-700' : score.value >= 70 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>{score.label}</span>}
                                {(() => {
                                  const pill = statusPill(callResult)
                                  return <span className={`text-sm px-3 py-1 rounded-full font-semibold ${score ? 'ml-1.5' : ''} ${pill.className}`}>{pill.label}</span>
                                })()}
                              </div>
                            </div>

                            {doneWell.length > 0 && (
                              <div className="mb-3">
                                <h4 className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-1.5">Areas Done Well</h4>
                                <ul className="space-y-1">
                                  {doneWell.map((item, j) => (
                                    <li key={j} className="flex items-start gap-2">
                                      <svg className="w-3.5 h-3.5 text-green-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                                      <span className="text-xs text-[#262626]">{item}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {needsImprovement.length > 0 && (
                              <div>
                                <h4 className="text-xs font-semibold text-yellow-700 uppercase tracking-wide mb-1.5">Needs Improvement</h4>
                                <ul className="space-y-1">
                                  {needsImprovement.map((item, j) => (
                                    <li key={j} className="flex items-start gap-2">
                                      <svg className="w-3.5 h-3.5 text-yellow-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                      <span className="text-xs text-[#262626]">{item}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {!doneWell.length && !needsImprovement.length && rationale && (
                              <div className="bg-[#F7F7F8] rounded-[8px] p-3">
                                <h4 className="text-xs font-semibold text-[#59595A] uppercase tracking-wide mb-1.5">Feedback</h4>
                                <p className="text-xs text-[#262626] whitespace-pre-wrap leading-relaxed">{rationale}</p>
                              </div>
                            )}
                          </div>

                          {/* 2. RECORDING */}
                          <div className="bg-white rounded-[12px] border border-[#F1F1F3] p-5">
                            <h3 className="text-sm font-semibold text-[#262626] mb-3">Recording</h3>
                            <audio
                              controls
                              preload="metadata"
                              src={`/api/public/ai-calls/${agentId}/audio?id=${selectedConv.conversation_id}&name=${encodeURIComponent(candidateName)}`}
                              className="w-full"
                            />
                          </div>

                          {/* 3. CALL SUMMARY */}
                          {selectedConv.analysis?.transcript_summary && (
                            <div className="bg-white rounded-[12px] border border-[#F1F1F3] p-5">
                              <h3 className="text-sm font-semibold text-[#262626] mb-2">Call Summary</h3>
                              <p className="text-sm text-[#59595A] leading-relaxed">{selectedConv.analysis.transcript_summary}</p>
                            </div>
                          )}

                          {/* 3. TRANSCRIPT */}
                          {selectedConv.transcript && selectedConv.transcript.length > 0 && (
                            <div className="bg-white rounded-[12px] border border-[#F1F1F3] p-5">
                              <details>
                                <summary className="text-sm font-semibold text-[#262626] cursor-pointer hover:text-[#FF9500]">Transcript ({selectedConv.transcript.length} messages)</summary>
                                <div className="mt-3 space-y-1.5 max-h-[350px] overflow-y-auto">
                                  {selectedConv.transcript.map((turn, i) => (
                                    <div key={i} className={`flex gap-2 ${turn.role === 'user' ? 'flex-row-reverse' : ''}`}>
                                      <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[9px] font-bold ${turn.role === 'user' ? 'bg-blue-100 text-blue-600' : 'bg-[#FFF7ED] text-[#FF9500]'}`}>{turn.role === 'user' ? 'You' : 'AI'}</div>
                                      <p className={`text-xs px-2.5 py-1.5 rounded-[6px] max-w-[85%] ${turn.role === 'user' ? 'bg-blue-50' : 'bg-[#F7F7F8]'} text-[#262626]`}>{turn.message}</p>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            </div>
                          )}
                        </>
                      )
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Widget — always present, floating bottom-right */}
      <div ref={widgetContainerRef} className="fixed bottom-4 right-4 z-50" />

      <style jsx global>{`
        elevenlabs-convai {
          z-index: 50 !important;
        }
      `}</style>
    </div>
  )
}
