/**
 * Modal for attaching an existing MockCustomer call to a HireFunnel
 * candidate. Lists MC ExternalCalls for the workspace's connected org
 * (via /api/mc-connection/calls, defaulting to recordings-only) and
 * POSTs the picked one to /api/candidates/[id]/mc-simulations/import.
 *
 * UX intent: recruiters who ran calls in MC before connecting HF should
 * be able to bring those results + recordings into the candidate view
 * without re-running.
 */

'use client'

import { useCallback, useEffect, useState } from 'react'

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

interface ListResponse {
  calls: McCallRow[]
  pagination: { nextCursor: string | null; hasMore: boolean; limit: number }
}

interface Props {
  candidateId: string
  onClose: () => void
  onAttached: (simulationId: string) => void
}

export function AttachRecordingModal({ candidateId, onClose, onAttached }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [calls, setCalls] = useState<McCallRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [onlyWithRecording, setOnlyWithRecording] = useState(true)

  const load = useCallback(
    async (cursor: string | null, replace: boolean) => {
      if (replace) setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (cursor) params.set('cursor', cursor)
        params.set('limit', '25')
        if (onlyWithRecording) params.set('onlyWithRecording', 'true')
        const res = await fetch(`/api/mc-connection/calls?${params.toString()}`)
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          setError(body.error ?? `Failed to load MockCustomer calls (${res.status})`)
          if (replace) setCalls([])
          return
        }
        const data = (await res.json()) as ListResponse
        setCalls((prev) => (replace ? data.calls : [...prev, ...data.calls]))
        setNextCursor(data.pagination.nextCursor)
        setHasMore(data.pagination.hasMore)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    },
    [onlyWithRecording],
  )

  useEffect(() => {
    void load(null, true)
  }, [load])

  const submit = useCallback(async () => {
    if (!selected) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/candidates/${candidateId}/mc-simulations/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcCallId: selected }),
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
            // Already on this candidate — treat as success.
            onAttached(data.simulationId)
            return
          }
          setError(
            'This MockCustomer call is already attached to a different candidate in your workspace.',
          )
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
            Pick a past MockCustomer call to attach to this candidate. The recording + evaluation will appear on
            the candidate page.
          </p>

          <label className="text-[11px] text-grey-35 flex items-center gap-1.5 mb-2">
            <input
              type="checkbox"
              checked={onlyWithRecording}
              onChange={(e) => setOnlyWithRecording(e.target.checked)}
            />
            Only show calls with a recording
          </label>

          {loading ? (
            <div className="text-[12px] text-grey-50 py-4">Loading…</div>
          ) : error && calls.length === 0 ? (
            <div className="text-[12px] text-rose-700 py-4">{error}</div>
          ) : calls.length === 0 ? (
            <div className="text-[12px] text-grey-50 py-4">
              No MockCustomer calls found in your organization
              {onlyWithRecording && ' with a recording'}.
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto -mx-1 pr-1">
              <ul className="space-y-1">
                {calls.map((c) => (
                  <li key={c.id}>
                    <label
                      className={`flex items-start gap-2 p-2 rounded-[8px] border cursor-pointer transition-colors ${
                        selected === c.id
                          ? 'border-brand-500 bg-brand-50/40'
                          : 'border-surface-border hover:bg-surface-light'
                      }`}
                    >
                      <input
                        type="radio"
                        name="mc-call"
                        value={c.id}
                        checked={selected === c.id}
                        onChange={() => setSelected(c.id)}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-[12px]">
                          <span className="font-mono text-grey-15">{c.destinationPhoneMasked}</span>
                          <span
                            className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${
                              c.status === 'completed'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : c.status === 'failed' || c.status === 'cancelled'
                                  ? 'bg-rose-50 text-rose-700 border-rose-200'
                                  : 'bg-slate-50 text-slate-700 border-slate-200'
                            } font-mono uppercase tracking-wider`}
                          >
                            {c.status}
                          </span>
                          {c.hasRecording && (
                            <span className="text-[10px] text-brand-600">▶ recording</span>
                          )}
                        </div>
                        <div className="text-[11px] text-grey-50 mt-0.5 font-mono">
                          {new Date(c.queuedAt).toLocaleString()}
                          {c.durationSec != null && ` · ${c.durationSec}s`}
                          <span className="ml-2 text-grey-35">{c.id.slice(0, 8)}…</span>
                        </div>
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <button
                  type="button"
                  onClick={() => void load(nextCursor, false)}
                  className="mt-3 w-full text-[12px] py-2 text-grey-50 hover:text-ink border border-surface-border rounded-[8px]"
                >
                  Load more
                </button>
              )}
            </div>
          )}

          {error && calls.length > 0 && (
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
