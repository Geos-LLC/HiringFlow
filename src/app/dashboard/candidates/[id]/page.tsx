'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  DEFAULT_FUNNEL_STAGES,
  type FunnelStage,
  normalizeStages,
  resolveStage,
} from '@/lib/funnel-stages'
import {
  STATUS_DISPLAY,
  DISPOSITION_DISPLAY,
  DEFAULT_TIMEOUTS,
  normalizeCustomStatuses,
  type CandidateStatus,
  type CandidateDispositionReason,
  type CustomStatus,
} from '@/lib/candidate-status'
import { Badge } from '@/components/design'
import { InterviewPanel } from './_InterviewPanel'
import { NotesPanel } from './_NotesPanel'
import { CurrentActivityCard } from './_CurrentActivityCard'
import { BackgroundCheckCard } from './_BackgroundCheckCard'
import { CapturesPanel } from './_CapturesPanel'
import CapturePlayback from '@/components/CapturePlayback'
import { AICallsPanel } from './_AICallsPanel'
import { DispositionReasonPicker } from '../_DispositionReasonPicker'
import { SendMessageModal } from '../_SendMessageModal'
import AutomationPreviewModal from '@/components/AutomationPreviewModal'

interface CaptureSummary {
  id: string
  stepId: string
  mode: string
  prompt: string | null
  status: string
  mimeType: string | null
  fileSizeBytes: number | null
  durationSec: number | null
  transcript: string | null
  aiSummary: string | null
  aiScore: number | null
  errorMessage: string | null
  captureOrdinal: number
  // Server-side signed playback URL (5 min TTL). Lets the audio/video
  // element render inline without a "Load playback" click — same UX as
  // legacy video submissions and inline meeting links.
  playbackUrl: string | null
  playbackExpiresAt: string | null
  shareToken?: string | null
  createdAt: string
  updatedAt: string
}

interface Answer {
  id: string; answeredAt: string
  step: { id: string; title: string; questionText: string | null; stepType: string; questionType: string }
  option: { id: string; optionText: string } | null
}
interface Submission {
  id: string; submittedAt: string; videoStorageKey: string | null; videoFilename: string | null; textMessage: string | null
  step: { id: string; title: string; questionText: string | null }
}
interface TrainingSection {
  id: string; title: string; sortOrder: number; kind: string
  contents?: { id: string; type: string }[]
}
interface TrainingEnrollment {
  id: string; status: string; startedAt: string; completedAt: string | null
  progress: {
    completedSections?: string[]
    quizScores?: { sectionId: string; score: number }[]
    sectionTimestamps?: Record<string, string>
    currentLesson?: { sectionId: string; lessonIdx: number; at: string }
  } | null
  training: { id: string; title: string; sections?: TrainingSection[] }
}
interface SchedulingEvent { id: string; eventType: string; eventAt: string; metadata: Record<string, any> | null }
interface AutomationExec {
  id: string; status: string; errorMessage: string | null; skipReason: string | null; sentAt: string | null; scheduledFor: string | null; createdAt: string
  channel: string
  deliveryStatus: string | null
  deliveryStatusAt: string | null
  deliveryErrorMessage: string | null
  automationRule: {
    id: string; name: string; triggerType: string
    chainedBy: { id: string; name: string; steps: { delayMinutes: number }[] }[]
  }
  step: {
    id: string; order: number; channel: string; delayMinutes: number
    timingMode: string | null
    nextStepType: string | null
    emailDestination: string; emailDestinationAddress: string | null
    training: { title: string; slug: string } | null
    schedulingConfig: { name: string; schedulingUrl: string } | null
    emailTemplate: { name: string; subject: string } | null
  } | null
}
interface SiblingSession {
  id: string
  startedAt: string
  finishedAt: string | null
  pipelineStatus: string | null
  status: string
  dispositionReason: string | null
  rejectionReason: string | null
  flowName: string | null
  hadNoShow: boolean
}
interface CandidateDetail {
  id: string; candidateName: string | null; candidateEmail: string | null; candidatePhone: string | null
  formData: Record<string, string> | null; outcome: string | null; pipelineStatus: string | null
  startedAt: string; finishedAt: string | null
  // `lastActivityAt` is the raw heartbeat column. `effectiveLastActivityAt`
  // is the server-computed max across that column + every event timestamp
  // (meeting actualStart/End, scheduling events, training section stamps,
  // answers, submissions). Always prefer the effective value for the UI —
  // existing candidates predate the heartbeat column.
  lastActivityAt: string | null
  effectiveLastActivityAt: string | null
  // Status axis (added 2026-05-06). status is always set (default 'active').
  // dispositionReason / *At fields are nullable.
  status: CandidateStatus | null
  dispositionReason: CandidateDispositionReason | null
  stalledAt: string | null; lostAt: string | null; hiredAt: string | null
  source: string | null; campaign: string | null; addedManually: boolean
  rejectionReason: string | null; rejectionReasonAt: string | null
  interestingAt: string | null
  flow: {
    id: string; name: string; slug: string
    videoInterviewTimeoutDays?: number | null
    trainingTimeoutDays?: number | null
    noShowTimeoutHours?: number | null
    schedulingTimeoutHours?: number | null
    backgroundCheckTimeoutDays?: number | null
  } | null
  // Pipeline whose stages this candidate's funnel is rendered against.
  // Resolved server-side from the flow's pipelineId (or workspace default).
  // The detail page reads from here instead of workspace.settings.funnelStages
  // so a Dispatcher candidate gets Dispatcher columns regardless of which
  // pipeline the recruiter has open on the kanban.
  pipeline?: {
    id: string
    name: string
    isDefault: boolean
    stages: FunnelStage[]
  } | null
  lastStep: { id: string; title: string; stepOrder: number; stepType: string; questionType: string } | null
  flowStepCount: number
  ad: { id: string; name: string; source: string } | null
  answers: Answer[]; submissions: Submission[]
  trainingEnrollments: TrainingEnrollment[]; schedulingEvents: SchedulingEvent[]
  automationExecutions?: AutomationExec[]
  interviewMeetings?: { id: string; actualStart: string | null; actualEnd: string | null; scheduledStart: string; scheduledEnd: string; meetingUri: string | null; confirmedAt: string | null; createdAt: string }[]
  backgroundChecks?: { id: string; status: string; overallScore: string | null; createdAt: string }[]
  formFieldLabels?: Record<string, string>
  isRebook?: boolean
  siblingSessions?: SiblingSession[]
  // Per-training access status computed server-side from TrainingAccessToken
  // rows. Drives the "Access revoked" badge + Revoke/Restore toggle on the
  // Current Activity card.
  trainingAccessStatus?: Record<string, 'active' | 'revoked' | 'none'>
  // Hiring Process this candidate was attached to at flow-entry time.
  // Null for sessions created before the HiringProcess feature shipped, or
  // for flows that don't have an active process pointing at them.
  process?: {
    id: string
    name: string
    status: 'draft' | 'active' | 'archived'
    flow: { id: string; name: string } | null
    training: { id: string; title: string } | null
    schedulingConfig: { id: string; name: string } | null
    pipeline: { id: string; name: string } | null
  } | null
}

const REJECTION_PRESETS = ['No-show', 'Not qualified', 'Wrong schedule', 'Declined offer', 'Wrong location', 'Pay expectations']

function normalizeCustomReasons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set(REJECTION_PRESETS.map((p) => p.toLowerCase()))
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const t = v.trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

