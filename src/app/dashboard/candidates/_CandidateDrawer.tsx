/**
 * CandidateDrawer — slide-in side panel that opens when the recruiter clicks
 * a candidate card on the kanban.
 *
 * Hosts the same status / stage actions as the detail page, plus quick
 * actions (Send message / Run automation / Schedule interview) and
 * snapshot sections (Current journey, Recent timeline, AI evaluation,
 * Recordings) sourced from the same APIs the detail page uses.
 *
 * Lifecycle and stage PATCHes propagate to the parent kanban via
 * `onCandidateChanged` so the card on the board reflects the new state
 * without a re-fetch. The rest of the data (process, timeline events,
 * AI eval, recordings) is fetched lazily when the drawer opens and is
 * read-only inside the drawer.
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import { Badge } from '@/components/design'
import {
  STATUS_DISPLAY,
  DISPOSITION_DISPLAY,
  type CandidateStatus,
  type CandidateDispositionReason,
  type CustomStatus,
} from '@/lib/candidate-status'
import type { FunnelStage } from '@/lib/funnel-stages'
import { DispositionReasonPicker } from './_DispositionReasonPicker'
import { SendMessageModal } from './_SendMessageModal'
import { RunAutomationModal } from './_RunAutomationModal'
import { ScheduleInterviewDialog } from './[id]/_ScheduleInterviewDialog'

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
  // kanban can merge it into its candidate list.
  onCandidateChanged: (patch: Partial<CandidateDrawerCandidate>) => void
}

interface DrawerMeetingArtifact {
  id: string
  kind: string
  driveFileId: string
  fileName: string | null
  driveCreatedTime: string
}

interface DrawerMeeting {
  id: string
  scheduledStart: string
  recordingState: string
  driveRecordingFileId: string | null
  recallRecordingId: string | null
  artifacts?: DrawerMeetingArtifact[]
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

// Subset of the candidate-detail API response — enough to render Current
// journey + Recent timeline in the drawer without dragging the full type.
interface CandidateDetailLite {
  process?: {
    id: string
    name: string
    status: 'draft' | 'active' | 'archived'
    flow: { id: string; name: string } | null
    training: { id: string; title: string } | null
    schedulingConfig: { id: string; name: string } | null
    pipeline: { id: string; name: string } | null
  } | null
  finishedAt?: string | null
  outcome?: string | null
  schedulingEvents?: Array<{ id: string; eventType: string; eventAt: string }>
  interviewMeetings?: Array<{ id: string; actualStart: string | null; actualEnd: string | null; scheduledStart: string }>
  trainingEnrollments?: Array<{ id: string; startedAt: string; completedAt: string | null; training: { title: string } }>
  automationExecutions?: Array<{ id: string; sentAt: string | null; automationRule: { name: string } }>
}

interface DrawerEvaluation {
  id: string
  overallScore: number
  recommendation: string
  summary: string
  createdAt: string
}

interface TimelineEvent {
  label: string
  at: string
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

function fmtRelative(iso: string): string {
  const d = new Date(iso).getTime()
  const now = Date.now()
  const mins = Math.round((now - d) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function buildRecentEvents(d: CandidateDetailLite, lifecycle: Pick<CandidateDrawerCandidate, 'startedAt' | 'stalledAt' | 'lostAt' | 'hiredAt'>): TimelineEvent[] {
  const events: TimelineEvent[] = []
  events.push({ label: 'Applied', at: lifecycle.startedAt })
  if (d.finishedAt) events.push({ label: `Flow ${d.outcome || 'completed'}`, at: d.finishedAt })
  if (lifecycle.stalledAt) events.push({ label: 'Became stalled', at: lifecycle.stalledAt })
  if (lifecycle.hiredAt) events.push({ label: 'Marked hired', at: lifecycle.hiredAt })
  if (lifecycle.lostAt) events.push({ label: 'Marked lost', at: lifecycle.lostAt })
  for (const t of d.trainingEnrollments || []) {
    events.push({ label: `Training started: ${t.training.title}`, at: t.startedAt })
    if (t.completedAt) events.push({ label: `Training completed: ${t.training.title}`, at: t.completedAt })
  }
  const schedLabels: Record<string, string> = {
    scheduling_invite_sent: 'Scheduling invite sent',
    meeting_scheduled: 'Meeting scheduled',
    meeting_nudge_sent: 'Meeting nudge sent',
    meeting_cancelled: 'Meeting cancelled',
    meeting_no_show: 'No-show recorded',
  }
  for (const e of d.schedulingEvents || []) {
    events.push({ label: schedLabels[e.eventType] || e.eventType, at: e.eventAt })
  }
  for (const m of d.interviewMeetings || []) {
    if (m.actualStart) events.push({ label: 'Interview started', at: m.actualStart })
    if (m.actualEnd) events.push({ label: 'Interview ended', at: m.actualEnd })
  }
  for (const a of d.automationExecutions || []) {
    if (a.sentAt) events.push({ label: `Automation sent: ${a.automationRule.name}`, at: a.sentAt })
  }
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  return events.slice(0, 5)
}

function recommendationMeta(rec: string): { label: string; cls: string } {
  switch (rec) {
    case 'strong_hire': return { label: 'Strong hire', cls: 'bg-green-100 text-green-700' }
    case 'hire':        return { label: 'Hire',        cls: 'bg-green-50 text-green-700' }
    case 'borderline':  return { label: 'Borderline',  cls: 'bg-amber-100 text-amber-700' }
    case 'no_hire':     return { label: 'No hire',     cls: 'bg-red-100 text-red-700' }
    default:            return { label: rec,           cls: 'bg-surface-light text-grey-15' }
  }
}

export function CandidateDrawer({
  candidate,
  onClose,
  customStatuses,
  stages,
  onCandidateChanged,
}: CandidateDrawerProps) {
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
  const [activeModal, setActiveModal] = React.useState<null | 'send-message' | 'run-automation' | 'schedule'>(null)
  const [recordings, setRecordings] = React.useState<DrawerRecording[] | null>(null)
  const [detail, setDetail] = React.useState<CandidateDetailLite | null>(null)
  const [evaluation, setEvaluation] = React.useState<DrawerEvaluation | null>(null)
  const [evalLoading, setEvalLoading] = React.useState(false)

  React.useEffect(() => {
    if (!candidate) { setRecordings(null); setDetail(null); setEvaluation(null); return }
    let aborted = false
    setEvalLoading(true)
    Promise.all([
      fetch(`/api/candidates/${candidate.id}/interview-meetings`).then((r) => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/captures/session/${candidate.id}`).then((r) => r.ok ? r.json() : { captures: [] }).catch(() => ({ captures: [] })),
      fetch(`/api/candidates/${candidate.id}`).then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/evaluations?sessionIds=${candidate.id}`).then((r) => r.ok ? r.json() : { evaluations: [] }).catch(() => ({ evaluations: [] })),
    ]).then(([meetingsRes, capturesRes, detailRes, evalRes]) => {
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
        // Extra artifacts — surfaces reschedule-orphans (prior Meet link
        // recordings) and late-arriving Drive deliveries that didn't make
        // it onto the meeting's primary recording slot. Mirrors the same
        // filter the detail page's InterviewPanel uses.
        const primaryRecallTag = m.recallRecordingId ? `recall:${m.recallRecordingId}` : null
        const extras = (m.artifacts || []).filter((a) =>
          a.kind === 'recording'
          && a.driveFileId !== m.driveRecordingFileId
          && a.driveFileId !== primaryRecallTag,
        )
        for (const a of extras) {
          const isRecall = a.driveFileId.startsWith('recall:')
          items.push({
            id: `artifact:${a.id}`,
            isVideo: true,
            label: a.fileName || (isRecall ? 'Recall recording' : 'Drive recording'),
            subtitle: fmtDate(a.driveCreatedTime),
            url: isRecall
              ? `/api/interview-meetings/${m.id}/recording`
              : `https://drive.google.com/file/d/${a.driveFileId}/view`,
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
      setDetail(detailRes && typeof detailRes === 'object' ? detailRes : null)
      const evals = Array.isArray(evalRes?.evaluations) ? evalRes.evaluations : []
      setEvaluation(evals.length > 0 ? evals[0] : null)
    }).finally(() => { if (!aborted) setEvalLoading(false) })
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
      const patch: Partial<CandidateDrawerCandidate> = {
        status: (data.status ?? body.status ?? candidate.status) as string | null,
        pipelineStatus: (data.pipelineStatus ?? body.pipelineStatus ?? candidate.pipelineStatus) as string | null,
        dispositionReason: (data.dispositionReason ?? null) as CandidateDispositionReason | null,
        stalledAt: (data.stalledAt ?? null) as string | null,
        lostAt: (data.lostAt ?? null) as string | null,
        hiredAt: (data.hiredAt ?? null) as string | null,
      }
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
    if (!m) return
    if (m.mode === 'set-status' && m.targetStatus) {
      await updateLifecycle(m.targetStatus, chosen)
    } else if (m.mode === 'change-reason') {
      await patchCandidate({ dispositionReason: chosen })
    }
    setReasonModal(null)
  }

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

  const recentEvents = (candidate && detail)
    ? buildRecentEvents(detail, {
      startedAt: candidate.startedAt,
      stalledAt: candidate.stalledAt,
      lostAt: candidate.lostAt,
      hiredAt: candidate.hiredAt,
    })
    : []

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
                {stageLabel && <Badge tone="neutral">Stage: {stageLabel}</Badge>}
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

              {/* Lifecycle status */}
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

              {/* Pipeline stage picker */}
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

              {/* Current journey / process — sourced from Session.process,
                  populated when the flow has an active HiringProcess attached. */}
              {detail?.process && (
                <section className="rounded-[12px] border border-surface-border p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35">
                      Current journey
                    </div>
                    <Badge tone={detail.process.status === 'active' ? 'success' : 'neutral'}>
                      {detail.process.status}
                    </Badge>
                  </div>
                  <div className="text-[13px] font-medium text-ink mb-2 truncate">
                    {detail.process.name}
                  </div>
                  <dl className="grid grid-cols-2 gap-y-1.5 text-[11px]">
                    <dt className="text-grey-35">Flow</dt>
                    <dd className="text-ink truncate">{detail.process.flow?.name || '—'}</dd>
                    <dt className="text-grey-35">Training</dt>
                    <dd className="text-ink truncate">{detail.process.training?.title || '—'}</dd>
                    <dt className="text-grey-35">Scheduling</dt>
                    <dd className="text-ink truncate">{detail.process.schedulingConfig?.name || '—'}</dd>
                    <dt className="text-grey-35">Pipeline</dt>
                    <dd className="text-ink truncate">{detail.process.pipeline?.name || '—'}</dd>
                  </dl>
                </section>
              )}

              {/* AI evaluation summary — pulls latest CandidateEvaluation. */}
              {evaluation && (
                <section className="rounded-[12px] border border-surface-border p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35">
                      AI evaluation
                    </div>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${recommendationMeta(evaluation.recommendation).cls}`}>
                      {recommendationMeta(evaluation.recommendation).label}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="text-[20px] font-semibold text-ink">{evaluation.overallScore}</span>
                    <span className="text-[11px] text-grey-35">/ 100</span>
                    <span className="text-[11px] text-grey-35 ml-auto">{fmtRelative(evaluation.createdAt)}</span>
                  </div>
                  {evaluation.summary && (
                    <p className="text-[11px] text-grey-35 line-clamp-3">{evaluation.summary}</p>
                  )}
                  <Link
                    href={`/dashboard/candidates/${candidate.id}`}
                    className="inline-block mt-2 text-[11px] text-brand-700 hover:text-brand-800 font-medium"
                  >
                    Open full evaluation →
                  </Link>
                </section>
              )}
              {!evaluation && evalLoading && (
                <div className="text-[11px] text-grey-35 px-1">Loading evaluation…</div>
              )}

              {/* Recent timeline — top 5 events derived from candidate detail. */}
              {recentEvents.length > 0 && (
                <section className="rounded-[12px] border border-surface-border p-3">
                  <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35 mb-2">
                    Recent timeline
                  </div>
                  <ul className="space-y-2">
                    {recentEvents.map((ev, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span aria-hidden className="mt-1 w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] text-ink truncate">{ev.label}</div>
                          <div className="text-[10px] text-grey-35">{fmtRelative(ev.at)}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Recordings — meeting recordings (Drive / Recall) and flow
                  captures. Hidden when there's nothing to show. */}
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
                          {rec.subtitle && <div className="text-[11px] text-grey-35 truncate">{rec.subtitle}</div>}
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
            </div>

            {/* Footer — quick actions + escape to full detail */}
            <div className="border-t border-surface-border p-4 space-y-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35">
                Quick actions
              </div>
              <div className="grid grid-cols-3 gap-2">
                <QuickAction label="Send message" onClick={() => setActiveModal('send-message')} />
                <QuickAction label="Run automation" onClick={() => setActiveModal('run-automation')} />
                <QuickAction label="Schedule" onClick={() => setActiveModal('schedule')} />
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

      {candidate && activeModal === 'send-message' && (
        <SendMessageModal
          candidateId={candidate.id}
          candidateEmail={candidate.candidateEmail}
          onClose={() => setActiveModal(null)}
        />
      )}

      {candidate && activeModal === 'run-automation' && (
        <RunAutomationModal
          candidateId={candidate.id}
          stageId={candidate.pipelineStatus}
          onClose={() => setActiveModal(null)}
        />
      )}

      {candidate && activeModal === 'schedule' && (
        <ScheduleInterviewDialog
          candidateId={candidate.id}
          candidateEmail={candidate.candidateEmail}
          onClose={() => setActiveModal(null)}
          onScheduled={() => setActiveModal(null)}
        />
      )}
    </>
  )
}

function QuickAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center gap-1 px-3 py-2 rounded-[10px] border border-surface-border text-ink hover:bg-surface-light text-[12px] font-medium transition-colors"
    >
      <span className="truncate">{label}</span>
    </button>
  )
}
