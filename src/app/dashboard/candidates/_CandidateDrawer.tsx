/**
 * CandidateDrawer — slide-in side panel that opens when the recruiter clicks
 * a candidate card on the kanban.
 *
 * Hosts the same status / stage actions as the full detail page so most
 * common moves don't require leaving the kanban. The detail page is still
 * one click away for everything else (timeline, journey, AI eval, etc.)
 * via the footer CTA.
 *
 * Status changes and stage moves PATCH the same `/api/candidates/[id]`
 * endpoint the detail page uses; the parent kanban gets the resulting
 * patch via `onCandidateChanged` and merges it into its candidate list
 * so the card reflects the new state without a re-fetch.
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import { Badge, WipBadge, WipSection } from '@/components/design'
import {
  STATUS_DISPLAY,
  DISPOSITION_DISPLAY,
  type CandidateStatus,
  type CandidateDispositionReason,
  type CustomStatus,
} from '@/lib/candidate-status'
import type { FunnelStage } from '@/lib/funnel-stages'
import { DispositionReasonPicker } from './_DispositionReasonPicker'

export interface CandidateDrawerCandidate {
  id: string
  candidateName: string | null
  candidateEmail: string | null
  pipelineStatus: string | null
  status: string | null
  dispositionReason: CandidateDispositionReason | null
  stalledAt: string | null
  lostAt: string | null
  hiredAt: string | null
  flow: { id: string; name: string } | null
  startedAt: string
  nextMeetingAt?: string | null
  latestStep?: { label: string; at: string } | null
}

export interface CandidateDrawerProps {
  candidate: CandidateDrawerCandidate | null
  onClose: () => void
  customStatuses: CustomStatus[]
  stages: FunnelStage[]
  // Called with the partial patch after a successful PATCH so the parent
  // kanban can merge it into its candidate list. The drawer also updates
  // its own internal copy optimistically.
  onCandidateChanged: (patch: Partial<CandidateDrawerCandidate>) => void
  // Quick-action callbacks. Each one is optional — when omitted the button
  // renders disabled with a "Coming soon" badge.
  onSendMessage?: () => void
  onRunAutomation?: () => void
  onScheduleInterview?: () => void
}

interface DrawerMeeting {
  id: string
  scheduledStart: string
  recordingState: string
  driveRecordingFileId: string | null
  recallRecordingId: string | null
}

interface DrawerCapture {
  id: string
  mode: string
  prompt: string | null
  playbackUrl: string | null
  captureOrdinal: number | null
}

interface DrawerRecording {
  id: string
  isVideo: boolean
  label: string
  subtitle: string | null
  url: string
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

export function CandidateDrawer({
  candidate,
  onClose,
  customStatuses,
  stages,
  onCandidateChanged,
  onSendMessage,
  onRunAutomation,
  onScheduleInterview,
}: CandidateDrawerProps) {
  // Esc dismisses the drawer.
  React.useEffect(() => {
    if (!candidate) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [candidate, onClose])

  const open = !!candidate
  const [busy, setBusy] = React.useState(false)
  const [reasonModal, setReasonModal] = React.useState<null | {
    mode: 'set-status' | 'change-reason'
    targetStatus?: CandidateStatus
    initial: CandidateDispositionReason | null
  }>(null)
  // Recordings — meeting recordings + flow captures, fetched lazily when
  // the drawer opens. null = not loaded yet, [] = loaded with nothing.
  const [recordings, setRecordings] = React.useState<DrawerRecording[] | null>(null)
  const [recordingsLoading, setRecordingsLoading] = React.useState(false)

  React.useEffect(() => {
    if (!candidate) { setRecordings(null); return }
    let aborted = false
    setRecordingsLoading(true)
    Promise.all([
      fetch(`/api/candidates/${candidate.id}/interview-meetings`).then((r) => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/captures/session/${candidate.id}`).then((r) => r.ok ? r.json() : { captures: [] }).catch(() => ({ captures: [] })),
    ]).then(([meetingsRes, capturesRes]) => {
      if (aborted) return
      const meetings: DrawerMeeting[] = Array.isArray(meetingsRes) ? meetingsRes : []
      const captures: DrawerCapture[] = Array.isArray(capturesRes?.captures) ? capturesRes.captures : []
      const items: DrawerRecording[] = []
      for (const m of meetings) {
        const hasPrimary = m.recordingState === 'ready' && (m.driveRecordingFileId || m.recallRecordingId)
        if (hasPrimary) {
          items.push({
            id: `meeting:${m.id}`,
            isVideo: true,
            label: 'Interview recording',
            subtitle: fmtDate(m.scheduledStart),
            url: `/api/interview-meetings/${m.id}/recording`,
          })
        }
      }
      for (const c of captures) {
        if (!c.playbackUrl) continue
        const isV = c.mode === 'video' || c.mode === 'audio_video'
        items.push({
          id: `capture:${c.id}`,
          isVideo: isV,
          label: isV ? 'Video answer' : 'Voice answer',
          subtitle: c.prompt || (c.captureOrdinal ? `Step ${c.captureOrdinal}` : null),
          url: c.playbackUrl,
        })
      }
      setRecordings(items)
    }).finally(() => { if (!aborted) setRecordingsLoading(false) })
    return () => { aborted = true }
  }, [candidate?.id])

  const status = (candidate?.status as CandidateStatus | string | null) || 'active'
  const dispositionReason = candidate?.dispositionReason ?? null

  const patchCandidate = async (body: Record<string, unknown>) => {
    if (!candidate || busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/candidates/${candidate.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        alert(j?.error || 'Failed to update candidate')
        return
      }
      const data = await res.json().catch(() => ({}))
      // Merge the authoritative response onto our local row + propagate to
      // the parent. The PATCH response carries status / disposition / *At
      // stamps after a lifecycle change; for pipelineStatus-only patches
      // we fall back to what we sent.
      const patch: Partial<CandidateDrawerCandidate> = {
        status: (data.status ?? body.status ?? candidate.status) as string | null,
        pipelineStatus: (data.pipelineStatus ?? body.pipelineStatus ?? candidate.pipelineStatus) as string | null,
        dispositionReason: (data.dispositionReason ?? null) as CandidateDispositionReason | null,
        stalledAt: (data.stalledAt ?? null) as string | null,
        lostAt: (data.lostAt ?? null) as string | null,
        hiredAt: (data.hiredAt ?? null) as string | null,
      }
      // If the caller only sent pipelineStatus, preserve the existing
      // status/disposition/*At rather than overwriting with nulls from
      // the response (which might not echo those fields back).
      if (body.status === undefined && body.dispositionReason === undefined) {
        patch.status = candidate.status
        patch.dispositionReason = candidate.dispositionReason
        patch.stalledAt = candidate.stalledAt
        patch.lostAt = candidate.lostAt
        patch.hiredAt = candidate.hiredAt
      }
      onCandidateChanged(patch)
    } finally {
      setBusy(false)
    }
  }

  const updateLifecycle = async (next: CandidateStatus | string, reason?: CandidateDispositionReason | null) => {
    const body: Record<string, unknown> = { status: next }
    if (reason !== undefined) body.dispositionReason = reason
    await patchCandidate(body)
  }

  const updateStage = async (pipelineStatus: string) => {
    await patchCandidate({ pipelineStatus })
  }

  const submitReasonModal = async (chosen: CandidateDispositionReason | null) => {
    const m = reasonModal
    if (!m) { return }
    if (m.mode === 'set-status' && m.targetStatus) {
      await updateLifecycle(m.targetStatus, chosen)
    } else if (m.mode === 'change-reason') {
      await patchCandidate({ dispositionReason: chosen })
    }
    setReasonModal(null)
  }

  // Status display metadata — fall back to a neutral pill for custom
  // statuses so the badge always renders.
  const statusMeta = (() => {
    const builtin = (STATUS_DISPLAY as Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warn' | 'info' | 'danger' }>)[status]
    if (builtin) return builtin
    const custom = customStatuses.find((c) => c.id === status)
    if (custom) return { label: custom.label, tone: custom.tone }
    return { label: status, tone: 'neutral' as const }
  })()

  const stageLabel = candidate?.pipelineStatus
    ? (stages.find((s) => s.id === candidate.pipelineStatus)?.label || candidate.pipelineStatus)
    : null

  return (
    <>
      {/* Scrim */}
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-0 z-[55] transition-opacity duration-200 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        style={{ background: 'rgba(23,23,26,0.35)', backdropFilter: 'blur(2px)' }}
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Candidate detail"
        className={`fixed top-0 right-0 bottom-0 z-[56] w-full md:w-[440px] flex flex-col bg-white transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ boxShadow: '-20px 0 40px -20px rgba(0,0,0,0.2)' }}
      >
        {candidate && (
          <>
            {/* Header */}
            <div className="px-5 py-4 border-b border-surface-border flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35 mb-1">
                  Candidate
                </div>
                <div className="font-semibold text-[16px] text-ink truncate">
                  {candidate.candidateName || 'Unnamed'}
                </div>
                <div className="text-[12px] text-grey-35 truncate">
                  {candidate.candidateEmail || '—'}
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="w-9 h-9 rounded-[10px] inline-flex items-center justify-center text-ink hover:bg-surface-light"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M6 18 18 6" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Summary chips */}
              <div className="flex flex-wrap gap-2">
                <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                {dispositionReason && (
                  <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full font-medium border bg-surface-light text-grey-15 border-surface-border">
                    {DISPOSITION_DISPLAY[dispositionReason]}
                  </span>
                )}
                {stageLabel && (
                  <Badge tone="neutral">Stage: {stageLabel}</Badge>
                )}
              </div>

              {/* Snapshot */}
              <section className="rounded-[12px] border border-surface-border p-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35 mb-2">
                  Snapshot
                </div>
                <dl className="grid grid-cols-2 gap-y-2 text-[12px]">
                  <dt className="text-grey-35">Flow</dt>
                  <dd className="text-ink truncate">{candidate.flow?.name || '—'}</dd>
                  <dt className="text-grey-35">Applied</dt>
                  <dd className="text-ink">{fmtDate(candidate.startedAt)}</dd>
                  <dt className="text-grey-35">Next meeting</dt>
                  <dd className="text-ink">{fmtDate(candidate.nextMeetingAt)}</dd>
                  <dt className="text-grey-35">Last step</dt>
                  <dd className="text-ink">{candidate.latestStep?.label || '—'}</dd>
                </dl>
              </section>

              {/* Lifecycle status — same actions as the detail page so the
                  drawer covers the most common moves without leaving the
                  kanban. */}
              <section className="rounded-[12px] border border-surface-border p-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35 mb-2">
                  Lifecycle status
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {status !== 'active' && status !== 'waiting' && (
                    <button
                      onClick={() => updateLifecycle('active', null)}
                      disabled={busy}
                      className="text-[11px] px-2.5 py-1 rounded-[6px] bg-brand-100 text-brand-700 hover:bg-brand-200 font-medium disabled:opacity-50"
                    >
                      Reactivate
                    </button>
                  )}
                  {status !== 'lost' && (
                    <button
                      onClick={() => setReasonModal({ mode: 'set-status', targetStatus: 'lost', initial: 'manual_other' })}
                      disabled={busy}
                      className="text-[11px] px-2.5 py-1 rounded-[6px] bg-red-100 text-red-700 hover:bg-red-200 font-medium disabled:opacity-50"
                    >
                      Move to Lost
                    </button>
                  )}
                  {status !== 'nurture' && (
                    <button
                      onClick={() => setReasonModal({ mode: 'set-status', targetStatus: 'nurture', initial: dispositionReason })}
                      disabled={busy}
                      className="text-[11px] px-2.5 py-1 rounded-[6px] bg-surface-light text-grey-15 hover:bg-surface-divider font-medium border border-surface-border disabled:opacity-50"
                    >
                      Move to On Hold
                    </button>
                  )}
                  {status !== 'hired' && (
                    <button
                      onClick={() => updateLifecycle('hired')}
                      disabled={busy}
                      className="text-[11px] px-2.5 py-1 rounded-[6px] bg-green-100 text-green-700 hover:bg-green-200 font-medium disabled:opacity-50"
                    >
                      Mark as Hired
                    </button>
                  )}
                  {customStatuses.filter((c) => c.id !== status).map((c) => (
                    <button
                      key={c.id}
                      onClick={() => updateLifecycle(c.id)}
                      disabled={busy}
                      className="text-[11px] px-2.5 py-1 rounded-[6px] bg-surface-light text-grey-15 hover:bg-surface-divider font-medium border border-surface-border disabled:opacity-50"
                    >
                      Move to {c.label}
                    </button>
                  ))}
                  <button
                    onClick={() => setReasonModal({ mode: 'change-reason', initial: dispositionReason })}
                    disabled={busy}
                    className="text-[11px] px-2.5 py-1 rounded-[6px] text-grey-40 hover:text-grey-15 hover:bg-surface-light font-medium disabled:opacity-50"
                  >
                    Change reason
                  </button>
                </div>
              </section>

              {/* Pipeline stage picker — writes Session.pipelineStatus. */}
              <section className="rounded-[12px] border border-surface-border p-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35 mb-2">
                  Pipeline stage
                </div>
                <select
                  value={candidate.pipelineStatus ?? ''}
                  onChange={(e) => updateStage(e.target.value)}
                  disabled={busy || stages.length === 0}
                  className="w-full text-[13px] px-2.5 py-1.5 rounded-[8px] border border-surface-border bg-white text-ink disabled:opacity-50"
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </section>

              {/* Recordings — meeting recordings (Drive / Recall) and flow
                  captures (audio / video answers). Section hides itself
                  when there's nothing to show; loading state stays quiet
                  so the drawer doesn't flash an empty card. */}
              {recordings && recordings.length > 0 && (
                <section className="rounded-[12px] border border-surface-border p-3">
                  <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35 mb-2">
                    Recordings ({recordings.length})
                  </div>
                  <ul className="space-y-2">
                    {recordings.map((rec) => (
                      <li key={rec.id} className="flex items-start gap-2.5">
                        <span aria-hidden className="shrink-0 mt-0.5 w-7 h-7 rounded-[8px] bg-surface-light border border-surface-border flex items-center justify-center text-grey-15">
                          {rec.isVideo ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="2" y="6" width="14" height="12" rx="2" />
                              <path d="m22 8-6 4 6 4V8Z" />
                            </svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="9" y="3" width="6" height="12" rx="3" />
                              <path d="M19 11a7 7 0 1 1-14 0" />
                              <path d="M12 18v3" />
                            </svg>
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-medium text-ink truncate">{rec.label}</div>
                          {rec.subtitle && (
                            <div className="text-[11px] text-grey-35 truncate">{rec.subtitle}</div>
                          )}
                        </div>
                        <a
                          href={rec.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-[11px] px-2.5 py-1 rounded-[6px] border border-surface-border text-ink hover:bg-surface-light font-medium"
                        >
                          Open ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {recordingsLoading && recordings === null && (
                <div className="text-[11px] text-grey-35 px-1">Loading recordings…</div>
              )}

              {/* Placeholders for sections per spec — backend exists at
                  /dashboard/candidates/[id] but the drawer-side render is
                  queued. */}
              <WipSection
                title="Current journey / process"
                description="Will show the linked Journey and its Flow / Training / Scheduling / Pipeline once wired."
              />
              <WipSection
                title="AI evaluation"
                description="Score + rubric breakdown from the candidate evaluation engine."
              />
              <WipSection
                title="Recent timeline"
                description="Last 5 events (answers, training, meetings, automations)."
              />
            </div>

            {/* Footer — remaining quick actions + escape to full detail.
                Send message / Run automation / Schedule interview don't have
                reusable modals on the kanban surface yet — they stay WIP
                until those modals are extracted. */}
            <div className="border-t border-surface-border p-4 space-y-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35">
                Quick actions
              </div>
              <div className="grid grid-cols-3 gap-2">
                <QuickAction label="Send message" onClick={onSendMessage} />
                <QuickAction label="Run automation" onClick={onRunAutomation} />
                <QuickAction label="Schedule" onClick={onScheduleInterview} />
              </div>
              <Link
                href={`/dashboard/candidates/${candidate.id}`}
                className="flex items-center justify-center gap-1.5 w-full py-2 rounded-[10px] bg-ink text-white text-[13px] font-medium hover:bg-grey-15"
              >
                Open full detail
                <span aria-hidden>→</span>
              </Link>
            </div>
          </>
        )}
      </aside>

      {reasonModal && (
        <DispositionReasonPicker
          mode={reasonModal.mode}
          targetStatus={reasonModal.targetStatus}
          initial={reasonModal.initial}
          onClose={() => setReasonModal(null)}
          onSubmit={submitReasonModal}
        />
      )}
    </>
  )
}

function QuickAction({ label, onClick }: { label: string; onClick?: () => void }) {
  const disabled = !onClick
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center justify-between gap-1 px-3 py-2 rounded-[10px] border text-[12px] font-medium transition-colors ${
        disabled
          ? 'border-dashed border-grey-35 text-grey-35 cursor-not-allowed'
          : 'border-surface-border text-ink hover:bg-surface-light'
      }`}
    >
      <span className="truncate">{label}</span>
      {disabled && <WipBadge label="WIP" />}
    </button>
  )
}
