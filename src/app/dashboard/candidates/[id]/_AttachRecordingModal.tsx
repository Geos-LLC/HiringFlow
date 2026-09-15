/**
 * Modal for attaching an existing MockCustomer artifact to a HireFunnel
 * candidate. Two artifact types are shown together:
 *
 *   - ExternalCalls: outbound Twilio dials with Twilio recordings.
 *     Fetched from /api/mc-connection/calls.
 *
 *   - SimulationSessions: browser-widget INVITE tests with ElevenLabs
 *     audio. Fetched from /api/mc-connection/sessions.
 *
 * Both queries fire in parallel on modal open. Results are merged and
 * sorted by createdAt DESC. Each row shows a small type badge
 * ("Phone" vs "Widget") so the recruiter can tell them apart.
 *
 * On confirm, POSTs to /api/candidates/[id]/mc-simulations/import with
 * the appropriate resourceType so the server routes to the right
 * verification + storage path.
 */

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

interface McCallRow {
  id: string
  status: string
  destinationPhoneMasked: string
  durationSec: number | null
  queuedAt: string
  completedAt: string | null
  hasRecording: boolean
  clientReferenceId: string | null
}

interface McSessionRow {
  id: string
  mode: string
  status: string
  participantName: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  elevenLabsConversationId: string | null
  hasAudio: boolean
  errorReason: string | null
}

type UnifiedRow =
  | ({ resourceType: 'call'; sortAt: string } & McCallRow)
  | ({ resourceType: 'session'; sortAt: string } & McSessionRow)

interface Props {
  candidateId: string
  onClose: () => void
  onAttached: (simulationId: string) => void
}

