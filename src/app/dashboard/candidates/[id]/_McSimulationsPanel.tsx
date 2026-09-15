/**
 * Candidate detail — MockCustomer simulations panel.
 *
 * Three-state render:
 *   - LOADING   → panel is null until we resolve connection status
 *                 (avoids flash of "Connect" for connected workspaces)
 *   - NOT_CONNECTED → single "Connect MockCustomer" CTA + copy explaining
 *                     what MC does. Clicking opens McConnectionModal.
 *   - CONNECTED → historical simulation rows + "Run AI Customer Simulation"
 *                 button. Post-connect this is the default state.
 *
 * The connection status is workspace-scoped and comes from
 * GET /api/mc-connection/status. On successful connect the modal
 * fires `onConnected(status)` and the panel switches to CONNECTED
 * without reloading the page.
 *
 * Kept as its own component (not merged with _AICallsPanel) so the
 * legacy AICall* UI stays untouched — the freeze rule from the
 * MC integration strategy note applies to that subsystem.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { McConnectionModal, type McConnectionStatus } from '@/components/mc/McConnectionModal'
import { AttachRecordingModal } from './_AttachRecordingModal'

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
    // Discriminator + session-specific fields — populated when the row
    // originated as an imported SimulationSession (INVITE mode). Absent
    // for outbound-call rows (which use MC's recording proxy instead).
    resourceType?: 'call' | 'session'
    elevenLabsConversationId?: string | null
    mode?: string | null
    participantName?: string | null
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
  const [status, setStatus] = useState<McConnectionStatus | null>(null) // null = loading
  const [activeAiCustomerName, setActiveAiCustomerName] = useState<string | null>(null)
  const [rows, setRows] = useState<McSimulationRow[]>([])
  const [rowsLoaded, setRowsLoaded] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [attachModalOpen, setAttachModalOpen] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Per-intent launch idempotency key (see server-side runner for the dedup
  // guarantee this is paired with).
  const launchRequestIdRef = useRef<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/mc-connection/status', { method: 'GET' })
      if (!res.ok) {
        // Treat any status-endpoint failure as "not connected" — safer to
        // show the Connect CTA than to silently hide the panel forever.
        setStatus({ connected: false, mcOrganizationSlug: null, mcEnvironment: null })
        return
      }
      const data = (await res.json()) as McConnectionStatus
      setStatus(data)
    } catch {
      setStatus({ connected: false, mcOrganizationSlug: null, mcEnvironment: null })
    }
  }, [])

  const loadRows = useCallback(async () => {
    try {
      const res = await fetch(`/api/candidates/${sessionId}/mc-simulations`, { method: 'GET' })
      if (res.status === 404) return
      if (!res.ok) return
      const data = (await res.json()) as { simulations: McSimulationRow[] }
      setRows(data.simulations ?? [])
    } finally {
      setRowsLoaded(true)
    }
  }, [sessionId])

  const loadActiveAiCustomer = useCallback(async () => {
    try {
      const res = await fetch('/api/mc-connection/ai-customers', { method: 'GET' })
      if (!res.ok) return
      const data = (await res.json()) as { activeAiCustomerName: string | null }
      setActiveAiCustomerName(data.activeAiCustomerName ?? null)
    } catch {
      // Non-fatal — the panel still works without the AC name.
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // Only load simulation rows when connected — no point pinging the
  // simulations endpoint for a workspace that will 403 on launch anyway.
  useEffect(() => {
    if (status?.connected) {
      void loadRows()
      void loadActiveAiCustomer()
    }
  }, [status?.connected, loadRows, loadActiveAiCustomer])

  // Poll non-terminal rows.
  const hasNonTerminal = useMemo(
    () => rows.some((r) => r.status !== 'completed' && r.status !== 'failed' && r.status !== 'cancelled'),
    [rows],
  )
  useEffect(() => {
    if (!status?.connected) return
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
  }, [status?.connected, hasNonTerminal, rows, sessionId])

  const launch = useCallback(async () => {
    if (!launchRequestIdRef.current) launchRequestIdRef.current = crypto.randomUUID()
    const launchRequestId = launchRequestIdRef.current
    setLaunching(true)
    setError(null)
    try {
      const res = await fetch(`/api/candidates/${sessionId}/mc-simulations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchRequestId }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; reason?: string }
        // If the server thinks we're not connected, sync state and open the
        // connect modal instead of showing a raw error.
        if (res.status === 403 && (body.reason === 'canary_disabled' || body.reason === 'mc_not_configured')) {
          setStatus({ connected: false, mcOrganizationSlug: null, mcEnvironment: null })
          setConfirmOpen(false)
          setModalOpen(true)
          return
        }
        setError(body.error ?? `Launch failed (${res.status})`)
        return
      }
      setConfirmOpen(false)
      launchRequestIdRef.current = null
      await loadRows()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed')
    } finally {
      setLaunching(false)
    }
  }, [sessionId, loadRows])

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

  const handleConnected = useCallback((s: McConnectionStatus) => {
    setStatus(s)
    setModalOpen(false)
    // Kick off row load for the newly-connected workspace.
    setRowsLoaded(false)
  }, [])

  // Wait for the status resolve before rendering anything — otherwise we'd
  // flash the "Connect" CTA to already-connected workspaces on every mount.
  if (status === null) return null

  // NOT_CONNECTED state — single CTA + brief copy.
  if (!status.connected) {
    return (
      <>
        <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-grey-15">AI Customer Simulations</h3>
              <p className="text-[12px] text-grey-50 mt-0.5">
                Run AI-driven test calls with candidates. Connect MockCustomer to enable — free during beta, no
                credit card required.
              </p>
            </div>
            <button
              onClick={() => setModalOpen(true)}
              className="text-[12px] px-3 py-1.5 rounded-[8px] bg-brand-500 text-white font-semibold hover:bg-brand-600 transition-colors whitespace-nowrap"
            >
              Connect MockCustomer
            </button>
          </div>
        </div>
        {modalOpen && (
          <McConnectionModal onClose={() => setModalOpen(false)} onConnected={handleConnected} />
        )}
      </>
    )
  }

  // CONNECTED state — historical rows + Run button.
  if (!rowsLoaded) {
    return (
      <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
        <h3 className="text-sm font-semibold text-grey-15">AI Customer Simulations</h3>
        <div className="text-[12px] text-grey-50 mt-2">Loading…</div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-grey-15">AI Customer Simulations</h3>
          <p className="text-[12px] text-grey-50 mt-0.5">
            Recruiter-triggered voice simulation. MockCustomer places the call and returns an evaluation here.
          </p>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-grey-50 flex-wrap">
            {activeAiCustomerName && (
              <span>
                Using AI Customer:{' '}
                <span className="font-mono text-grey-15">{activeAiCustomerName}</span>
              </span>
            )}
            <a
              href="/dashboard/settings/mockcustomer"
              className="text-grey-35 hover:text-ink underline"
            >
              Manage connection
            </a>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <button
            onClick={openConfirm}
            disabled={launching || confirmOpen}
            className="text-[12px] px-3 py-1.5 rounded-[8px] bg-brand-500 text-white font-semibold hover:bg-brand-600 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            Run AI Customer Simulation
          </button>
          <button
            onClick={() => setAttachModalOpen(true)}
            disabled={attachModalOpen}
            className="text-[11px] px-2.5 py-1 rounded-[8px] border border-surface-border text-grey-35 hover:text-ink hover:bg-surface-light transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            + Attach existing recording
          </button>
        </div>
      </div>

      {confirmOpen && (
        <div className="mb-4 p-3 bg-surface rounded-[8px] border border-surface-border">
          <div className="text-[13px] text-grey-15">
            Run AI Customer Simulation for{' '}
            <span className="font-semibold">{candidateName || 'this candidate'}</span>?
          </div>
          <div className="text-[11px] text-grey-50 mt-1">
            MockCustomer will call the candidate&apos;s recorded phone number and return an evaluation.
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
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-3 text-[12px]">
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
                  {r.mcCallId && (() => {
                    // Two audio backends depending on the McSimulation origin:
                    //   - Session imports: MC's voice-public proxy against the
                    //     ElevenLabs conversation.
                    //   - Call imports OR HF-launched calls: MC's external-
                    //     simulations recording proxy against Twilio.
                    const isSession =
                      r.resultProjection?.resourceType === 'session' &&
                      r.resultProjection?.elevenLabsConversationId
                    const audioUrl = isSession
                      ? `https://mockcustomer-api-production-production.up.railway.app/voice/public/sessions/${encodeURIComponent(r.mcCallId)}/audio?id=${encodeURIComponent(r.resultProjection!.elevenLabsConversationId!)}`
                      : `https://mockcustomer-api-production-production.up.railway.app/v1/external-simulations/call/${encodeURIComponent(r.mcCallId)}/recording`
                    return (
                      <audio
                        src={audioUrl}
                        controls
                        preload="none"
                        className="w-full h-8"
                      />
                    )
                  })()}
                </div>
              )}
              {(r.status === 'failed' || r.status === 'cancelled') && r.failureReason && (
                <div className="mt-2 text-[12px] text-rose-700">{r.failureReason}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      {attachModalOpen && (
        <AttachRecordingModal
          candidateId={sessionId}
          onClose={() => setAttachModalOpen(false)}
          onAttached={() => {
            setAttachModalOpen(false)
            void loadRows()
          }}
        />
      )}
    </div>
  )
}
