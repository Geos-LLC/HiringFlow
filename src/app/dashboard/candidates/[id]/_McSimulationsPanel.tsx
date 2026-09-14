/**
 * Candidate detail — MockCustomer simulations panel (PR1B).
 *
 * Recruiter-facing surface for the new MC-backed simulation path. Kept
 * as its own component (rather than growing _AICallsPanel) so:
 *   - Legacy AICall* UI stays untouched — the freeze rule from the
 *     strategy note applies to that subsystem.
 *   - Removal is a single delete when MC eventually replaces AICall*.
 *
 * Rendering rules:
 *   - Fetches existing McSimulation rows on mount.
 *   - Renders a "Run AI Customer Simulation" launch button.
 *   - When the launch API returns 403 with `reason=canary_disabled` or
 *     `reason=mc_not_configured`, the panel silently returns null
 *     (workspace is not on the canary; UI stays hidden). The button
 *     stays visible during the initial fetch — probing the launch
 *     endpoint on click reveals the canary state.
 *   - Terminal rows show the lightweight projection + "Open full
 *     simulation" link when the deepLinkUrl is present.
 *   - No marketing UI, no upsell, no "Powered by MockCustomer" copy.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface McSimulationRow {
  id: string
  mcCallId: string | null
  mcOrganizationId: string
  status: 'queued' | 'ringing' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
  resultProjection: {
    overallScore: number | null
    passed: boolean | null
    summary: string | null
    sessionId: string | null
    deepLinkUrl: string
  } | null
  queuedAt: string
  ringingAt: string | null
  answeredAt: string | null
  completedAt: string | null
  failedAt: string | null
  failureReason: string | null
  createdAt: string
}

interface Props {
  sessionId: string
  candidateName: string | null
}

const POLL_INTERVAL_MS = 10_000

function StatusPill({ status }: { status: McSimulationRow['status'] }) {
  const cls =
    status === 'completed'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : status === 'failed' || status === 'cancelled'
        ? 'bg-rose-50 text-rose-700 border-rose-200'
        : 'bg-slate-50 text-slate-700 border-slate-200'
  return (
    <span
      className={`inline-block text-[11px] px-2 py-0.5 rounded-full border ${cls} font-mono uppercase tracking-wider`}
    >
      {status}
    </span>
  )
}

export function McSimulationsPanel({ sessionId, candidateName }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null) // null = unknown yet
  const [rows, setRows] = useState<McSimulationRow[]>([])
  const [initialLoaded, setInitialLoaded] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Per-intent launch idempotency key. Minted when the recruiter opens
  // the confirmation dialog, reused across:
  //   - the initial POST
  //   - any double-click on the "Launch" button
  //   - any browser retry that survived a network hiccup
  // The server treats a duplicate/concurrent POST with the same value
  // as the same launch (returns the existing McSimulation, does NOT
  // dial MC twice). A NEW UUID is minted only when the recruiter opens
  // the confirmation dialog for a distinct intent.
  const launchRequestIdRef = useRef<string | null>(null)

  const loadRows = useCallback(async () => {
    try {
      const res = await fetch(`/api/candidates/${sessionId}/mc-simulations`, {
        method: 'GET',
      })
      if (res.status === 404) return // candidate wrong workspace — outer guards handled it already
      if (!res.ok) return
      const data = (await res.json()) as { simulations: McSimulationRow[] }
      setRows(data.simulations ?? [])
    } finally {
      setInitialLoaded(true)
    }
  }, [sessionId])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  // Poll non-terminal rows for their state; each row's own polling
  // route reconciles against MC's authoritative status endpoint.
  const hasNonTerminal = useMemo(
    () => rows.some((r) => r.status !== 'completed' && r.status !== 'failed' && r.status !== 'cancelled'),
    [rows],
  )
  useEffect(() => {
    if (!hasNonTerminal) return
    const timer = setInterval(async () => {
      const nonTerminals = rows.filter(
        (r) => r.status !== 'completed' && r.status !== 'failed' && r.status !== 'cancelled',
      )
      const results = await Promise.all(
        nonTerminals.map(async (r) => {
          const res = await fetch(`/api/candidates/${sessionId}/mc-simulations/${r.id}`, {
            method: 'GET',
          })
          if (!res.ok) return null
          const data = (await res.json()) as { simulation: McSimulationRow | null }
          return data.simulation
        }),
      )
      setRows((prev) =>
        prev.map((existing) => {
          const updated = results.find((r) => r?.id === existing.id)
          return updated ?? existing
        }),
      )
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [hasNonTerminal, rows, sessionId])

  const launch = useCallback(async () => {
    // If the ref has been cleared (e.g. by a prior successful launch),
    // mint a fresh id — this defends against a stale "Launch" click
    // after the previous run completed and the dialog was left open.
    if (!launchRequestIdRef.current) {
      launchRequestIdRef.current = crypto.randomUUID()
    }
    const launchRequestId = launchRequestIdRef.current
    setLaunching(true)
    setError(null)
    try {
      const res = await fetch(`/api/candidates/${sessionId}/mc-simulations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchRequestId }),
      })
      if (res.status === 403) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string }
        if (body.reason === 'canary_disabled' || body.reason === 'mc_not_configured') {
          setEnabled(false)
          return
        }
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
        setError(body.error ?? `Launch failed (${res.status})`)
        return
      }
      setEnabled(true)
      setConfirmOpen(false)
      // Successful launch — retire this idempotency key. The next
      // opening of the confirmation dialog mints a fresh one.
      launchRequestIdRef.current = null
      await loadRows()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed')
    } finally {
      setLaunching(false)
    }
  }, [sessionId, loadRows])

  // Mint a fresh launchRequestId per opening of the confirmation
  // dialog — distinct intent = distinct launch. Reuse it across the
  // launch call so a mid-flight double-click / network retry stays
  // dedup'd server-side.
  const openConfirm = useCallback(() => {
    launchRequestIdRef.current = crypto.randomUUID()
    setError(null)
    setConfirmOpen(true)
  }, [])

  const cancelConfirm = useCallback(() => {
    if (launching) return
    launchRequestIdRef.current = null
    setConfirmOpen(false)
  }, [launching])

  // On initial load, if any rows exist we know the workspace is
  // enabled (they got launched somehow). Otherwise we don't know yet.
  // The launch button is always visible until we prove disabled; a
  // 403 from the first click flips the panel invisible.
  if (enabled === false && rows.length === 0) return null
  if (!initialLoaded) return null

  return (
    <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-grey-15">AI Customer Simulations</h3>
          <p className="text-[12px] text-grey-50 mt-0.5">
            Recruiter-triggered voice simulation. MockCustomer places the call and returns a lightweight
            evaluation here. Full transcript + detailed scoring live in MockCustomer.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={openConfirm}
            disabled={launching || confirmOpen}
            className="text-[12px] px-3 py-1.5 rounded-[8px] bg-brand-500 text-white font-semibold hover:bg-brand-600 transition-colors disabled:opacity-50"
          >
            Run AI Customer Simulation
          </button>
        </div>
      </div>

      {confirmOpen && (
        <div className="mb-4 p-3 bg-surface rounded-[8px] border border-surface-border">
          <div className="text-[13px] text-grey-15">
            Run AI Customer Simulation for <span className="font-semibold">{candidateName || 'this candidate'}</span>?
          </div>
          <div className="text-[11px] text-grey-50 mt-1">
            Uses the workspace&apos;s default MockCustomer configuration. MockCustomer will call the candidate&apos;s recorded
            phone number and return an evaluation.
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={launch}
              disabled={launching}
              className="px-3 py-2 rounded-[8px] bg-ink text-white text-[12px] font-semibold disabled:opacity-50 hover:bg-grey-15 transition-colors"
            >
              {launching ? 'Launching…' : 'Launch'}
            </button>
            <button
              onClick={cancelConfirm}
              disabled={launching}
              className="px-3 py-2 rounded-[8px] border border-surface-border text-[12px] text-grey-35 hover:text-ink transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {error && (
            <div className="mt-2 text-[12px] text-rose-600" role="alert">
              {error}
            </div>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="text-[12px] text-grey-50">No simulations yet.</div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="p-3 rounded-[8px] border border-surface-border">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StatusPill status={r.status} />
                  <span className="text-[11px] text-grey-50 font-mono">{new Date(r.queuedAt).toLocaleString()}</span>
                </div>
                {r.resultProjection?.deepLinkUrl && (
                  <a
                    href={r.resultProjection.deepLinkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-brand-600 hover:underline"
                  >
                    Open full simulation ↗
                  </a>
                )}
              </div>
              {r.status === 'completed' && r.resultProjection && (
                <div className="mt-2 flex items-center gap-3 text-[12px]">
                  {typeof r.resultProjection.overallScore === 'number' && (
                    <span className="font-mono">
                      Score {Math.round(r.resultProjection.overallScore * 100)}%
                    </span>
                  )}
                  {r.resultProjection.passed !== null && (
                    <span
                      className={
                        r.resultProjection.passed
                          ? 'text-emerald-700 font-semibold'
                          : 'text-rose-700 font-semibold'
                      }
                    >
                      {r.resultProjection.passed ? 'Pass' : 'Fail'}
                    </span>
                  )}
                  {r.resultProjection.summary && (
                    <span className="text-grey-30 truncate">{r.resultProjection.summary}</span>
                  )}
                </div>
              )}
              {(r.status === 'failed' || r.status === 'cancelled') && r.failureReason && (
                <div className="mt-2 text-[12px] text-rose-700">{r.failureReason}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
