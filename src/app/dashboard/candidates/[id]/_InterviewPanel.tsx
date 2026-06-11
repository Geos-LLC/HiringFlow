'use client'

/**
 * InterviewPanel — surfaces Meet integration v2 meetings for a candidate
 * (scheduled → started → ended → recording ready). Kept visually separate
 * from the legacy SchedulingEvent timeline so the two paths can coexist
 * during rollout.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_FUNNEL_STAGES,
  normalizeStages,
  resolveStage,
  type FunnelStage,
} from '@/lib/funnel-stages'
import { ScheduleInterviewDialog } from './_ScheduleInterviewDialog'

interface InterviewMeetingArtifact {
  id: string
  kind: 'recording' | 'transcript' | 'gemini_notes' | string
  driveFileId: string
  fileName: string | null
  meetSpaceName: string | null
  driveCreatedTime: string
}

interface InterviewMeeting {
  id: string
  meetingUri: string
  meetingCode: string | null
  meetSpaceName: string | null
  scheduledStart: string
  scheduledEnd: string
  actualStart: string | null
  actualEnd: string | null
  recordingEnabled: boolean
  recordingState: string
  recordingProvider: string | null
  recallRecordingId: string | null
  transcriptState: string
  driveRecordingFileId: string | null
  driveTranscriptFileId: string | null
  artifacts: InterviewMeetingArtifact[]
  participants: Array<{ email?: string; displayName?: string; joinTime?: string; leaveTime?: string }> | null
  confirmedAt: string | null
  cancelledAt: string | null
  createdAt: string
}

function stateLabel(m: InterviewMeeting): { text: string; tone: 'blue' | 'green' | 'gray' | 'amber' | 'red' } {
  if (m.cancelledAt) return { text: 'Cancelled', tone: 'red' }
  if (m.actualEnd) return { text: 'Ended', tone: 'gray' }
  if (m.actualStart) return { text: 'In progress', tone: 'green' }
  const inPast = new Date(m.scheduledEnd).getTime() < Date.now()
  if (inPast) return { text: 'Missed or not yet reported', tone: 'amber' }
  return { text: 'Scheduled', tone: 'blue' }
}

function Spinner() {
  return (
    <svg className="animate-spin h-3 w-3 inline-block mr-1 -mt-0.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
  )
}

export function InterviewPanel({ candidateId, candidateEmail, isRebook, onCandidateChanged }: { candidateId: string; candidateEmail: string | null; isRebook?: boolean; onCandidateChanged?: () => void }) {
  const [meetings, setMeetings] = useState<InterviewMeeting[] | null>(null)
  const [showDialog, setShowDialog] = useState(false)
  const [featureOn, setFeatureOn] = useState<boolean | null>(null)
  const [markingNoShow, setMarkingNoShow] = useState<string | null>(null)
  const [removingRecording, setRemovingRecording] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [reschedulingFor, setReschedulingFor] = useState<InterviewMeeting | null>(null)
  const [startingInstant, setStartingInstant] = useState(false)
  const [instantToast, setInstantToast] = useState<string | null>(null)
  // "Where to move the candidate?" modal — opens when the recruiter clicks
  // Cancel meeting. Holds the meeting being cancelled until the recruiter
  // confirms a destination stage (or chooses to keep them where they are).
  const [cancelModal, setCancelModal] = useState<null | { meetingId: string }>(null)
  const [stages, setStages] = useState<FunnelStage[]>(DEFAULT_FUNNEL_STAGES)
  const [currentPipelineStatus, setCurrentPipelineStatus] = useState<string | null>(null)

  // Load this candidate's pipeline stages + current stage. The candidate
  // endpoint serializes `pipeline.stages` resolved from the candidate's flow
  // (or workspace default), so the cancel modal labels alternatives with the
  // same columns the recruiter sees on the kanban for that candidate.
  useEffect(() => {
    fetch(`/api/candidates/${candidateId}`).then((r) => r.json()).then((d) => {
      setCurrentPipelineStatus(typeof d?.pipelineStatus === 'string' ? d.pipelineStatus : null)
      if (Array.isArray(d?.pipeline?.stages)) {
        setStages(normalizeStages(d.pipeline.stages))
      }
    }).catch(() => {})
  }, [candidateId])

  const load = useCallback(async () => {
    const res = await fetch(`/api/candidates/${candidateId}/interview-meetings`)
    if (!res.ok) { setMeetings([]); return }
    const body = await res.json()
    setMeetings(body.meetings || [])
  }, [candidateId])

  const removeRecording = useCallback(async (meetingId: string) => {
    if (!confirm('Remove this recording from the candidate profile? The video file will remain in your Google Drive — delete it from there if you also want it gone there.')) return
    setRemovingRecording(meetingId)
    try {
      const res = await fetch(`/api/interview-meetings/${meetingId}/remove-recording`, { method: 'POST' })
      if (res.ok) {
        await load()
      } else {
        alert('Could not remove recording. Please retry.')
      }
    } finally {
      setRemovingRecording(null)
    }
  }, [load])

  // Step 1 — open the modal. The actual cancel doesn't fire until the
  // recruiter confirms a destination (or "keep in current stage").
  const openCancelModal = useCallback((meetingId: string) => {
    setCancelModal({ meetingId })
  }, [])

  // Step 2 — confirmed from the modal. Cancels the meeting, then if a
  // target stage was picked, PATCHes the candidate's pipelineStatus.
  // `targetStageId === null` means "keep in current stage".
  const confirmCancel = useCallback(async (meetingId: string, targetStageId: string | null) => {
    setCancelling(meetingId)
    try {
      const res = await fetch(`/api/interview-meetings/${meetingId}/cancel`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        alert(body?.message || body?.error || 'Could not cancel meeting. Please retry.')
        return
      }
      // Optimistic: flip the row to Cancelled immediately so the UI doesn't
      // wait on the GET round-trip (which also runs sync-on-read).
      const nowIso = new Date().toISOString()
      setMeetings((prev) =>
        prev ? prev.map((mm) => (mm.id === meetingId ? { ...mm, cancelledAt: nowIso } : mm)) : prev
      )

      if (targetStageId && targetStageId !== currentPipelineStatus) {
        // Recruiter chose to move the candidate. Override any auto-move
        // applyStageTrigger may have done by writing the chosen stage
        // straight to the candidate record.
        await fetch(`/api/candidates/${candidateId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pipelineStatus: targetStageId }),
        }).catch(() => {})
        setCurrentPipelineStatus(targetStageId)
      }

      setCancelModal(null)
      load().catch(() => {})
      onCandidateChanged?.()
    } finally {
      setCancelling(null)
    }
  }, [candidateId, currentPipelineStatus, load, onCandidateChanged])

  const startInstantInterview = useCallback(async () => {
    if (!confirm('Start an instant interview now? This creates a fresh Meet link, sends the recording bot to join immediately, and clears any prior no-show on this candidate.')) return
    setStartingInstant(true)
    setInstantToast(null)
    try {
      const res = await fetch(`/api/candidates/${candidateId}/start-instant-interview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMinutes: 30 }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(body?.message || body?.error || 'Could not start instant interview.')
        return
      }
      const uri = typeof body?.meetingUri === 'string' ? body.meetingUri : null
      if (uri) {
        try { await navigator.clipboard.writeText(uri) } catch { /* ignore — surface fallback below */ }
        window.open(uri, '_blank', 'noopener')
        setInstantToast(`Instant meeting created. Link copied to clipboard — paste it to the candidate. ${body?.botScheduled ? 'Recording bot is on its way.' : 'Recording bot could not be scheduled.'}`)
      }
      await load()
      onCandidateChanged?.()
    } finally {
      setStartingInstant(false)
    }
  }, [candidateId, load, onCandidateChanged])

  const markNoShow = useCallback(async (meetingId: string) => {
    if (!confirm('Mark this meeting as a no-show? The candidate will be moved to Rejected and the no-show follow-up automation (if configured) will run.')) return
    setMarkingNoShow(meetingId)
    try {
      const res = await fetch(`/api/interview-meetings/${meetingId}/mark-no-show`, { method: 'POST' })
      if (res.ok) {
        await load()
        onCandidateChanged?.()
      } else {
        alert('Could not mark as no-show. Please retry.')
      }
    } finally {
      setMarkingNoShow(null)
    }
  }, [load, onCandidateChanged])

  useEffect(() => {
    fetch('/api/integrations/google').then((r) => r.json()).then((d) => {
      setFeatureOn(!!d?.meetV2?.flagEnabled && !!d?.meetV2?.scopesGranted)
    }).catch(() => setFeatureOn(false))
    load()
  }, [load])

  if (featureOn === false) return null
  if (meetings === null) return null

  return (
    <div className="mt-4 bg-white rounded-[12px] border border-surface-border p-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-grey-15">Google Meet interviews</h3>
        <div className="flex items-center gap-2">
          <button
            className="text-xs px-3 py-1.5 rounded-[8px] border border-surface-border text-grey-15 hover:bg-surface-light disabled:opacity-50"
            onClick={startInstantInterview}
            disabled={startingInstant}
            title="Spin up a fresh Meet link + recording bot right now (use this when a scheduled candidate joined late on a new link)"
          >
            {startingInstant ? 'Starting…' : 'Start instant interview'}
          </button>
          <button className="btn-primary text-xs" onClick={() => setShowDialog(true)}>
            Schedule interview
          </button>
        </div>
      </div>
      {instantToast && (
        <div className="mt-3 p-2 rounded-[8px] bg-green-50 text-xs text-green-700 flex items-start justify-between gap-2">
          <span>{instantToast}</span>
          <button
            onClick={() => setInstantToast(null)}
            className="text-green-700 hover:text-green-900 flex-shrink-0"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {meetings.length === 0 ? (
        <p className="mt-3 text-xs text-grey-40">No Meet interviews scheduled yet.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {meetings.map((m) => {
            const s = stateLabel(m)
            return (
              <div key={m.id} className="border border-surface-border rounded-[8px] p-3">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="text-sm font-medium text-grey-15">
                        {new Date(m.scheduledStart).toLocaleString()}
                      </div>
                      {isRebook && (
                        <span
                          title="This candidate had a prior no-show and re-booked via the follow-up invite"
                          className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium"
                        >
                          Rebook
                        </span>
                      )}
                      {m.confirmedAt && (
                        <span
                          title={`Candidate confirmed via SMS on ${new Date(m.confirmedAt).toLocaleString()}`}
                          className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium"
                        >
                          Confirmed
                        </span>
                      )}
                    </div>
                    <a className="text-xs text-primary hover:underline break-all" href={m.meetingUri} target="_blank" rel="noopener noreferrer">
                      {m.meetingUri}
                    </a>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    s.tone === 'green' ? 'bg-green-100 text-green-700' :
                    s.tone === 'blue' ? 'bg-blue-100 text-blue-700' :
                    s.tone === 'amber' ? 'bg-amber-100 text-amber-700' :
                    s.tone === 'red' ? 'bg-red-100 text-red-700' :
                    'bg-gray-100 text-grey-40'
                  }`}>{s.text}</span>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-grey-40">
                  {m.actualStart && <div>Started: {new Date(m.actualStart).toLocaleTimeString()}</div>}
                  {m.actualEnd && <div>Ended: {new Date(m.actualEnd).toLocaleTimeString()}</div>}
                  {m.recordingEnabled && (
                    <div>Recording: <span className="text-grey-15">{m.recordingState}</span></div>
                  )}
                  {m.transcriptState !== 'disabled' && (
                    <div>Transcript: <span className="text-grey-15">{m.transcriptState}</span></div>
                  )}
                </div>

                {m.recordingState === 'ready' && (m.driveRecordingFileId || m.recallRecordingId) && (
                  <div className="mt-2 space-y-3">
                    {/* Primary player: Recall when present, Drive otherwise. */}
                    <div>
                      {m.recallRecordingId && m.driveRecordingFileId && (
                        <div className="text-[10px] uppercase tracking-wide text-grey-40 mb-1">Recall recording</div>
                      )}
                      <video
                        controls
                        className="w-full rounded-[6px] border border-surface-border"
                        src={`/api/interview-meetings/${m.id}/recording`}
                      />
                      <div className="flex items-center gap-3 mt-1">
                        <a href={`/api/interview-meetings/${m.id}/recording?download=1`} className="text-xs text-primary hover:underline">
                          Download recording
                        </a>
                        {m.driveRecordingFileId && (
                          <>
                            <span className="text-grey-40 text-xs">·</span>
                            <a
                              href={`https://drive.google.com/file/d/${m.driveRecordingFileId}/view`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-primary hover:underline"
                            >
                              Open in Drive
                            </a>
                          </>
                        )}
                        <span className="text-grey-40 text-xs">·</span>
                        <button
                          onClick={() => removeRecording(m.id)}
                          disabled={removingRecording === m.id}
                          className="text-xs text-red-600 hover:underline disabled:opacity-50"
                        >
                          {removingRecording === m.id ? 'Removing…' : 'Remove recording'}
                        </button>
                      </div>
                    </div>

                    {/* Parallel test: Meet's native recording, when both exist,
                        so we can verify Drive reliability before retiring the
                        Recall recording path. */}
                    {m.recallRecordingId && m.driveRecordingFileId && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-grey-40 mb-1">Google Meet recording (parallel)</div>
                        <video
                          controls
                          className="w-full rounded-[6px] border border-surface-border"
                          src={`/api/interview-meetings/${m.id}/recording?source=drive`}
                        />
                      </div>
                    )}
                  </div>
                )}
                {(() => {
                  // Additional recordings: every artifact of kind 'recording'
                  // that isn't the primary. Surfaces both reschedule-orphans
                  // (old Meet link recordings) and reopen-orphans (host opened
                  // the same link again later). Recall-hosted artifacts have
                  // a synthetic `recall:<recordingId>` driveFileId; skip the
                  // one that matches the meeting's primary recallRecordingId
                  // (it's already the inline player above) and never link
                  // those to Drive — they don't live there.
                  const primaryRecallTag = m.recallRecordingId ? `recall:${m.recallRecordingId}` : null
                  const extras = (m.artifacts || []).filter((a) =>
                    a.kind === 'recording'
                    && a.driveFileId !== m.driveRecordingFileId
                    && a.driveFileId !== primaryRecallTag
                  )
                  if (extras.length === 0) return null
                  return (
                    <div className="mt-3 rounded-[6px] border border-surface-border bg-grey-95/40 p-2 text-xs space-y-1">
                      <div className="text-grey-40 font-medium">Other recordings ({extras.length})</div>
                      {extras.map((a) => {
                        const fromOldSpace = m.meetSpaceName && a.meetSpaceName && a.meetSpaceName !== m.meetSpaceName
                        const isRecall = a.driveFileId.startsWith('recall:')
                        const href = isRecall
                          ? `/api/interview-meetings/${m.id}/recording`
                          : `https://drive.google.com/file/d/${a.driveFileId}/view`
                        return (
                          <div key={a.id} className="flex items-center gap-2 flex-wrap">
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              {a.fileName || (isRecall ? 'Recall recording' : a.driveFileId.slice(0, 8))}
                            </a>
                            <span className="text-grey-40">
                              {new Date(a.driveCreatedTime).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                            </span>
                            {fromOldSpace && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                                from prior Meet link
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
                {m.transcriptState === 'ready' && m.driveTranscriptFileId && (
                  <div className="mt-1 flex items-center gap-3">
                    <a href={`/api/interview-meetings/${m.id}/transcript`} className="text-xs text-primary hover:underline" target="_blank" rel="noopener noreferrer">
                      View transcript
                    </a>
                    <span className="text-grey-40 text-xs">·</span>
                    <a
                      href={`https://drive.google.com/file/d/${m.driveTranscriptFileId}/view`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      Open in Drive
                    </a>
                  </div>
                )}

                {!m.cancelledAt && new Date(m.scheduledEnd).getTime() >= Date.now() && !m.actualStart && (
                  <div className="mt-3 pt-3 border-t border-surface-border">
                    <div className="flex items-center gap-3 flex-wrap">
                      <button
                        onClick={() => setReschedulingFor(m)}
                        disabled={cancelling === m.id}
                        className="text-xs text-primary hover:underline disabled:opacity-50"
                      >
                        Reschedule
                      </button>
                      <span className="text-grey-40 text-xs">·</span>
                      <button
                        onClick={() => openCancelModal(m.id)}
                        disabled={cancelling === m.id}
                        className="text-xs text-red-600 hover:underline disabled:opacity-50 inline-flex items-center"
                      >
                        {cancelling === m.id ? (<><Spinner />Cancelling…</>) : 'Cancel meeting'}
                      </button>
                    </div>
                  </div>
                )}

                {!m.cancelledAt && new Date(m.scheduledEnd).getTime() < Date.now() && (
                  <div className="mt-3 pt-3 border-t border-surface-border">
                    <button
                      onClick={() => markNoShow(m.id)}
                      disabled={markingNoShow === m.id}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50"
                    >
                      {markingNoShow === m.id ? 'Marking…' : 'Mark as no-show'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {showDialog && (
        <ScheduleInterviewDialog
          candidateId={candidateId}
          candidateEmail={candidateEmail}
          onClose={() => setShowDialog(false)}
          onScheduled={() => { load(); onCandidateChanged?.() }}
        />
      )}

      {reschedulingFor && (
        <RescheduleInterviewDialog
          meeting={reschedulingFor}
          onClose={() => setReschedulingFor(null)}
          onRescheduled={() => { setReschedulingFor(null); load(); onCandidateChanged?.() }}
        />
      )}

      {cancelModal && (
        <CancelMeetingModal
          stages={stages}
          currentPipelineStatus={currentPipelineStatus}
          busy={cancelling === cancelModal.meetingId}
          onClose={() => setCancelModal(null)}
          onConfirm={(targetStageId) => confirmCancel(cancelModal.meetingId, targetStageId)}
        />
      )}
    </div>
  )
}

/**
 * "Where to move the candidate?" modal that opens when the recruiter
 * clicks Cancel meeting. Defaults to "Keep in current stage" — cancelling
 * a meeting (e.g. to reschedule) shouldn't auto-route the candidate
 * anywhere unless the recruiter explicitly asks. The candidate's actual
 * funnel position only changes when the recruiter picks a different
 * stage and confirms.
 */
function CancelMeetingModal({
  stages,
  currentPipelineStatus,
  busy,
  onClose,
  onConfirm,
}: {
  stages: FunnelStage[]
  currentPipelineStatus: string | null
  busy: boolean
  onClose: () => void
  onConfirm: (targetStageId: string | null) => void
}) {
  const currentStage = resolveStage(currentPipelineStatus, stages)
  // null = "keep current stage" (default). A stage id = move there.
  const [choice, setChoice] = useState<string | null>(null)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="w-full max-w-[480px] rounded-[14px] bg-white shadow-xl border border-surface-border">
        <div className="px-6 pt-5 pb-3">
          <h3 className="text-base font-semibold text-ink mb-1">Cancel interview</h3>
          <p className="text-[12px] text-grey-40">
            The Google Calendar event will be deleted (the candidate will be notified by Google) and any queued reminders / follow-ups voided.
          </p>
        </div>
        <div className="px-6 py-3">
          <div className="text-[12px] font-medium text-grey-15 mb-2">Where to move the candidate?</div>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2.5 px-3 py-2 rounded-[8px] border border-surface-border hover:bg-surface-light cursor-pointer">
              <input
                type="radio"
                checked={choice === null}
                onChange={() => setChoice(null)}
                className="accent-brand-500"
              />
              <span className="text-[13px] text-ink">
                Keep in current stage
                <span className="ml-2 text-[11px] text-grey-40">
                  (currently <strong>{currentStage.label}</strong>)
                </span>
              </span>
            </label>
            {stages.map((s) => (
              <label
                key={s.id}
                className="flex items-center gap-2.5 px-3 py-2 rounded-[8px] border border-surface-border hover:bg-surface-light cursor-pointer"
              >
                <input
                  type="radio"
                  checked={choice === s.id}
                  onChange={() => setChoice(s.id)}
                  className="accent-brand-500"
                />
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
                <span className="text-[13px] text-ink">{s.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="px-6 py-4 flex justify-end gap-2 border-t border-surface-divider">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-sm px-4 py-2 rounded-[8px] text-grey-40 hover:text-grey-15 disabled:opacity-50"
          >
            Back
          </button>
          <button
            onClick={() => onConfirm(choice)}
            disabled={busy}
            className="text-sm px-4 py-2 rounded-[8px] bg-red-600 text-white hover:bg-red-700 font-medium disabled:opacity-50"
          >
            {busy ? 'Cancelling…' : 'Cancel meeting'}
          </button>
        </div>
      </div>
    </div>
  )
}

function RescheduleInterviewDialog({
  meeting,
  onClose,
  onRescheduled,
}: {
  meeting: InterviewMeeting
  onClose: () => void
  onRescheduled: () => void
}) {
  const initialStart = new Date(meeting.scheduledStart)
  const initialDurationMinutes = Math.max(
    10,
    Math.round((new Date(meeting.scheduledEnd).getTime() - initialStart.getTime()) / 60_000),
  )
  const pad = (n: number) => n.toString().padStart(2, '0')
  const toLocalInput = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

  const [scheduledAt, setScheduledAt] = useState(toLocalInput(initialStart))
  const [durationMinutes, setDurationMinutes] = useState(initialDurationMinutes)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setSubmitting(true); setError(null)
    try {
      const res = await fetch(`/api/interview-meetings/${meeting.id}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduledAt: new Date(scheduledAt).toISOString(),
          durationMinutes,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body?.message || body?.error || 'Failed to reschedule')
        return
      }
      onRescheduled()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-[12px] p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-grey-15">Reschedule interview</h3>
        <p className="text-sm text-grey-40 mt-0.5">The candidate will receive an updated calendar invite at the new time.</p>

        <div className="mt-4 space-y-3 text-sm">
          <label className="block">
            <span className="text-grey-40">Date &amp; time</span>
            <input
              type="datetime-local"
              className="mt-1 w-full border border-surface-border rounded-[8px] px-3 py-2"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-grey-40">Duration (minutes)</span>
            <input
              type="number"
              min={10}
              max={240}
              className="mt-1 w-full border border-surface-border rounded-[8px] px-3 py-2"
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
            />
          </label>
        </div>

        {error && <div className="mt-3 p-2 rounded-[8px] bg-red-50 text-xs text-red-700">{error}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary text-sm" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn-primary text-sm" onClick={submit} disabled={submitting}>
            {submitting ? 'Rescheduling…' : 'Reschedule interview'}
          </button>
        </div>
      </div>
    </div>
  )
}
