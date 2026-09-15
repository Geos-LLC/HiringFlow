/**
 * Modal for attaching one or more existing MockCustomer artifacts to a
 * HireFunnel candidate. Two artifact types are merged:
 *
 *   - ExternalCalls: outbound Twilio dials with Twilio recordings.
 *   - SimulationSessions: browser-widget INVITE tests with ElevenLabs
 *     audio + SimulationResult scores.
 *
 * Both queries fire in parallel on modal open. Results are merged and
 * sorted by createdAt DESC. Each row shows:
 *   - Phone/Widget type badge
 *   - Participant or destination phone label
 *   - Status pill
 *   - Score badge (widget only, when result is present)
 *   - Audio indicator
 *
 * Multi-select via checkboxes. On submit, POSTs each selection to
 * /api/candidates/[id]/mc-simulations/import in parallel; per-row
 * failures surface without aborting the whole batch.
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
  result: {
    overallScore: number
    passed: boolean
    passThreshold: number
    summary: string | null
  } | null
}

type UnifiedRow =
  | ({ resourceType: 'call'; sortAt: string } & McCallRow)
  | ({ resourceType: 'session'; sortAt: string } & McSessionRow)

interface Props {
  candidateId: string
  onClose: () => void
  onAttached: (simulationIds: string[]) => void
}

interface RowKey {
  type: 'call' | 'session'
  id: string
}

function keyToString(k: RowKey): string {
  return `${k.type}:${k.id}`
}

export function AttachRecordingModal({ candidateId, onClose, onAttached }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [calls, setCalls] = useState<McCallRow[]>([])
  const [sessions, setSessions] = useState<McSessionRow[]>([])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [onlyWithAudio, setOnlyWithAudio] = useState(true)
  const [perRowErrors, setPerRowErrors] = useState<Map<string, string>>(new Map())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
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
    merged.sort((a, b) => (a.sortAt < b.sortAt ? 1 : -1))
    return merged
  }, [calls, sessions])

  const toggle = useCallback((k: RowKey) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      const s = keyToString(k)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }, [])

  const submit = useCallback(async () => {
    if (selectedKeys.size === 0) return
    setSubmitting(true)
    setError(null)
    setPerRowErrors(new Map())

    // Fire imports in parallel — failures per row don't abort the batch.
    const results = await Promise.all(
      Array.from(selectedKeys).map(async (keyStr) => {
        const [type, id] = keyStr.split(':') as [RowKey['type'], string]
        const body =
          type === 'call'
            ? { resourceType: 'call', mcCallId: id }
            : { resourceType: 'session', mcSessionId: id }
        try {
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
            // already_imported to the SAME candidate is treated as success
            // (idempotent — nothing to do, row already there).
            if (data.reason === 'already_imported' && data.isSameCandidate) {
              return { keyStr, ok: true, simulationId: data.simulationId ?? null, err: null }
            }
            return {
              keyStr,
              ok: false,
              simulationId: null,
              err:
                data.reason === 'already_imported'
                  ? 'Already attached to a different candidate.'
                  : data.error ?? `Failed (${res.status})`,
            }
          }
          return { keyStr, ok: true, simulationId: data.simulationId ?? null, err: null }
        } catch (err) {
          return {
            keyStr,
            ok: false,
            simulationId: null,
            err: err instanceof Error ? err.message : 'Network error',
          }
        }
      }),
    )

    const failures = new Map<string, string>()
    const successIds: string[] = []
    for (const r of results) {
      if (r.ok) {
        if (r.simulationId) successIds.push(r.simulationId)
      } else if (r.err) {
        failures.set(r.keyStr, r.err)
      }
    }
    setPerRowErrors(failures)
    setSubmitting(false)

    if (failures.size === 0) {
      // Full batch success — tell parent + close self. onAttached fires
      // first so the panel's row reload starts before the modal unmounts.
      onAttached(successIds)
      onClose()
      return
    }
    // Partial success — keep modal open, narrow the selection to just
    // the failed rows so the user can retry only them. Fire onAttached
    // with the successful subset so the parent can refresh the panel
    // now rather than waiting for the modal to close.
    setSelectedKeys(new Set(failures.keys()))
    if (successIds.length > 0) {
      onAttached(successIds)
    }
  }, [selectedKeys, candidateId, onAttached, onClose])

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
            Pick one or more past MockCustomer tests to attach to this candidate. Each becomes a row on the
            candidate page with its recording + evaluation.
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
                  const key: RowKey = { type: r.resourceType, id: r.id }
                  const keyStr = keyToString(key)
                  const isPicked = selectedKeys.has(keyStr)
                  const rowErr = perRowErrors.get(keyStr) ?? null
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
                  const score = r.resourceType === 'session' ? r.result : null
                  return (
                    <li key={keyStr}>
                      <label
                        className={`flex items-start gap-2 p-2 rounded-[8px] border cursor-pointer transition-colors ${
                          rowErr
                            ? 'border-rose-300 bg-rose-50/40'
                            : isPicked
                              ? 'border-brand-500 bg-brand-50/40'
                              : 'border-surface-border hover:bg-surface-light'
                        }`}
                      >
                        <input
                          type="checkbox"
                          name="mc-artifact"
                          checked={isPicked}
                          onChange={() => toggle(key)}
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
                            {score && (
                              <span
                                className={`inline-block text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                                  score.passed
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    : 'bg-amber-50 text-amber-700 border-amber-200'
                                }`}
                                title={`Threshold ${Math.round(score.passThreshold * 100)}%`}
                              >
                                {Math.round(score.overallScore * 100)}% {score.passed ? '· pass' : '· fail'}
                              </span>
                            )}
                            {audioIndicator && (
                              <span className="text-[10px] text-brand-600">▶ audio</span>
                            )}
                          </div>
                          <div className="text-[11px] text-grey-50 mt-0.5 font-mono">
                            {secondary}
                            <span className="ml-2 text-grey-35">{r.id.slice(0, 8)}…</span>
                          </div>
                          {score?.summary && (
                            <div className="text-[11px] text-grey-35 mt-1 line-clamp-2">
                              {score.summary}
                            </div>
                          )}
                          {rowErr && (
                            <div className="text-[11px] text-rose-700 mt-1" role="alert">
                              {rowErr}
                            </div>
                          )}
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

        <div className="px-5 py-3 border-t border-surface-divider flex items-center justify-between gap-2">
          <div className="text-[11px] text-grey-50">
            {selectedKeys.size > 0
              ? `${selectedKeys.size} selected`
              : 'Pick at least one'}
          </div>
          <div className="flex items-center gap-2">
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
              disabled={selectedKeys.size === 0 || submitting}
              className="px-3 py-2 rounded-[8px] bg-ink text-white text-[12px] font-semibold disabled:opacity-50 hover:bg-grey-15 transition-colors"
            >
              {submitting
                ? `Attaching ${selectedKeys.size}…`
                : selectedKeys.size <= 1
                  ? 'Attach to candidate'
                  : `Attach ${selectedKeys.size} to candidate`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