export default function CandidateDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [candidate, setCandidate] = useState<CandidateDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'answers' | 'submissions' | 'captures' | 'timeline'>('answers')
  const [captures, setCaptures] = useState<CaptureSummary[] | null>(null)
  const [capturesLoading, setCapturesLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [stages, setStages] = useState<FunnelStage[]>(DEFAULT_FUNNEL_STAGES)
  const [customReasons, setCustomReasons] = useState<string[]>([])
  const [customStatuses, setCustomStatuses] = useState<CustomStatus[]>([])
  const [runningAutomations, setRunningAutomations] = useState(false)
  const [automationToast, setAutomationToast] = useState<string | null>(null)
  const [sendingReminder, setSendingReminder] = useState(false)
  const [reminderToast, setReminderToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // Set when the user clicks "Run automations". Holds every workspace rule
  // applicable to this candidate (flow + pipeline scope) — the recruiter
  // picks which one to run. `matchesStage` lets us group the rules that are
  // wired to the candidate's current stage first, with the rest below.
  // null when the modal is closed.
  const [previewState, setPreviewState] = useState<null | {
    loading: boolean
    rules: Array<{ id: string; name: string; triggerType: string; matchesStage?: boolean }>
    error?: string
  }>(null)
  // Per-rule status for the "Run" button on each row. Lets the recruiter fire
  // one rule at a time without dismissing the modal — keyed by ruleId.
  const [perRuleState, setPerRuleState] = useState<Record<string, { firing: boolean; result?: { ok: boolean; message: string } }>>({})
  // "View" opens the automation preview modal inline instead of navigating
  // to /dashboard/automations?rule=<id> — keeps the recruiter on the
  // candidate detail so they can flip between context and preview.
  const [viewingRule, setViewingRule] = useState<{ id: string; name: string } | null>(null)

  // Load captures eagerly on mount so the top-level CapturesPanel can render
  // alongside InterviewPanel without waiting for a tab click. Same fetch
  // powers the Captures tab too — shared state, single network call.
  // Tight payload: list endpoint already returns one row per step (latest
  // active take) plus a 5-min signed playbackUrl per row.
  useEffect(() => {
    if (!id) return
    let cancelled = false
    setCapturesLoading(true)
    fetch(`/api/captures/session/${id}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (!cancelled) setCaptures(Array.isArray(data?.captures) ? data.captures : [])
      })
      .catch(() => {
        if (!cancelled) setCaptures([])
      })
      .finally(() => {
        if (!cancelled) setCapturesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const loadCandidate = useCallback(async () => {
    const res = await fetch(`/api/candidates/${id}`)
    // Hard non-OK guard: previously, a 404 / 500 response would still parse
    // its `{ error: '...' }` body into `candidate`, which is truthy, slipping
    // past `if (!candidate)` and crashing on `candidate.schedulingEvents.find`.
    // Surfaces e.g. when a recruiter opens a URL for a session owned by a
    // different workspace than their current login.
    if (!res.ok) {
      setCandidate(null)
      setLoading(false)
      return
    }
    const d = await res.json()
    setCandidate(d)
    // The detail page renders against this candidate's pipeline (resolved
    // server-side from the flow's pipelineId or workspace default). Falling
    // back to whatever the workspace settings drawer most recently saved
    // would render the wrong columns for a Dispatcher candidate viewed from
    // a Cleaner-pipeline kanban context.
    if (Array.isArray(d?.pipeline?.stages) && d.pipeline.stages.length > 0) {
      setStages(normalizeStages(d.pipeline.stages))
    }
    setLoading(false)
  }, [id])

  useEffect(() => {
    loadCandidate().catch(() => setLoading(false))
  }, [loadCandidate])

  useEffect(() => {
    fetch('/api/workspace/settings')
      .then((r) => r.json())
      .then((d) => {
        const settings = (d?.settings as { customRejectionReasons?: unknown; customStatuses?: unknown } | null) ?? null
        setCustomReasons(normalizeCustomReasons(settings?.customRejectionReasons))
        setCustomStatuses(normalizeCustomStatuses(settings?.customStatuses))
      })
      .catch(() => {})
  }, [])


  const updateStatus = async (pipelineStatus: string) => {
    await fetch(`/api/candidates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineStatus }),
    })
    setCandidate(prev => prev ? { ...prev, pipelineStatus } : null)
  }

  // Lifecycle action — covers Reactivate / Move to Lost / Move to Nurture /
  // Mark as Hired / Change Reason. Backend's statusTransitionPatch handles
  // the *At stamps and clearing on reactivate; we just optimistic-merge the
  // returned row so the panel reflects the new state immediately.
  const [statusBusy, setStatusBusy] = useState(false)
  // `next` is widened to string so the same helper handles built-in statuses
  // and workspace-defined custom statuses (cust_*). The backend validates.
  const updateLifecycle = async (next: CandidateStatus | string, reason?: CandidateDispositionReason | null) => {
    if (statusBusy) return
    setStatusBusy(true)
    try {
      const body: Record<string, unknown> = { status: next }
      if (reason !== undefined) body.dispositionReason = reason
      const res = await fetch(`/api/candidates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        alert(j?.error || 'Failed to update status')
        return
      }
      const data = await res.json()
      setCandidate((prev) => prev ? {
        ...prev,
        status: data.status ?? prev.status,
        dispositionReason: data.dispositionReason ?? null,
        stalledAt: data.stalledAt ?? null,
        lostAt: data.lostAt ?? null,
        hiredAt: data.hiredAt ?? null,
      } : null)
    } finally {
      setStatusBusy(false)
    }
  }

  // Disposition reason picker modal state. Used by both "Move to Lost" /
  // "Move to Nurture" (which require a reason) and "Change Reason"
  // (no status change, just patch the dispositionReason).
  const [reasonModal, setReasonModal] = useState<null | {
    mode: 'set-status' | 'change-reason'
    targetStatus?: CandidateStatus
    initial?: CandidateDispositionReason | null
  }>(null)
  const openLostPicker = () => setReasonModal({ mode: 'set-status', targetStatus: 'lost', initial: 'manual_other' })
  const openNurturePicker = () => setReasonModal({ mode: 'set-status', targetStatus: 'nurture', initial: candidate?.dispositionReason ?? null })
  const openChangeReason = () => setReasonModal({ mode: 'change-reason', initial: candidate?.dispositionReason ?? null })
  const submitReasonModal = async (chosen: CandidateDispositionReason | null) => {
    const m = reasonModal
    if (!m) return
    if (m.mode === 'set-status' && m.targetStatus) {
      await updateLifecycle(m.targetStatus, chosen)
    } else if (m.mode === 'change-reason') {
      // Patch dispositionReason without changing status. PATCH handles this
      // via the standalone-dispositionReason path.
      const res = await fetch(`/api/candidates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dispositionReason: chosen }),
      })
      if (res.ok) {
        const data = await res.json()
        setCandidate((prev) => prev ? { ...prev, dispositionReason: data.dispositionReason ?? null } : null)
      }
    }
    setReasonModal(null)
  }

  const updateOutcome = async (outcome: string) => {
    await fetch(`/api/candidates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome, pipelineStatus: outcome === 'passed' ? 'passed' : outcome === 'failed' ? 'failed' : undefined }),
    })
    setCandidate(prev => prev ? { ...prev, outcome, ...(outcome === 'passed' ? { pipelineStatus: 'passed' } : outcome === 'failed' ? { pipelineStatus: 'failed' } : {}) } : null)
  }

  // Revoke / restore training access for a candidate. Public training routes
  // only honor 'active'|'used' tokens — once flipped to 'revoked' the
  // candidate's existing link returns TOKEN_INVALID, and restore puts each
  // token back to its prior used/active state. Past progress and completion
  // events stay on the timeline either way.
  const [pendingTrainingId, setPendingTrainingId] = useState<string | null>(null)
  const revokeTrainingAccess = async (trainingId: string, trainingTitle: string) => {
    if (pendingTrainingId) return
    if (!confirm(`Revoke ${trainingTitle} access for this candidate? Their existing training link will stop working. Past progress will remain visible.`)) return
    setPendingTrainingId(trainingId)
    try {
      const res = await fetch(`/api/candidates/${id}/trainings/${trainingId}/revoke`, { method: 'POST' })
      const data = await res.json().catch(() => ({} as { revokedCount?: number; accessMode?: string; error?: string }))
      if (!res.ok) {
        alert(data?.error || 'Failed to revoke training access')
        return
      }
      const count = typeof data?.revokedCount === 'number' ? data.revokedCount : 0
      if (count === 0) {
        if (data?.accessMode === 'public') {
          alert(`No links to revoke — "${trainingTitle}" is set to public access, so anyone with the URL can view it regardless of tokens.`)
        } else {
          alert(`No active links found for "${trainingTitle}".`)
        }
      }
      await loadCandidate()
    } finally {
      setPendingTrainingId(null)
    }
  }
  const restoreTrainingAccess = async (trainingId: string, trainingTitle: string) => {
    if (pendingTrainingId) return
    setPendingTrainingId(trainingId)
    try {
      const res = await fetch(`/api/candidates/${id}/trainings/${trainingId}/restore`, { method: 'POST' })
      const data = await res.json().catch(() => ({} as { restoredCount?: number; error?: string }))
      if (!res.ok) {
        alert(data?.error || 'Failed to restore training access')
        return
      }
      const count = typeof data?.restoredCount === 'number' ? data.restoredCount : 0
      if (count === 0) {
        alert(`No revoked links found for "${trainingTitle}" to restore.`)
      }
      await loadCandidate()
    } finally {
      setPendingTrainingId(null)
    }
  }

  const deleteCandidate = async () => {
    if (!candidate) return
    const name = candidate.candidateName || candidate.candidateEmail || 'this candidate'
    if (!confirm(`Delete ${name}? This permanently removes their answers, video submissions, training progress, and scheduled interviews. This cannot be undone.`)) return
    setDeleting(true)
    const res = await fetch(`/api/candidates/${id}`, { method: 'DELETE' })
    if (res.ok) {
      router.push('/dashboard/candidates')
    } else {
      setDeleting(false)
      alert('Failed to delete candidate')
    }
  }

  // Profile editor — name / email / phone / flow. Opened from the pencil
  // button next to the candidate name in the header. Flow change wipes the
  // candidate's progress on the previous flow (lastStepId is cleared
  // server-side); answers + submissions stay attached to their original
  // step rows so the timeline still renders.
  const [showProfileEditor, setShowProfileEditor] = useState(false)
  const [profileDraft, setProfileDraft] = useState({
    candidateName: '',
    candidateEmail: '',
    candidatePhone: '',
    flowId: '',
  })
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [flowsForPicker, setFlowsForPicker] = useState<Array<{ id: string; name: string }>>([])
  const openProfileEditor = () => {
    if (!candidate) return
    setProfileDraft({
      candidateName: candidate.candidateName ?? '',
      candidateEmail: candidate.candidateEmail ?? '',
      candidatePhone: candidate.candidatePhone ?? '',
      flowId: candidate.flow?.id ?? '',
    })
    setProfileError(null)
    setShowProfileEditor(true)
    // Lazy-load the workspace's flows the first time the modal opens.
    if (flowsForPicker.length === 0) {
      fetch('/api/flows')
        .then((r) => r.json())
        .then((rows: Array<{ id: string; name: string }>) => {
          setFlowsForPicker(rows.map((r) => ({ id: r.id, name: r.name })))
        })
        .catch(() => {})
    }
  }
  const saveProfile = async () => {
    if (!candidate) return
    setSavingProfile(true)
    setProfileError(null)
    try {
      const flowChanged = profileDraft.flowId && profileDraft.flowId !== candidate.flow?.id
      const res = await fetch(`/api/candidates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateName: profileDraft.candidateName,
          candidateEmail: profileDraft.candidateEmail,
          candidatePhone: profileDraft.candidatePhone,
          flowId: profileDraft.flowId || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setProfileError(data?.error || 'Failed to save')
        return
      }
      setShowProfileEditor(false)
      // Flow change rewires lastStep / flowStepCount / sibling list, so go
      // back to the source rather than try to merge the diff client-side.
      if (flowChanged) {
        await loadCandidate()
      } else {
        setCandidate((prev) => prev ? {
          ...prev,
          candidateName: data.candidateName ?? null,
          candidateEmail: data.candidateEmail ?? null,
          candidatePhone: data.candidatePhone ?? null,
        } : null)
      }
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingProfile(false)
    }
  }

  // Recruiter shortlist toggle — star/un-star. PATCH writes `interestingAt`
  // and we optimistic-merge the result so the icon flips immediately.
  const [interestingBusy, setInterestingBusy] = useState(false)
  const toggleInteresting = async () => {
    if (!candidate || interestingBusy) return
    const next = !candidate.interestingAt
    setInterestingBusy(true)
    setCandidate((prev) => prev ? { ...prev, interestingAt: next ? new Date().toISOString() : null } : null)
    try {
      const res = await fetch(`/api/candidates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interesting: next }),
      })
      if (!res.ok) {
        // Roll back optimistic update on failure
        setCandidate((prev) => prev ? { ...prev, interestingAt: next ? null : (prev.interestingAt ?? null) } : null)
        return
      }
      const data = await res.json()
      setCandidate((prev) => prev ? { ...prev, interestingAt: data.interestingAt ?? null } : null)
    } finally {
      setInterestingBusy(false)
    }
  }

  const [showReasonEditor, setShowReasonEditor] = useState(false)
  const [reasonDraft, setReasonDraft] = useState('')
  const openReasonEditor = () => {
    setReasonDraft(candidate?.rejectionReason ?? '')
    setShowReasonEditor(true)
  }

  // Manual rejection email — opens the shared SendMessageModal with AI
  // auto-generation primed off the candidate's rejection reason. The modal
  // handles compose / template-load / save-as-new / send for both email
  // and SMS, so this page only owns the toggle.
  const [showSendMessage, setShowSendMessage] = useState<{ autoGenerate: boolean } | null>(null)
  const persistCustomReasons = async (next: string[]) => {
    setCustomReasons(next)
    try {
      const getRes = await fetch('/api/workspace/settings', { credentials: 'same-origin' })
      const current = getRes.ok ? (await getRes.json())?.settings : null
      const merged = { ...(current && typeof current === 'object' ? current : {}), customRejectionReasons: next }
      await fetch('/api/workspace/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ settings: merged }),
      })
    } catch { /* non-blocking; the candidate save already succeeded */ }
  }
  const saveReason = async (next: string) => {
    const trimmed = next.trim()
    const res = await fetch(`/api/candidates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rejectionReason: trimmed }),
    })
    if (res.ok) {
      const data = await res.json()
      setCandidate(prev => prev ? { ...prev, rejectionReason: data.rejectionReason ?? null, rejectionReasonAt: data.rejectionReasonAt ?? null } : null)
      setShowReasonEditor(false)
      // If this is a brand-new reason (not a default and not already saved), append it
      // to the workspace's reusable list so it shows up as a quick-pick next time.
      if (trimmed) {
        const lc = trimmed.toLowerCase()
        const isDefault = REJECTION_PRESETS.some((p) => p.toLowerCase() === lc)
        const isKnown = customReasons.some((p) => p.toLowerCase() === lc)
        if (!isDefault && !isKnown) {
          await persistCustomReasons([...customReasons, trimmed])
        }
      }
    }
  }
  const removeCustomReason = (reason: string) => {
    const next = customReasons.filter((r) => r !== reason)
    persistCustomReasons(next)
  }
  const clearReason = () => saveReason('')

  const [showLogMeeting, setShowLogMeeting] = useState(false)
  const [meetingAt, setMeetingAt] = useState('')
  const [meetingUrl, setMeetingUrl] = useState('')
  const [meetingNotes, setMeetingNotes] = useState('')
  const [savingMeeting, setSavingMeeting] = useState(false)
  const [copiedMeeting, setCopiedMeeting] = useState(false)
  const [startingInstantFromCard, setStartingInstantFromCard] = useState(false)

  const copyMeetingLink = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedMeeting(true)
      setTimeout(() => setCopiedMeeting(false), 1500)
    } catch {
      window.prompt('Copy this link:', url)
    }
  }, [])

  const startInstantInterviewFromCard = useCallback(async () => {
    if (!confirm('Start an instant interview now? This creates a fresh Meet link and sends the recording bot to join immediately. The link will appear in this Meeting card so you can copy and send it.')) return
    setStartingInstantFromCard(true)
    try {
      const res = await fetch(`/api/candidates/${id}/start-instant-interview`, {
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
        try { await navigator.clipboard.writeText(uri) } catch { /* ignore */ }
        window.open(uri, '_blank', 'noopener')
        setCopiedMeeting(true)
        setTimeout(() => setCopiedMeeting(false), 2500)
      }
      await loadCandidate()
    } finally {
      setStartingInstantFromCard(false)
    }
  }, [id, loadCandidate])

  const sendMeetingReminder = async () => {
    if (sendingReminder) return
    if (!confirm('Send the "we\'re waiting for you" nudge to this candidate now? Email goes out immediately, plus SMS if a phone number is on file.')) return
    setSendingReminder(true)
    setReminderToast(null)
    try {
      const res = await fetch(`/api/candidates/${id}/send-meeting-reminder`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setReminderToast({ kind: 'err', text: data?.error || 'Failed to send reminder' })
        return
      }
      const emailOk = data?.email?.success
      const smsOk = data?.sms?.success
      const channels: string[] = []
      if (emailOk) channels.push('email')
      if (smsOk) channels.push('SMS')
      const failures: string[] = []
      if (data?.email && !emailOk) failures.push(`email (${data.email.error || 'failed'})`)
      if (data?.sms && !smsOk) failures.push(`SMS (${data.sms.error || 'failed'})`)
      if (channels.length > 0 && failures.length === 0) {
        setReminderToast({ kind: 'ok', text: `Sent ${channels.join(' and ')} nudge.` })
      } else if (channels.length > 0 && failures.length > 0) {
        setReminderToast({ kind: 'err', text: `Sent ${channels.join(' and ')}, but ${failures.join(', ')} failed.` })
      } else {
        setReminderToast({ kind: 'err', text: failures.length ? `Failed: ${failures.join(', ')}` : 'Nothing was sent.' })
      }
      fetch(`/api/candidates/${id}`).then((r) => r.json()).then(setCandidate).catch(() => {})
    } catch (err) {
      setReminderToast({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to send reminder' })
    } finally {
      setSendingReminder(false)
      setTimeout(() => setReminderToast(null), 6000)
    }
  }

  const logMeeting = async () => {
    if (!meetingAt) return
    setSavingMeeting(true)
    const res = await fetch(`/api/candidates/${id}/schedule-meeting`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduledAt: new Date(meetingAt).toISOString(),
        meetingUrl: meetingUrl || undefined,
        notes: meetingNotes || undefined,
      }),
    })
    setSavingMeeting(false)
    if (res.ok) {
      setShowLogMeeting(false)
      setMeetingAt(''); setMeetingUrl(''); setMeetingNotes('')
      // Refresh candidate data
      fetch(`/api/candidates/${id}`).then(r => r.json()).then(d => setCandidate(d))
    } else {
      alert('Failed to log meeting')
    }
  }

  if (loading) return <div className="text-center py-12 text-grey-40">Loading...</div>
  if (!candidate) return <div className="text-center py-12 text-grey-40">Candidate not found</div>

  const activeStage = resolveStage(candidate.pipelineStatus, stages)

  // Open the picker modal — fetch every workspace rule applicable to this
  // candidate. stageId is passed so the server can flag each rule with
  // matchesStage; we render the stage-attached rules first and the rest as
  // "Other automations" below.
  const openPreview = async () => {
    if (runningAutomations) return
    setPerRuleState({})
    setPreviewState({ loading: true, rules: [] })
    try {
      const res = await fetch(`/api/candidates/${id}/run-stage-automations?stageId=${encodeURIComponent(activeStage.id)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Failed to load automations')
      setPreviewState({ loading: false, rules: data.rules ?? [] })
    } catch (err) {
      setPreviewState({
        loading: false,
        rules: [],
        error: err instanceof Error ? err.message : 'Failed to load automations',
      })
    }
  }

  // Fire a single rule from the picker. Keeps the modal open and shows
  // per-row status so the recruiter can fire each rule individually — the
  // previous bulk "Fire all" path was removed because it surprised users when
  // re-running surfaced a "Fire 4 now" button on an already-fired set.
  // We POST just ruleId (no stageId) so the server validates eligibility by
  // workspace + flow + pipeline scope instead of gating on stage membership.
  const runSingleRule = async (ruleId: string) => {
    if (perRuleState[ruleId]?.firing) return
    setPerRuleState((s) => ({ ...s, [ruleId]: { firing: true } }))
    try {
      const res = await fetch(`/api/candidates/${id}/run-stage-automations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Failed to fire automation')
      const failed = (data.results || []).filter((r: { ok: boolean }) => !r.ok)
      if (failed.length > 0) {
        setPerRuleState((s) => ({ ...s, [ruleId]: { firing: false, result: { ok: false, message: failed[0]?.error || 'Failed' } } }))
      } else {
        setPerRuleState((s) => ({ ...s, [ruleId]: { firing: false, result: { ok: true, message: 'Fired' } } }))
        fetch(`/api/candidates/${id}`).then((r) => r.json()).then(setCandidate).catch(() => {})
      }
    } catch (err) {
      setPerRuleState((s) => ({ ...s, [ruleId]: { firing: false, result: { ok: false, message: err instanceof Error ? err.message : 'Failed' } } }))
    }
  }

  const triggerLabels: Record<string, string> = {
    flow_passed:        'Flow passed',
    flow_completed:     'Flow completed',
    training_started:   'Training started',
    training_completed: 'Training completed',
    meeting_scheduled:  'Interview scheduled',
    meeting_started:    'Interview started',
    meeting_ended:      'Interview ended',
    meeting_no_show:    'Interview no-show',
    before_meeting:     'Before meeting',
    automation_completed: 'After automation',
  }

  // Most recent scheduling event with a meeting URL (schedulingEvents is
  // returned newest-first by the API). Used for the "Meeting" info card.
  const latestMeeting = candidate.schedulingEvents.find(e => {
    const url = (e.metadata as Record<string, unknown> | null)?.meetingUrl
    return typeof url === 'string' && url.length > 0
  })
  const latestMeetingUrl = latestMeeting ? String((latestMeeting.metadata as Record<string, any>).meetingUrl) : null
  const latestMeetingAt = latestMeeting ? String((latestMeeting.metadata as Record<string, any>).scheduledAt || latestMeeting.eventAt) : null

  // Build timeline events
  type DeliveryBadge = {
    status: 'processed' | 'delivered' | 'deferred' | 'bounce' | 'dropped' | 'blocked' | 'pending'
    at: string | null
    error: string | null
  }
  const timeline: { label: string; time: string; type: string; detail?: string; delivery?: DeliveryBadge }[] = []
  timeline.push({ label: 'Applied / Flow started', time: candidate.startedAt, type: 'start' })
  if (candidate.finishedAt) timeline.push({ label: `Flow ${candidate.outcome || 'completed'}`, time: candidate.finishedAt, type: candidate.outcome === 'passed' ? 'success' : candidate.outcome === 'failed' ? 'error' : 'info' })
  // Stale-detection event — derived from Session.stalledAt so the cron itself
  // doesn't need to write a separate event row. Idempotent for free: one
  // stalledAt column = one timeline entry. Label is deliberately threshold-
  // agnostic because the workspace setting could have changed since the
  // stale flip; the disposition reason carries the structured "why".
  if (candidate.stalledAt) {
    const reasonLabel = candidate.dispositionReason
      ? (DISPOSITION_DISPLAY[candidate.dispositionReason] || candidate.dispositionReason)
      : null
    timeline.push({
      label: 'Candidate became stale — no forward progress',
      detail: reasonLabel ? `Reason: ${reasonLabel}` : undefined,
      time: candidate.stalledAt,
      type: 'error',
    })
  }
  candidate.trainingEnrollments.forEach(e => {
    timeline.push({ label: `Training started: ${e.training.title}`, time: e.startedAt, type: 'info' })
    // Per-section completion events — only enrollments saved after the
    // sectionTimestamps shape was introduced will have these. Older
    // enrollments fall through silently.
    const stamps = e.progress?.sectionTimestamps || {}
    const sections = e.training.sections || []
    const sectionById = new Map(sections.map((s) => [s.id, s] as const))
    for (const [sectionId, at] of Object.entries(stamps)) {
      const section = sectionById.get(sectionId)
      if (!section) continue
      timeline.push({
        label: `Training section completed: ${section.title}`,
        detail: e.training.title,
        time: at,
        type: 'info',
      })
    }
    if (e.completedAt) timeline.push({ label: `Training completed: ${e.training.title}`, time: e.completedAt, type: 'success' })
  })
  candidate.schedulingEvents.forEach(e => {
    const labels: Record<string, string> = {
      invite_sent: 'Scheduling invite sent',
      link_clicked: 'Scheduling link clicked',
      marked_scheduled: 'Marked as scheduled',
      meeting_scheduled: 'Meeting scheduled',
      meeting_rescheduled: 'Meeting rescheduled',
      meeting_cancelled: 'Meeting cancelled',
      meeting_confirmed: 'Candidate confirmed via SMS',
      meeting_no_show: 'Candidate no-show',
      nudge_sent: 'Manual "join now" nudge sent',
      message_sent: 'Message sent',
    }
    const successTypes = new Set(['marked_scheduled', 'meeting_scheduled', 'meeting_rescheduled', 'meeting_confirmed', 'nudge_sent', 'message_sent'])
    const errorTypes = new Set(['meeting_cancelled', 'meeting_no_show'])
    const type = errorTypes.has(e.eventType) ? 'error' : successTypes.has(e.eventType) ? 'success' : 'info'
    const meta = e.metadata || {}
    const bits: string[] = []
    if (meta.scheduledAt) bits.push(`When: ${new Date(meta.scheduledAt).toLocaleString()}`)
    if (meta.meetingUrl) bits.push(`Link: ${meta.meetingUrl}`)
    if (meta.notes) bits.push(`Notes: ${meta.notes}`)
    if (e.eventType === 'nudge_sent') {
      const channels: string[] = []
      if (meta.emailOk) channels.push('email')
      if (meta.smsOk) channels.push('SMS')
      if (channels.length > 0) bits.push(`Channels: ${channels.join(' + ')}`)
    }
    timeline.push({ label: labels[e.eventType] || e.eventType, time: e.eventAt, type, detail: bits.join(' · ') || undefined })
  })
  ;(candidate.automationExecutions || []).forEach(e => {
    const r = e.automationRule
    const s = e.step
    const destLabel = s?.emailDestination === 'company' ? 'Company'
      : s?.emailDestination === 'specific' ? (s?.emailDestinationAddress || 'Specific')
      : 'Applicant'
    const chainSummary = (c: { name: string; steps: { delayMinutes: number }[] }) => {
      const firstDelay = c.steps[0]?.delayMinutes ?? 0
      return c.name + (firstDelay ? ` (+${firstDelay}m)` : '')
    }
    const nextStep = s?.nextStepType === 'training' && s?.training ? `Training — ${s.training.title}`
      : s?.nextStepType === 'scheduling' && s?.schedulingConfig ? `Scheduling — ${s.schedulingConfig.name}`
      : r.chainedBy.length > 0 ? `Chains to → ${r.chainedBy.map(chainSummary).join(', ')}`
      : s?.nextStepType === 'email' ? 'Send email only'
      : 'No follow-up'
    const stepDelay = s?.delayMinutes ?? 0
    const delayStr = stepDelay > 0
      ? (stepDelay >= 1440 ? `${Math.round(stepDelay / 1440)}d` : stepDelay >= 60 ? `${Math.round(stepDelay / 60)}h` : `${stepDelay}m`)
      : null
    const sentChannel = e.channel || s?.channel || 'email'
    const channelLabel = sentChannel === 'sms' ? 'SMS' : 'Email'
    const bits = [
      `Channel: ${channelLabel}`,
      sentChannel === 'email' ? `To: ${destLabel}` : null,
      sentChannel === 'email' && s?.emailTemplate ? `Template: ${s.emailTemplate.name}` : null,
      `Next step: ${nextStep}`,
      delayStr ? `Delay: ${delayStr}` : null,
      s && s.order > 0 ? `Step ${s.order + 1}` : null,
    ].filter(Boolean).join(' · ')
    const base = `Automation: ${r.name}`
    const sendVerb = sentChannel === 'sms' ? 'SMS sent' : 'email sent'
    // Delivery badge applies only to email rows — SMS goes through Sigcore
    // and has its own delivery telemetry path (or none, currently).
    const deliveryBadge: DeliveryBadge | undefined = sentChannel === 'email' && e.status === 'sent'
      ? {
          status: (e.deliveryStatus as DeliveryBadge['status']) || 'pending',
          at: e.deliveryStatusAt,
          error: e.deliveryErrorMessage,
        }
      : undefined
    if (e.status === 'sent') {
      timeline.push({ label: `${base} — ${sendVerb}`, detail: bits, time: e.sentAt || e.createdAt, type: 'success', delivery: deliveryBadge })
    } else if (e.status === 'failed') {
      timeline.push({ label: `${base} — failed${e.errorMessage ? `: ${e.errorMessage}` : ''}`, detail: bits, time: e.createdAt, type: 'error' })
    } else if (e.status === 'queued' && e.scheduledFor) {
      timeline.push({ label: `${base} — scheduled`, detail: `${bits} · Fires at ${new Date(e.scheduledFor).toLocaleString()}`, time: e.scheduledFor, type: 'scheduled' })
    } else if (e.status === 'cancelled') {
      timeline.push({ label: `${base} — cancelled${e.errorMessage ? `: ${e.errorMessage}` : ''}`, detail: bits, time: e.createdAt, type: 'info' })
    } else if (e.status?.startsWith('skipped_')) {
      // skipped_wrong_stage / skipped_wrong_status / skipped_missing_prerequisite /
      // skipped_duplicate / skipped_cancelled / skipped_ineligible — make the
      // block reason visible so recruiters can tell at a glance why no email
      // was sent (instead of seeing it linger as "pending" forever).
      const reasonLabel = e.skipReason
        ? e.skipReason.replace(/^skipped_/, '').replace(/_/g, ' ')
        : 'skipped'
      timeline.push({ label: `${base} — skipped (${reasonLabel})`, detail: bits, time: e.createdAt, type: 'error' })
    } else {
      timeline.push({ label: `${base} — pending`, detail: bits, time: e.createdAt, type: 'info' })
    }
  })

  // ─── Synthetic candidate-step entries ──────────────────────────────────
  // For each successfully-sent automation whose step expected the candidate
  // to do something next (book a meeting, open training, complete a BG check),
  // surface a derived timeline entry that goes:
  //   waiting → completed (outcome event fired after sentAt) — silent, the
  //             outcome event already shows up on its own
  //   waiting → failed   (deadline elapsed, no outcome) — "Candidate didn't X"
  //   waiting → pending  (deadline still ahead) — "Waiting for candidate to X"
  //
  // Deadlines are pulled from the flow's per-type timeouts (with platform
  // defaults as fallback). Pure render-time logic — no DB writes, no cron.
  const nowMs = Date.now()
  const schedulingHours = candidate.flow?.schedulingTimeoutHours ?? DEFAULT_TIMEOUTS.schedulingTimeoutHours
  const trainingDays = candidate.flow?.trainingTimeoutDays ?? DEFAULT_TIMEOUTS.trainingTimeoutDays
  const bgCheckDays = candidate.flow?.backgroundCheckTimeoutDays ?? DEFAULT_TIMEOUTS.backgroundCheckTimeoutDays

  const fmtRemaining = (msUntil: number) => {
    const h = Math.round(msUntil / 3600_000)
    if (h >= 24) return `${Math.round(h / 24)}d`
    if (h >= 1) return `${h}h`
    const m = Math.max(1, Math.round(msUntil / 60_000))
    return `${m}m`
  }

  ;(candidate.automationExecutions || [])
    .filter(e => e.status === 'sent' && e.sentAt && e.step?.nextStepType)
    // Meeting-relative steps (timingMode='before_meeting'/'after_meeting')
    // presuppose a meeting already exists. A "1h before meeting" reminder
    // marked nextStepType='scheduling' is meant to RE-share the booking
    // link as a courtesy, not gate on a fresh booking. Synthesising
    // "Waiting for candidate to book" against those produces a row dated
    // for after the meeting itself has already happened — pure noise.
    .filter(e => {
      const tm = e.step?.timingMode
      return tm !== 'before_meeting' && tm !== 'after_meeting'
    })
    .forEach(e => {
      const nextType = e.step!.nextStepType!
      const sentAt = new Date(e.sentAt!).getTime()
      let label = ''
      let deadlineMs = 0
      let completed = false

      if (nextType === 'scheduling') {
        label = 'book a meeting'
        deadlineMs = sentAt + schedulingHours * 3600_000
        // Once the candidate has any meeting on record, count this nextStep
        // as satisfied regardless of when the meeting was created relative
        // to sentAt. The "after sentAt" filter from the original design
        // missed the case where a fresh scheduling-invite was sent against
        // an already-booked candidate (e.g. rebooking flow).
        completed = (candidate.interviewMeetings ?? []).length > 0
          || candidate.schedulingEvents.some(ev => ev.eventType === 'meeting_scheduled')
      } else if (nextType === 'training') {
        label = 'open training'
        deadlineMs = sentAt + trainingDays * 86400_000
        completed = candidate.trainingEnrollments.some(en => en.status !== 'not_started' && new Date(en.startedAt).getTime() >= sentAt)
      } else if (nextType === 'background_check') {
        label = 'complete background check'
        deadlineMs = sentAt + bgCheckDays * 86400_000
        completed = (candidate.backgroundChecks ?? []).some(bc => bc.overallScore !== null && new Date(bc.createdAt).getTime() >= sentAt)
      } else {
        return // not a candidate-action nextStepType
      }

      if (completed) return // outcome event already renders elsewhere

      const detail = `Automation: ${e.automationRule.name}`
      if (nowMs > deadlineMs) {
        timeline.push({
          label: `Candidate didn't ${label}`,
          detail: `${detail} · Expected within ${nextType === 'scheduling' ? `${schedulingHours}h` : nextType === 'training' ? `${trainingDays}d` : `${bgCheckDays}d`} of send`,
          time: new Date(deadlineMs).toISOString(),
          type: 'error',
        })
      } else {
        timeline.push({
          label: `Waiting for candidate to ${label}`,
          detail: `${detail} · Expires in ${fmtRemaining(deadlineMs - nowMs)}`,
          time: new Date(deadlineMs).toISOString(),
          type: 'info',
        })
      }
    })

  timeline.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())

  return (
    <div>
      {/* Back + Header */}
      <div className="flex items-center gap-4 mb-6">
        <Link href="/dashboard/candidates" className="text-grey-40 hover:text-grey-15">&larr; Back</Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <button
              onClick={toggleInteresting}
              disabled={interestingBusy}
              title={candidate.interestingAt ? 'Remove from interesting' : 'Mark as interesting'}
              aria-pressed={!!candidate.interestingAt}
              className={`text-xl leading-none px-1 disabled:opacity-50 ${candidate.interestingAt ? 'text-amber-500 hover:text-amber-600' : 'text-grey-40 hover:text-amber-500'}`}
            >
              {candidate.interestingAt ? '★' : '☆'}
            </button>
            <h1 className="text-2xl font-semibold text-grey-15">{candidate.candidateName || 'Anonymous'}</h1>
            <button
              onClick={openProfileEditor}
              title="Edit candidate details"
              className="text-grey-40 hover:text-grey-15 text-sm px-2 py-1 rounded-[8px] border border-surface-border hover:border-grey-35"
            >
              Edit
            </button>
          </div>
          <div className="flex items-center gap-3 mt-1 text-sm text-grey-40">
            {candidate.candidateEmail && <span>{candidate.candidateEmail}</span>}
            {candidate.candidatePhone && <span>{candidate.candidatePhone}</span>}
            {candidate.flow && <span>Flow: {candidate.flow.name}</span>}
            {candidate.rejectionReason ? (
              <>
                <button
                  onClick={openReasonEditor}
                  title="Click to edit rejection reason"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-medium hover:bg-red-200"
                >
                  <span className="opacity-70">Reason:</span> {candidate.rejectionReason}
                </button>
                <button
                  onClick={() => setShowSendMessage({ autoGenerate: true })}
                  disabled={!candidate.candidateEmail && !candidate.candidatePhone}
                  title={candidate.candidateEmail || candidate.candidatePhone ? 'Draft and send a rejection message with AI' : 'Candidate has no email or phone on file'}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-grey-15 text-white text-xs font-medium hover:bg-black disabled:opacity-40 disabled:hover:bg-grey-15"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                    <polyline points="22,6 12,13 2,6" />
                  </svg>
                  Send message
                </button>
              </>
            ) : (candidate.pipelineStatus === 'rejected' || candidate.pipelineStatus === 'failed' || candidate.outcome === 'failed') && (
              <button
                onClick={openReasonEditor}
                className="inline-flex items-center px-2 py-0.5 rounded-full bg-red-50 text-red-600 text-xs font-medium border border-dashed border-red-300 hover:bg-red-100"
              >
                + Add reason
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Rejection reason editor */}
      {showReasonEditor && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50 p-4" onClick={() => setShowReasonEditor(false)}>
          <div className="bg-white rounded-[12px] shadow-2xl w-full max-w-[460px] p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-grey-15 mb-1">Rejection reason</h3>
            <p className="text-xs text-grey-40 mb-4">Pick one or write your own. Stored on the candidate and visible across the dashboard.</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {REJECTION_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setReasonDraft(p)}
                  className={`text-xs px-3 py-1.5 rounded-full border font-medium ${reasonDraft === p ? 'border-red-500 bg-red-50 text-red-700' : 'border-surface-border text-grey-35 hover:border-grey-35'}`}
                >
                  {p}
                </button>
              ))}
              {customReasons.map((p) => (
                <span
                  key={p}
                  className={`group inline-flex items-center gap-1 text-xs pl-3 pr-1 py-1.5 rounded-full border font-medium ${reasonDraft === p ? 'border-red-500 bg-red-50 text-red-700' : 'border-surface-border text-grey-35 hover:border-grey-35'}`}
                >
                  <button onClick={() => setReasonDraft(p)}>{p}</button>
                  <button
                    onClick={() => removeCustomReason(p)}
                    title="Remove from saved reasons"
                    className="w-4 h-4 flex items-center justify-center rounded-full text-grey-50 hover:bg-red-100 hover:text-red-700 text-[11px] leading-none"
                    aria-label={`Remove ${p}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const t = reasonDraft.trim()
                    if (!t) return
                    const lc = t.toLowerCase()
                    const known = REJECTION_PRESETS.some((p) => p.toLowerCase() === lc) || customReasons.some((p) => p.toLowerCase() === lc)
                    if (!known) persistCustomReasons([...customReasons, t])
                  }
                }}
                placeholder="Type a new reason and press + to save it"
                className="flex-1 px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-red-500/40"
                autoFocus
              />
              {(() => {
                const t = reasonDraft.trim()
                const lc = t.toLowerCase()
                const isKnown = !t || REJECTION_PRESETS.some((p) => p.toLowerCase() === lc) || customReasons.some((p) => p.toLowerCase() === lc)
                return (
                  <button
                    onClick={() => { if (!isKnown) persistCustomReasons([...customReasons, t]) }}
                    disabled={isKnown}
                    title={isKnown ? 'Already in the list' : 'Save as a reusable preset'}
                    className="px-3 rounded-[8px] border border-surface-border text-grey-35 hover:border-grey-35 disabled:opacity-40 disabled:hover:border-surface-border text-lg leading-none"
                    aria-label="Add reason to presets"
                  >
                    +
                  </button>
                )
              })()}
            </div>
            <p className="mt-2 text-[11px] text-grey-40">Saved presets appear as quick-picks for every candidate.</p>
            <div className="flex justify-between mt-5 gap-2">
              <button
                onClick={clearReason}
                disabled={!candidate.rejectionReason}
                className="text-xs px-3 py-1.5 rounded-[8px] text-grey-40 hover:text-grey-15 disabled:opacity-40"
              >
                Clear reason
              </button>
              <div className="flex gap-2">
                <button onClick={() => setShowReasonEditor(false)} className="text-sm px-4 py-2 rounded-[8px] text-grey-40 hover:text-grey-15">Cancel</button>
                <button
                  onClick={() => saveReason(reasonDraft)}
                  disabled={!reasonDraft.trim()}
                  className="text-sm px-4 py-2 rounded-[8px] bg-red-600 text-white hover:bg-red-700 font-medium disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showSendMessage && (
        <SendMessageModal
          candidateId={candidate.id}
          candidateEmail={candidate.candidateEmail}
          candidatePhone={candidate.candidatePhone}
          candidateRejectionReason={candidate.rejectionReason}
          autoGenerateRejectionEmail={showSendMessage.autoGenerate}
          onClose={() => setShowSendMessage(null)}
        />
      )}

      {/* Profile editor — name / email / phone / flow. Flow change clears
          the candidate's lastStep server-side so the progress card resets;
          answers + submissions stay attached to their original steps. */}
      {showProfileEditor && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
          onClick={() => !savingProfile && setShowProfileEditor(false)}
        >
          <div
            className="bg-white rounded-[12px] shadow-2xl w-full max-w-[480px] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-grey-15 mb-1">Edit candidate</h3>
            <p className="text-xs text-grey-40 mb-4">Update the candidate&apos;s contact details or move them to a different flow.</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-grey-35 mb-1">Name</label>
                <input
                  type="text"
                  value={profileDraft.candidateName}
                  onChange={(e) => setProfileDraft((d) => ({ ...d, candidateName: e.target.value }))}
                  className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-orange-500/40"
                  placeholder="Full name"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-grey-35 mb-1">Email</label>
                <input
                  type="email"
                  value={profileDraft.candidateEmail}
                  onChange={(e) => setProfileDraft((d) => ({ ...d, candidateEmail: e.target.value }))}
                  className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-orange-500/40"
                  placeholder="name@example.com"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-grey-35 mb-1">Phone</label>
                <input
                  type="tel"
                  value={profileDraft.candidatePhone}
                  onChange={(e) => setProfileDraft((d) => ({ ...d, candidatePhone: e.target.value }))}
                  className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-orange-500/40"
                  placeholder="+1 555 123 4567"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-grey-35 mb-1">Flow</label>
                <select
                  value={profileDraft.flowId}
                  onChange={(e) => setProfileDraft((d) => ({ ...d, flowId: e.target.value }))}
                  className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-orange-500/40 bg-white"
                >
                  {flowsForPicker.length === 0 && candidate.flow && (
                    <option value={candidate.flow.id}>{candidate.flow.name}</option>
                  )}
                  {flowsForPicker.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
                {profileDraft.flowId && profileDraft.flowId !== candidate.flow?.id && (
                  <p className="mt-1 text-[11px] text-amber-700">Moving to a different flow resets the progress card. Existing answers and submissions stay on the timeline.</p>
                )}
              </div>
            </div>
            {profileError && (
              <p className="mt-3 text-xs text-red-600">{profileError}</p>
            )}
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setShowProfileEditor(false)}
                disabled={savingProfile}
                className="text-sm px-4 py-2 rounded-[8px] text-grey-40 hover:text-grey-15 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={saveProfile}
                disabled={savingProfile}
                className="text-sm px-4 py-2 rounded-[8px] bg-grey-15 text-white hover:bg-grey-30 font-medium disabled:opacity-50"
              >
                {savingProfile ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Disposition reason picker — used by Move to Lost / Move to Nurture
          (which require a reason) and Change reason (no status change).
          Shares a single modal because the picker UX is identical. */}
      {reasonModal && (
        <DispositionReasonPicker
          mode={reasonModal.mode}
          targetStatus={reasonModal.targetStatus}
          initial={reasonModal.initial ?? null}
          onClose={() => setReasonModal(null)}
          onSubmit={submitReasonModal}
        />
      )}

      {/* Sibling-session banner — surfaces other applications by the same
          email so recruiters don't get fooled into reviewing a stale older
          session while a newer one is the actually-active record (Stephanie
          Descofleur, 2026-05-06). The kanban dedupes by email so the list
          links the *newest* row, but the detail page is loaded by session
          id and previously gave no signal that siblings existed. */}
      {(candidate.siblingSessions?.length ?? 0) > 0 && (() => {
        const siblings = candidate.siblingSessions!
        // Newest first by API contract — pick that one for the deep link.
        const newest = siblings[0]
        const newestStartedAt = new Date(newest.startedAt).getTime()
        const currentStartedAt = new Date(candidate.startedAt).getTime()
        // Amber tint when the current session is older than at least one
        // sibling AND the newer sibling isn't in a terminal lost/hired state.
        // Recruiter is likely staring at the wrong row.
        const lookingAtStale =
          newestStartedAt > currentStartedAt &&
          !['lost', 'hired'].includes(newest.status)
        const stage = resolveStage(newest.pipelineStatus, stages)
        const fmtDate = (iso: string) =>
          new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        const tone = lookingAtStale
          ? { wrap: 'bg-amber-50 border-amber-200', text: 'text-amber-900', sub: 'text-amber-800' }
          : { wrap: 'bg-surface-light border-surface-border', text: 'text-grey-15', sub: 'text-grey-40' }
        return (
          <div className={`rounded-[12px] border ${tone.wrap} px-4 py-3 mb-4 flex items-center justify-between gap-3 flex-wrap`}>
            <div className="min-w-0">
              <div className={`text-sm font-medium ${tone.text}`}>
                {lookingAtStale
                  ? `You're viewing an older application. ${siblings.length === 1 ? 'A newer one exists' : `${siblings.length} other applications exist`} for this candidate.`
                  : `${siblings.length} other application${siblings.length === 1 ? '' : 's'} by this candidate.`}
              </div>
              <div className={`text-xs ${tone.sub} mt-0.5`}>
                Most recent: applied {fmtDate(newest.startedAt)} · {newest.flowName ?? 'Unknown flow'} · stage <span className="font-medium">{stage.label.trim()}</span>
                {newest.hadNoShow ? ' · had no-show' : ''}
              </div>
            </div>
            <Link
              href={`/dashboard/candidates/${newest.id}`}
              className={`text-xs px-3 py-1.5 rounded-[8px] border font-medium whitespace-nowrap ${
                lookingAtStale
                  ? 'border-amber-300 bg-white text-amber-900 hover:bg-amber-100'
                  : 'border-surface-border bg-white text-grey-15 hover:border-grey-35'
              }`}
            >
              Open most recent →
            </Link>
          </div>
        )
      })()}

      {/* Current activity — at-a-glance "where is the candidate right now"
          panel. Sits above the pipeline so recruiters scanning the page
          see live progress before historical state. */}
      <CurrentActivityCard
        startedAt={candidate.startedAt}
        finishedAt={candidate.finishedAt}
        lastActivityAt={candidate.effectiveLastActivityAt ?? candidate.lastActivityAt}
        outcome={candidate.outcome}
        lastStep={candidate.lastStep}
        flowStepCount={candidate.flowStepCount}
        answersCount={candidate.answers.length}
        trainingEnrollments={candidate.trainingEnrollments}
        trainingAccessStatus={candidate.trainingAccessStatus}
        onRevokeTrainingAccess={revokeTrainingAccess}
        onRestoreTrainingAccess={restoreTrainingAccess}
        pendingTrainingId={pendingTrainingId}
      />

      {/* Status panel — orthogonal axis (active/stalled/lost/...). Sits
          above the funnel-stage pipeline so recruiters can see at a glance
          whether the candidate is actually progressing or stuck. The 5
          lifecycle actions all PATCH /api/candidates/[id]; statusTransitionPatch
          on the server handles stalledAt/lostAt/hiredAt bookkeeping. */}
      {(() => {
        const rawStatus: string = candidate.status ?? 'active'
        // Resolve label/tone from STATUS_DISPLAY for built-ins; fall through
        // to the workspace's custom-statuses list otherwise.
        const builtin = (STATUS_DISPLAY as Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warn' | 'info' | 'danger' }>)[rawStatus]
        const custom = customStatuses.find((c) => c.id === rawStatus)
        const meta = builtin
          ? builtin
          : custom
            ? { label: custom.label, tone: custom.tone }
            : { label: rawStatus, tone: 'neutral' as const }
        const status = rawStatus as CandidateStatus // narrow only used for the built-in stamp/label switches below
        const dispLabel = candidate.dispositionReason
          ? DISPOSITION_DISPLAY[candidate.dispositionReason]
          : null
        const stamp = status === 'stalled' ? candidate.stalledAt
          : status === 'lost' ? candidate.lostAt
          : status === 'hired' ? candidate.hiredAt
          : null
        const stampLabel = status === 'stalled' ? 'Stalled since'
          : status === 'lost' ? 'Lost on'
          : status === 'hired' ? 'Hired on'
          : null
        return (
          <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="text-[11px] font-mono uppercase text-grey-50 mb-2" style={{ letterSpacing: '0.1em' }}>
                  Candidate status
                </div>
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  {dispLabel && (() => {
                    // Tint the disposition pill to match the status — amber
                    // for stalled, red for lost, green for hired. Mirrors
                    // the kanban card's DISPOSITION_TINT so the pill reads
                    // identically in both places.
                    const tint = status === 'stalled' ? 'bg-amber-50 text-amber-800 border-amber-200'
                      : status === 'lost'    ? 'bg-red-50 text-red-700 border-red-200'
                      : status === 'hired'   ? 'bg-green-50 text-green-700 border-green-200'
                      : 'bg-surface-light text-grey-15 border-surface-border'
                    return (
                      <span className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded-full font-medium border ${tint}`}>
                        {dispLabel}
                      </span>
                    )
                  })()}
                </div>
                {stamp && stampLabel && (
                  <div className="text-[12px] text-grey-40 mt-1">
                    {stampLabel} {new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    {' · '}
                    <span className="text-grey-50">
                      {(() => {
                        const days = Math.floor((Date.now() - new Date(stamp).getTime()) / (24 * 60 * 60 * 1000))
                        return days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`
                      })()}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {status !== 'active' && status !== 'waiting' && (
                  <button
                    onClick={() => updateLifecycle('active', null)}
                    disabled={statusBusy}
                    className="text-xs px-3 py-1.5 rounded-[6px] bg-brand-100 text-brand-700 hover:bg-brand-200 font-medium disabled:opacity-50"
                  >
                    Reactivate
                  </button>
                )}
                {status !== 'lost' && (
                  <button
                    onClick={openLostPicker}
                    disabled={statusBusy}
                    className="text-xs px-3 py-1.5 rounded-[6px] bg-red-100 text-red-700 hover:bg-red-200 font-medium disabled:opacity-50"
                  >
                    Move to Lost
                  </button>
                )}
                {status !== 'nurture' && (
                  <button
                    onClick={openNurturePicker}
                    disabled={statusBusy}
                    className="text-xs px-3 py-1.5 rounded-[6px] bg-surface-light text-grey-15 hover:bg-surface-divider font-medium border border-surface-border disabled:opacity-50"
                  >
                    Move to On Hold
                  </button>
                )}
                {status !== 'hired' && (
                  <button
                    onClick={() => updateLifecycle('hired')}
                    disabled={statusBusy}
                    className="text-xs px-3 py-1.5 rounded-[6px] bg-green-100 text-green-700 hover:bg-green-200 font-medium disabled:opacity-50"
                  >
                    Mark as Hired
                  </button>
                )}
                {/* Workspace-defined custom statuses — manual labels (no
                    auto-detect, no lifecycle stamp). Hidden when the
                    candidate is already in that custom status. */}
                {customStatuses.filter((c) => c.id !== status).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => updateLifecycle(c.id)}
                    disabled={statusBusy}
                    title={`Move to ${c.label}`}
                    className="text-xs px-3 py-1.5 rounded-[6px] bg-surface-light text-grey-15 hover:bg-surface-divider font-medium border border-surface-border disabled:opacity-50"
                  >
                    Move to {c.label}
                  </button>
                ))}
                <button
                  onClick={openChangeReason}
                  disabled={statusBusy}
                  className="text-xs px-3 py-1.5 rounded-[6px] text-grey-40 hover:text-grey-15 hover:bg-surface-light font-medium disabled:opacity-50"
                >
                  Change reason
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Pipeline progress */}
      <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-grey-15">Pipeline</h3>
          <div className="flex gap-2">
            <button onClick={() => setShowLogMeeting(true)} className="text-xs px-3 py-1.5 rounded-[6px] bg-purple-100 text-purple-700 hover:bg-purple-200 font-medium">Log meeting</button>
            <button
              onClick={sendMeetingReminder}
              disabled={sendingReminder}
              title="Fire all active before-meeting reminder rules for this candidate now"
              className="text-xs px-3 py-1.5 rounded-[6px] bg-blue-100 text-blue-700 hover:bg-blue-200 font-medium disabled:opacity-50"
            >
              {sendingReminder ? 'Sending…' : 'Send reminder'}
            </button>
            {candidate.outcome !== 'passed' && (
              <button onClick={() => updateOutcome('passed')} className="text-xs px-3 py-1.5 rounded-[6px] bg-green-100 text-green-700 hover:bg-green-200 font-medium">Pass</button>
            )}
            {candidate.outcome !== 'failed' && (
              <button onClick={() => updateOutcome('failed')} className="text-xs px-3 py-1.5 rounded-[6px] bg-red-100 text-red-700 hover:bg-red-200 font-medium">Fail</button>
            )}
            <button
              onClick={deleteCandidate}
              disabled={deleting}
              className="text-xs px-3 py-1.5 rounded-[6px] bg-red-600 text-white hover:bg-red-700 font-medium disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
        {/* Stage pills mirror the kanban — one click moves the candidate
            to that stage immediately. */}
        <div className="flex gap-1 flex-wrap">
          {stages.map((stage) => {
            const isActive = stage.id === activeStage.id
            const isPast = stage.order < activeStage.order
            return (
              <button
                key={stage.id}
                onClick={() => { if (!isActive) updateStatus(stage.id) }}
                title={isActive ? 'Current stage' : `Move to "${stage.label}"`}
                className={`flex-1 min-w-[110px] py-2.5 text-xs font-medium rounded-[6px] transition-colors border ${
                  isActive
                    ? 'bg-brand-500 text-white border-brand-500'
                    : isPast
                    ? 'bg-brand-100 text-brand-700 border-transparent hover:bg-brand-200'
                    : 'bg-surface text-grey-40 hover:bg-surface-light border-transparent'
                }`}
              >
                <span className="inline-flex items-center justify-center gap-1.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: isActive ? 'rgba(255,255,255,0.85)' : stage.color }}
                  />
                  {stage.label}
                </span>
              </button>
            )
          })}
        </div>

        {/* Run automations is always available — the picker lists every
            active workspace rule that applies to this candidate, with the
            rules attached to the current stage grouped first. */}
        <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs text-grey-40">
            Current: <span className="font-medium text-grey-15">{activeStage.label}</span>
          </div>
          <button
            onClick={openPreview}
            disabled={runningAutomations}
            title="Pick an automation to preview and run for this candidate"
            className="text-xs px-3 py-1.5 rounded-[6px] bg-brand-500 text-white hover:bg-brand-600 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {runningAutomations ? 'Firing…' : 'Run automation'}
          </button>
        </div>
        {automationToast && (
          <div className="mt-2 text-xs px-3 py-2 rounded-[6px] bg-brand-50 text-brand-700 border border-brand-100">
            {automationToast}
          </div>
        )}
        {reminderToast && (
          <div className={`mt-2 text-xs px-3 py-2 rounded-[6px] border ${
            reminderToast.kind === 'ok'
              ? 'bg-blue-50 text-blue-700 border-blue-100'
              : 'bg-red-50 text-red-700 border-red-100'
          }`}>
            {reminderToast.text}
          </div>
        )}
      </div>

      {/* Info cards */}
      <div className={`grid grid-cols-2 ${latestMeetingUrl ? 'md:grid-cols-5' : 'md:grid-cols-4'} gap-3 mb-6`}>
        <div className="bg-white rounded-[8px] border border-surface-border p-4">
          <div className="text-xs text-grey-40 mb-1 flex items-center gap-1.5">
            <span>Source</span>
            {candidate.addedManually && (
              <span
                title="Added manually by a recruiter (did not self-apply through a flow)"
                className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium normal-case"
              >
                Manual
              </span>
            )}
          </div>
          <div className="text-sm font-medium text-grey-15 capitalize">{candidate.ad?.source || candidate.source || 'Direct'}</div>
          {candidate.ad && <div className="text-xs text-grey-40 mt-0.5 truncate" title={candidate.ad.name}>{candidate.ad.name}</div>}
          {candidate.campaign && (
            <div className="text-xs text-grey-40 mt-0.5 truncate" title={candidate.campaign}>
              <span className="text-grey-50">Campaign:</span> {candidate.campaign}
            </div>
          )}
        </div>
        <div className="bg-white rounded-[8px] border border-surface-border p-4">
          <div className="text-xs text-grey-40 mb-1">Outcome</div>
          <div className={`text-sm font-medium ${candidate.outcome === 'passed' ? 'text-green-700' : candidate.outcome === 'failed' ? 'text-red-600' : 'text-grey-15'}`}>
            {candidate.outcome ? candidate.outcome.charAt(0).toUpperCase() + candidate.outcome.slice(1) : 'In progress'}
          </div>
        </div>
        {latestMeetingUrl && (() => {
          const isPast = latestMeetingAt ? new Date(latestMeetingAt).getTime() < Date.now() : false
          if (isPast) {
            return (
              <div className="bg-white rounded-[8px] border border-surface-border p-4">
                <div className="text-xs text-grey-40 mb-1">Meeting</div>
                <button
                  onClick={startInstantInterviewFromCard}
                  disabled={startingInstantFromCard}
                  className="text-sm font-medium text-brand-600 hover:underline disabled:opacity-50 text-left"
                  title="Spin up a fresh Meet link + recording bot, ready to copy and send"
                >
                  {startingInstantFromCard ? 'Starting…' : '+ Start instant meeting'}
                </button>
                {latestMeetingAt && (
                  <div className="text-xs text-grey-40 mt-0.5">
                    Last: {new Date(latestMeetingAt).toLocaleString()}
                  </div>
                )}
              </div>
            )
          }
          return (
            <div className="bg-white rounded-[8px] border border-surface-border p-4">
              <div className="text-xs text-grey-40 mb-1">Meeting</div>
              <div className="flex items-center gap-2">
                <a
                  href={latestMeetingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-brand-600 hover:underline truncate"
                  title={latestMeetingUrl}
                >
                  Open meeting link
                </a>
                <button
                  onClick={() => copyMeetingLink(latestMeetingUrl)}
                  title="Copy link to clipboard"
                  className="text-grey-40 hover:text-brand-600 flex-shrink-0"
                  aria-label="Copy link"
                >
                  {copiedMeeting ? (
                    <svg className="w-3.5 h-3.5 text-green-600" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path d="M5 15V5a2 2 0 012-2h10" />
                    </svg>
                  )}
                </button>
              </div>
              {latestMeetingAt && (
                <div className="text-xs text-grey-40 mt-0.5">{new Date(latestMeetingAt).toLocaleString()}</div>
              )}
            </div>
          )
        })()}
        <div className="bg-white rounded-[8px] border border-surface-border p-4">
          <div className="text-xs text-grey-40 mb-1">Answers</div>
          <div className="text-sm font-medium text-grey-15">{candidate.answers.length}</div>
        </div>
        <div className="bg-white rounded-[8px] border border-surface-border p-4">
          <div className="text-xs text-grey-40 mb-1">Video Submissions</div>
          <div className="text-sm font-medium text-grey-15">{candidate.submissions.filter(s => s.videoStorageKey).length}</div>
        </div>
      </div>

      {/* Meet integration v2: in-app Google Meet scheduling (loosely coupled —
          the panel self-hides if the feature flag / scopes aren't active, so
          this never affects workspaces still on the Calendly flow) */}
      <InterviewPanel candidateId={id} candidateEmail={candidate.candidateEmail} isRebook={candidate.isRebook} onCandidateChanged={loadCandidate} />

      {/* Audio capture answers — first-class candidate activity. Self-hides
          when there are no recordings, so candidates who never hit a
          capture step don't see an empty card. Shares the same fetch as
          the Captures tab below; single network call. */}
      <CapturesPanel captures={captures} loading={capturesLoading} />

      {/* AI training calls + evaluation. Lets the recruiter create a new AI
          call link pre-bound to this candidate, map an unattached existing
          one, and run the AI evaluation against the candidate's accumulated
          transcripts (AI calls, self-intro captures, meetings). */}
      <AICallsPanel sessionId={id} candidateName={candidate.candidateName} />

      {/* Background check — Certn integration; self-hides gracefully if the
          workspace hasn't connected Certn yet (the order button just returns
          a friendly config error). */}
      <div className="mb-6">
        <BackgroundCheckCard sessionId={id} />
      </div>

      {/* Internal notes — recruiter-only, not shown to the candidate */}
      <NotesPanel candidateId={id} />

      {/* Form data */}
      {candidate.formData && Object.keys(candidate.formData).length > 0 && (
        <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
          <h3 className="text-sm font-semibold text-grey-15 mb-3">Form Data</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {Object.entries(candidate.formData).map(([key, value]) => {
              const builtInLabels: Record<string, string> = { name: 'Full Name', email: 'Email', phone: 'Phone' }
              const label = candidate.formFieldLabels?.[key] || builtInLabels[key] || key
              return (
                <div key={key}>
                  <div className="text-xs text-grey-40">{label}</div>
                  <div className="text-sm text-grey-15">{String(value)}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-surface-border">
        {[
          { key: 'answers' as const, label: `Answers (${candidate.answers.length})` },
          { key: 'submissions' as const, label: `Submissions (${candidate.submissions.length})` },
          // Captures count is loaded lazily on tab open; show '…' until the
          // fetch lands. The lazy load keeps the main candidate payload tight.
          { key: 'captures' as const, label: `Captures (${captures == null ? '…' : captures.length})` },
          { key: 'timeline' as const, label: `Timeline (${timeline.length})` },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key ? 'border-brand-500 text-brand-600' : 'border-transparent text-grey-40 hover:text-grey-20'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Answers tab */}
      {tab === 'answers' && (
        <div className="space-y-3">
          {candidate.answers.length === 0 ? (
            <div className="bg-white rounded-[12px] border border-surface-border p-8 text-center text-grey-40">No answers recorded</div>
          ) : candidate.answers.map((a, i) => (
            <div key={a.id} className="bg-white rounded-[8px] border border-surface-border p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs px-2 py-0.5 rounded-full bg-brand-50 text-brand-600 font-medium">Step {i + 1}</span>
                <span className="text-sm font-medium text-grey-15">{a.step.title}</span>
              </div>
              {a.step.questionText && <p className="text-sm text-grey-35 mb-2">{a.step.questionText}</p>}
              {a.option && (
                <div className="inline-block px-3 py-1.5 bg-brand-50 text-brand-700 rounded-[6px] text-sm font-medium">
                  {a.option.optionText}
                </div>
              )}
              <div className="text-xs text-grey-50 mt-2">{new Date(a.answeredAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}

      {/* Submissions tab */}
      {tab === 'submissions' && (
        <div className="space-y-4">
          {candidate.submissions.length === 0 ? (
            <div className="bg-white rounded-[12px] border border-surface-border p-8 text-center text-grey-40">No submissions</div>
          ) : candidate.submissions.map(s => (
            <div key={s.id} className="bg-white rounded-[8px] border border-surface-border p-4">
              <div className="text-sm font-medium text-grey-15 mb-2">{s.step.title}</div>
              {s.step.questionText && <p className="text-sm text-grey-35 mb-3">{s.step.questionText}</p>}
              {s.videoStorageKey && (
                <video
                  src={`/uploads/${s.videoStorageKey}`}
                  controls
                  playsInline
                  className="w-full max-w-lg rounded-[8px] bg-black mb-2"
                />
              )}
              {s.textMessage && (
                <div className="bg-surface rounded-[8px] p-3 text-sm text-grey-15 whitespace-pre-wrap">{s.textMessage}</div>
              )}
              <div className="text-xs text-grey-50 mt-2">{new Date(s.submittedAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}

      {/* Captures tab */}
      {tab === 'captures' && (
        <div className="space-y-4">
          {capturesLoading && captures === null ? (
            <div className="bg-white rounded-[12px] border border-surface-border p-8 text-center text-grey-40">
              Loading captures…
            </div>
          ) : captures == null || captures.length === 0 ? (
            <div className="bg-white rounded-[12px] border border-surface-border p-8 text-center text-grey-40">
              No captures
            </div>
          ) : (
            captures.map((c) => (
              <div key={c.id} className="bg-white rounded-[8px] border border-surface-border p-4">
                {c.prompt ? (
                  <p className="text-sm text-grey-35 mb-3 whitespace-pre-wrap">{c.prompt}</p>
                ) : null}
                <CapturePlayback
                  captureId={c.id}
                  mode={c.mode}
                  status={c.status}
                  mimeType={c.mimeType}
                  durationSec={c.durationSec}
                  fileSizeBytes={c.fileSizeBytes}
                  captureOrdinal={c.captureOrdinal}
                  playbackUrl={c.playbackUrl}
                />
                {c.errorMessage ? (
                  <div className="mt-2 text-xs text-red-600">{c.errorMessage}</div>
                ) : null}
                <div className="text-xs text-grey-50 mt-2">
                  {new Date(c.createdAt).toLocaleString()}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Timeline tab */}
      {tab === 'timeline' && (
        <div className="bg-white rounded-[12px] border border-surface-border p-6">
          <div className="space-y-0">
            {timeline.map((event, i) => (
              <div key={i} className="flex gap-4 pb-6 last:pb-0">
                <div className="flex flex-col items-center">
                  <div className={`w-3 h-3 rounded-full flex-shrink-0 ${
                    event.type === 'success' ? 'bg-green-500' :
                    event.type === 'error' ? 'bg-red-500' :
                    event.type === 'start' ? 'bg-brand-500' :
                    event.type === 'scheduled' ? 'bg-amber-400 ring-2 ring-amber-200' :
                    'bg-gray-300'
                  }`} />
                  {i < timeline.length - 1 && <div className="w-px flex-1 bg-gray-200 mt-1" />}
                </div>
                <div className="pb-2 min-w-0 flex-1">
                  <div className="text-sm text-grey-15 font-medium flex items-center gap-2 flex-wrap">
                    <span>{event.label}</span>
                    {event.delivery && <DeliveryBadgePill delivery={event.delivery} />}
                  </div>
                  {event.detail && <div className="text-xs text-grey-35 mt-0.5">{event.detail}</div>}
                  <div className="text-xs text-grey-40 mt-0.5">{new Date(event.time).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showLogMeeting && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-white rounded-[12px] shadow-2xl p-8 w-full max-w-[480px]" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-semibold text-grey-15 mb-1">Log scheduled meeting</h2>
            <p className="text-sm text-grey-40 mb-5">Record a meeting the candidate has booked. This also advances them to the &quot;Scheduled&quot; pipeline stage.</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Meeting date &amp; time</label>
                <input type="datetime-local" value={meetingAt} onChange={(e) => setMeetingAt(e.target.value)} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Meeting link (optional)</label>
                <input type="url" value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} placeholder="https://meet.google.com/…" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Notes (optional)</label>
                <textarea value={meetingNotes} onChange={(e) => setMeetingNotes(e.target.value)} rows={3} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowLogMeeting(false)} className="btn-secondary flex-1">Cancel</button>
              <button onClick={logMeeting} disabled={savingMeeting || !meetingAt} className="btn-primary flex-1 disabled:opacity-50">{savingMeeting ? 'Saving…' : 'Log meeting'}</button>
            </div>
          </div>
        </div>
      )}

      {previewState && (() => {
        const stageRules = previewState.rules.filter((r) => r.matchesStage)
        const otherRules = previewState.rules.filter((r) => !r.matchesStage)
        const renderRow = (r: (typeof previewState.rules)[number]) => {
          const rowState = perRuleState[r.id]
          const firing = rowState?.firing === true
          const result = rowState?.result
          return (
            <li key={r.id} className="px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-grey-15 truncate">{r.name}</div>
                <div className="text-xs text-grey-40 mt-0.5">
                  Trigger: {triggerLabels[r.triggerType] ?? r.triggerType}
                </div>
                {result && (
                  <div className={`text-xs mt-1 ${result.ok ? 'text-green-700' : 'text-red-600'}`}>
                    {result.ok ? '✓ ' : '✗ '}{result.message}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0 mt-0.5">
                <button
                  onClick={() => runSingleRule(r.id)}
                  disabled={firing || runningAutomations}
                  className="text-xs px-2.5 py-1 rounded-[6px] bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {firing ? 'Firing…' : result?.ok ? 'Run again' : 'Run'}
                </button>
                <button
                  onClick={() => setViewingRule({ id: r.id, name: r.name })}
                  className="text-xs text-brand-600 hover:underline"
                >
                  View
                </button>
              </div>
            </li>
          )
        }

        return (
          <div
            className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
            onMouseDown={(e) => { if (e.target === e.currentTarget && !runningAutomations) setPreviewState(null) }}
          >
            <div className="bg-white rounded-[12px] shadow-2xl w-full max-w-[520px]" onClick={(e) => e.stopPropagation()}>
              <div className="px-6 pt-6 pb-3">
                <h2 className="text-lg font-semibold text-grey-15">Run automation</h2>
                <p className="text-sm text-grey-40 mt-1">
                  Pick an automation to fire for this candidate. Preview the message
                  with &ldquo;View&rdquo;, then &ldquo;Run&rdquo; to send. Multi-step rules queue follow-ups
                  at their configured delays.
                </p>
              </div>
              <div className="px-6 pb-2 max-h-[55vh] overflow-y-auto">
                {previewState.loading ? (
                  <div className="py-6 text-center text-sm text-grey-40">Loading…</div>
                ) : previewState.error ? (
                  <div className="py-3 px-3 rounded-[8px] bg-red-50 text-red-700 text-sm">{previewState.error}</div>
                ) : previewState.rules.length === 0 ? (
                  <div className="py-6 text-center text-sm text-grey-40">
                    No active automations in this workspace apply to this candidate&apos;s flow.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {stageRules.length > 0 && (
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-grey-40 mb-1.5 font-medium">
                          Matches current stage — {activeStage.label}
                        </div>
                        <ul className="divide-y divide-surface-divider rounded-[8px] border border-surface-border">
                          {stageRules.map(renderRow)}
                        </ul>
                      </div>
                    )}
                    {otherRules.length > 0 && (
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-grey-40 mb-1.5 font-medium">
                          {stageRules.length > 0 ? 'Other automations' : 'All automations'}
                        </div>
                        <ul className="divide-y divide-surface-divider rounded-[8px] border border-surface-border">
                          {otherRules.map(renderRow)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="px-6 py-4 flex justify-end border-t border-surface-divider mt-2">
                <button
                  onClick={() => setPreviewState(null)}
                  disabled={runningAutomations}
                  className="text-sm px-4 py-2 rounded-[8px] bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-50"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {viewingRule && (
        <AutomationPreviewModal
          ruleId={viewingRule.id}
          ruleName={viewingRule.name}
          onClose={() => setViewingRule(null)}
        />
      )}
    </div>
  )
}

// Visual indicator of SendGrid delivery state for a sent automation email.
// Renders inline next to the timeline label; tooltip carries the raw
// reason/error when SendGrid surfaced one.
//
//   pending   — webhook hasn't reported yet (gray, neutral)
//   processed — accepted into SendGrid queue (gray, neutral)
//   delivered — handed off to recipient MTA (green)
//   deferred  — recipient asking SendGrid to retry (amber warning)
//   bounce/dropped/blocked — terminal failure (red warning)
function DeliveryBadgePill({
  delivery,
}: {
  delivery: {
    status: 'processed' | 'delivered' | 'deferred' | 'bounce' | 'dropped' | 'blocked' | 'pending'
    at: string | null
    error: string | null
  }
}) {
  const meta = (() => {
    switch (delivery.status) {
      case 'delivered': return { label: 'Delivered', cls: 'bg-green-100 text-green-700' }
      case 'processed': return { label: 'Processed', cls: 'bg-gray-100 text-grey-35' }
      case 'deferred': return { label: 'Deferred — retrying', cls: 'bg-amber-100 text-amber-700' }
      case 'bounce': return { label: 'Not delivered: Bounced', cls: 'bg-red-100 text-red-700' }
      case 'dropped': return { label: 'Not delivered: Dropped', cls: 'bg-red-100 text-red-700' }
      case 'blocked': return { label: 'Not delivered: Blocked', cls: 'bg-red-100 text-red-700' }
      case 'pending':
      default: return { label: 'Pending delivery confirmation', cls: 'bg-gray-100 text-grey-40' }
    }
  })()
  const tooltipBits = [
    delivery.at ? new Date(delivery.at).toLocaleString() : null,
    delivery.error || null,
  ].filter(Boolean)
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${meta.cls}`}
      title={tooltipBits.join(' — ') || undefined}
    >
      {meta.label}
    </span>
  )
}