export function AttachRecordingModal({ candidateId, onClose, onAttached }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [calls, setCalls] = useState<McCallRow[]>([])
  const [sessions, setSessions] = useState<McSessionRow[]>([])
  const [selected, setSelected] = useState<{ type: 'call' | 'session'; id: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [onlyWithAudio, setOnlyWithAudio] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set('limit', '50')
      if (onlyWithAudio) {
        // Note: /calls uses ?onlyWithRecording, /sessions uses ?onlyWithAudio.
        // Different query names, same intent.
      }
      const callsParams = new URLSearchParams({ limit: '50' })
      const sessionsParams = new URLSearchParams({ limit: '50' })
      if (onlyWithAudio) {
        callsParams.set('onlyWithRecording', 'true')
        sessionsParams.set('onlyWithAudio', 'true')
      }
      const [callsRes, sessionsRes] = await Promise.all([
        fetch(`/api/mc-connection/calls?${callsParams.toString()}`),
        fetch(`/api/mc-connection/sessions?${sessionsParams.toString()}`),
      ])
      const parseOrEmpty = async (res: Response, key: 'calls' | 'sessions'): Promise<unknown[]> => {
        if (!res.ok) return []
        const data = (await res.json()) as Record<string, unknown>
        return Array.isArray(data[key]) ? (data[key] as unknown[]) : []
      }
      const [callsArr, sessionsArr] = await Promise.all([
        parseOrEmpty(callsRes, 'calls'),
        parseOrEmpty(sessionsRes, 'sessions'),
      ])
      setCalls(callsArr as McCallRow[])
      setSessions(sessionsArr as McSessionRow[])
      if (!callsRes.ok && !sessionsRes.ok) {
        const anyBody = (await callsRes.json().catch(() => ({}))) as { error?: string }
        setError(anyBody.error ?? 'Failed to load MockCustomer artifacts')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [onlyWithAudio])

  useEffect(() => {
    void load()
  }, [load])

  const unified: UnifiedRow[] = useMemo(() => {
    const merged: UnifiedRow[] = [
      ...calls.map((c) => ({ ...c, resourceType: 'call' as const, sortAt: c.queuedAt })),
      ...sessions.map((s) => ({ ...s, resourceType: 'session' as const, sortAt: s.createdAt })),
    ]
    // Newest first.
    merged.sort((a, b) => (a.sortAt < b.sortAt ? 1 : -1))
    return merged
  }, [calls, sessions])

  const submit = useCallback(async () => {
    if (!selected) return
    setSubmitting(true)
    setError(null)
    try {
      const body =
        selected.type === 'call'
          ? { resourceType: 'call', mcCallId: selected.id }
          : { resourceType: 'session', mcSessionId: selected.id }
      const res = await fetch(`/api/candidates/${candidateId}/mc-simulations/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as {
        simulationId?: string
        error?: string
        reason?: string
        isSameCandidate?: boolean
      }
      if (!res.ok) {
        if (data.reason === 'already_imported' && data.simulationId) {
          if (data.isSameCandidate) {
            onAttached(data.simulationId)
            return
          }
          setError('This recording is already attached to a different candidate in your workspace.')
          return
        }
        setError(data.error ?? `Attach failed (${res.status})`)
        return
      }
      if (data.simulationId) onAttached(data.simulationId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Attach failed')
    } finally {
      setSubmitting(false)
    }
  }, [selected, candidateId, onAttached])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose()
      }}
    >
      <div className="w-full max-w-lg rounded-[14px] bg-white shadow-xl border border-surface-border">
        <div className="px-5 py-4 border-b border-surface-divider flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink">Attach existing recording</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="w-7 h-7 flex items-center justify-center rounded-md text-grey-50 hover:text-ink hover:bg-surface-light disabled:opacity-50"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="text-[12px] text-grey-50 mb-3">
            Pick a past MockCustomer test to attach to this candidate. The recording + evaluation will appear on
            the candidate page.
          </p>

          <label className="text-[11px] text-grey-35 flex items-center gap-1.5 mb-2">
            <input
              type="checkbox"
              checked={onlyWithAudio}
              onChange={(e) => setOnlyWithAudio(e.target.checked)}
            />
            Only show tests with a recording
          </label>

          {loading ? (
            <div className="text-[12px] text-grey-50 py-4">Loading…</div>
          ) : error && unified.length === 0 ? (
            <div className="text-[12px] text-rose-700 py-4">{error}</div>
          ) : unified.length === 0 ? (
            <div className="text-[12px] text-grey-50 py-4">
              No MockCustomer tests found in your organization{onlyWithAudio && ' with a recording'}.
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto -mx-1 pr-1">
              <ul className="space-y-1">
                {unified.map((r) => {
                  const isPicked = selected?.type === r.resourceType && selected?.id === r.id
                  const badge = r.resourceType === 'call' ? 'Phone' : 'Widget'
                  const badgeCls =
                    r.resourceType === 'call'
                      ? 'bg-sky-50 text-sky-700 border-sky-200'
                      : 'bg-violet-50 text-violet-700 border-violet-200'
                  const label =
                    r.resourceType === 'call'
                      ? r.destinationPhoneMasked
                      : r.participantName || '(anonymous)'
                  const secondary =
                    r.resourceType === 'call'
                      ? `${new Date(r.queuedAt).toLocaleString()}${r.durationSec != null ? ` · ${r.durationSec}s` : ''}`
                      : `${new Date(r.createdAt).toLocaleString()} · ${r.mode}`
                  const audioIndicator =
                    r.resourceType === 'call' ? r.hasRecording : r.hasAudio
                  return (
                    <li key={`${r.resourceType}:${r.id}`}>
                      <label
                        className={`flex items-start gap-2 p-2 rounded-[8px] border cursor-pointer transition-colors ${
                          isPicked
                            ? 'border-brand-500 bg-brand-50/40'
                            : 'border-surface-border hover:bg-surface-light'
                        }`}
                      >
                        <input
                          type="radio"
                          name="mc-artifact"
                          checked={isPicked}
                          onChange={() =>
                            setSelected({ type: r.resourceType, id: r.id })
                          }
                          className="mt-1"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-[12px] flex-wrap">
                            <span
                              className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${badgeCls} font-mono uppercase tracking-wider`}
                            >
                              {badge}
                            </span>
                            <span className="font-mono text-grey-15 truncate">{label}</span>
                            <span
                              className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${
                                r.status.toLowerCase() === 'completed'
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : r.status.toLowerCase() === 'failed' || r.status.toLowerCase() === 'cancelled'
                                    ? 'bg-rose-50 text-rose-700 border-rose-200'
                                    : 'bg-slate-50 text-slate-700 border-slate-200'
                              } font-mono uppercase tracking-wider`}
                            >
                              {r.status}
                            </span>
                            {audioIndicator && (
                              <span className="text-[10px] text-brand-600">▶ audio</span>
                            )}
                          </div>
                          <div className="text-[11px] text-grey-50 mt-0.5 font-mono">
                            {secondary}
                            <span className="ml-2 text-grey-35">{r.id.slice(0, 8)}…</span>
                          </div>
                        </div>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {error && unified.length > 0 && (
            <div className="mt-2 text-[12px] text-rose-700" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-divider flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-2 rounded-[8px] border border-surface-border text-[12px] text-grey-35 hover:text-ink transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!selected || submitting}
            className="px-3 py-2 rounded-[8px] bg-ink text-white text-[12px] font-semibold disabled:opacity-50 hover:bg-grey-15 transition-colors"
          >
            {submitting ? 'Attaching…' : 'Attach to candidate'}
          </button>
        </div>
      </div>
    </div>
  )
}
