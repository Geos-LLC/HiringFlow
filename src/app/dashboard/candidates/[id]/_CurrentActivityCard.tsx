'use client'

/**
 * CurrentActivityCard — at-a-glance "where is this candidate right now"
 * panel for recruiters. Surfaces three live signals derived from data
 * already on the candidate object:
 *   1. Application flow position (Step X of Y + the step's title)
 *   2. Training enrollment progress (sections complete, currently on)
 *   3. A heartbeat ("Last seen 4 min ago") from Session.lastActivityAt
 *
 * Interview state is intentionally not duplicated here — InterviewPanel
 * already renders that just below.
 */

import { useEffect, useState } from 'react'

interface LastStep {
  id: string
  title: string
  stepOrder: number
  stepType: string
  questionType: string
}

interface TrainingSection {
  id: string
  title: string
  sortOrder: number
  kind: string
  contents?: { id: string; type: string }[]
}

interface TrainingEnrollment {
  id: string
  status: string
  startedAt: string
  completedAt: string | null
  progress: {
    completedSections?: string[]
    quizScores?: { sectionId: string; score: number }[]
    sectionTimestamps?: Record<string, string>
    currentLesson?: { sectionId: string; lessonIdx: number; at: string }
  } | null
  training: { id: string; title: string; sections?: TrainingSection[] }
}

interface CurrentActivityCardProps {
  startedAt: string
  finishedAt: string | null
  lastActivityAt: string | null
  outcome: string | null
  lastStep: LastStep | null
  flowStepCount: number
  answersCount: number
  trainingEnrollments: TrainingEnrollment[]
  // Per-training access state from /api/candidates/[id]. Drives the
  // "Access revoked" badge + Revoke/Restore button label. Map key is
  // Training.id; value is 'active' when at least one TrainingAccessToken
  // is live, 'revoked' when all tokens have been flipped, 'none' when
  // no tokens exist (public-mode trainings the candidate self-served).
  trainingAccessStatus?: Record<string, 'active' | 'revoked' | 'none'>
  // Parent owns the confirmation prompt + API call + refetch so this card
  // stays a dumb renderer.
  onRevokeTrainingAccess?: (trainingId: string, trainingTitle: string) => void
  onRestoreTrainingAccess?: (trainingId: string, trainingTitle: string) => void
  // Set to the training id whose toggle is in flight, so the row's button
  // can render its loading state.
  pendingTrainingId?: string | null
}

function relativeTime(iso: string | null): { text: string; tone: 'live' | 'recent' | 'idle' | 'stale' } {
  if (!iso) return { text: 'Never seen', tone: 'stale' }
  const d = new Date(iso).getTime()
  const diff = Date.now() - d
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return { text: 'Active now', tone: 'live' }
  const min = Math.floor(sec / 60)
  if (min < 60) return { text: `Last active ${min} min ago`, tone: min < 5 ? 'live' : 'recent' }
  const hr = Math.floor(min / 60)
  if (hr < 24) return { text: `Last active ${hr}h ago`, tone: 'idle' }
  const day = Math.floor(hr / 24)
  if (day < 7) return { text: `Last active ${day}d ago`, tone: 'stale' }
  return { text: `Last active ${new Date(iso).toLocaleDateString()}`, tone: 'stale' }
}

function ProgressBar({ pct, tone = 'brand' }: { pct: number; tone?: 'brand' | 'green' | 'gray' }) {
  const clamped = Math.max(0, Math.min(100, pct))
  const fill = tone === 'green' ? 'bg-green-500' : tone === 'gray' ? 'bg-gray-300' : 'bg-brand-500'
  return (
    <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
      <div className={`h-full ${fill} transition-all`} style={{ width: `${clamped}%` }} />
    </div>
  )
}

export function CurrentActivityCard({
  startedAt,
  finishedAt,
  lastActivityAt,
  outcome,
  lastStep,
  flowStepCount,
  answersCount,
  trainingEnrollments,
  trainingAccessStatus,
  onRevokeTrainingAccess,
  onRestoreTrainingAccess,
  pendingTrainingId,
}: CurrentActivityCardProps) {
  // Re-tick the relative-time label every 30s so "Last active 4 min ago"
  // doesn't go stale while the recruiter is staring at the page.
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const heartbeat = relativeTime(lastActivityAt || startedAt)
  const dotClass =
    heartbeat.tone === 'live'
      ? 'bg-green-500 ring-2 ring-green-200 animate-pulse'
      : heartbeat.tone === 'recent'
      ? 'bg-green-400'
      : heartbeat.tone === 'idle'
      ? 'bg-amber-400'
      : 'bg-gray-300'

  // ── Flow status ────────────────────────────────────────────────────────
  // finishedAt set → flow done. Otherwise the step they're sitting on now
  // is `lastStep`; position is 1-indexed via stepOrder.
  const flowState: { kind: 'completed' | 'in_progress' | 'not_started' | 'no_flow'; pct: number; label: string; sub?: string } = (() => {
    if (flowStepCount === 0) return { kind: 'no_flow', pct: 0, label: 'No flow attached' }
    if (finishedAt) {
      const labelPart = outcome === 'passed' ? 'Passed' : outcome === 'failed' ? 'Failed' : 'Completed'
      return { kind: 'completed', pct: 100, label: `Flow ${labelPart.toLowerCase()}`, sub: `Finished ${new Date(finishedAt).toLocaleString()}` }
    }
    if (!lastStep) {
      // Edge case: session created but no lastStep — treat as not started.
      return { kind: 'not_started', pct: 0, label: 'Not started yet', sub: `${flowStepCount} step${flowStepCount === 1 ? '' : 's'} total` }
    }
    const pos = lastStep.stepOrder + 1
    const pct = Math.round((pos / Math.max(1, flowStepCount)) * 100)
    return {
      kind: 'in_progress',
      pct,
      label: `Step ${pos} of ${flowStepCount}`,
      sub: `Currently on: ${lastStep.title}${answersCount > 0 ? ` · ${answersCount} answer${answersCount === 1 ? '' : 's'} so far` : ''}`,
    }
  })()

  // ── Training rows ──────────────────────────────────────────────────────
  const trainingRows = trainingEnrollments.map((e) => {
    const sections = e.training.sections || []
    const completedIds = new Set(e.progress?.completedSections || [])
    const total = sections.length
    const done = sections.filter((s) => completedIds.has(s.id)).length
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    const isCompleted = e.status === 'completed' || e.completedAt !== null

    // Prefer the candidate's most recent position ping when they're
    // mid-section — that's "where they are right now" with finer
    // granularity than the next-incomplete-section fallback. Skip if
    // the pinged section is already complete (stale ping) or no longer
    // exists (training was edited).
    const cl = e.progress?.currentLesson
    let currentSection: TrainingSection | null = null
    let currentLessonIdx: number | null = null
    let currentLessonTotal: number | null = null
    if (!isCompleted && cl) {
      const pinged = sections.find((s) => s.id === cl.sectionId)
      if (pinged && !completedIds.has(pinged.id)) {
        currentSection = pinged
        currentLessonIdx = cl.lessonIdx
        // The training editor stores the section's description as the
        // first text-type content — exclude it so "Lesson 3 of N" matches
        // what the candidate sees in the viewer.
        const lessonContents = (pinged.contents || []).filter((c, i) => {
          if (i === 0 && c.type === 'text') return false
          return true
        })
        currentLessonTotal = lessonContents.length || null
      }
    }
    if (!isCompleted && !currentSection) {
      currentSection = sections.find((s) => !completedIds.has(s.id)) || null
    }

    return {
      id: e.id,
      trainingId: e.training.id,
      title: e.training.title,
      isCompleted,
      done,
      total,
      pct,
      currentSection,
      currentLessonIdx,
      currentLessonTotal,
      lastPingAt: cl?.at ?? null,
      completedAt: e.completedAt,
      startedAt: e.startedAt,
    }
  })

  return (
    <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-grey-15">Current activity</h3>
        <div className="flex items-center gap-2 text-xs text-grey-40">
          <span className={`w-2 h-2 rounded-full ${dotClass}`} aria-hidden />
          <span>{heartbeat.text}</span>
        </div>
      </div>

      {/* Flow */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-grey-20 uppercase tracking-wide">Application flow</span>
          <span
            className={`text-xs font-medium ${
              flowState.kind === 'completed'
                ? outcome === 'failed'
                  ? 'text-red-600'
                  : 'text-green-700'
                : flowState.kind === 'in_progress'
                ? 'text-brand-600'
                : 'text-grey-40'
            }`}
          >
            {flowState.label}
          </span>
        </div>
        <ProgressBar
          pct={flowState.pct}
          tone={flowState.kind === 'completed' ? (outcome === 'failed' ? 'gray' : 'green') : 'brand'}
        />
        {flowState.sub && <div className="text-xs text-grey-40 mt-1.5">{flowState.sub}</div>}
      </div>

      {/* Trainings */}
      {trainingRows.length > 0 && (
        <div className="space-y-3 pt-3 border-t border-surface-divider">
          {trainingRows.map((t) => {
            const accessState = trainingAccessStatus?.[t.trainingId] ?? 'none'
            const isRevoked = accessState === 'revoked'
            const isPending = pendingTrainingId === t.trainingId
            return (
            <div key={t.id}>
              <div className="flex items-center justify-between mb-1.5 gap-2">
                <span className="text-xs font-medium text-grey-20 truncate flex items-center gap-2 min-w-0" title={t.title}>
                  <span className="truncate">
                    Training: <span className="text-grey-15">{t.title}</span>
                  </span>
                  {isRevoked && (
                    <span
                      className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full border border-red-200 bg-red-50 text-red-700 font-semibold uppercase tracking-wide shrink-0"
                      title="This candidate's training links have been revoked. The link returns Access unavailable until restored."
                    >
                      Access revoked
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-xs font-medium ${
                      t.isCompleted ? 'text-green-700' : t.total === 0 ? 'text-grey-40' : 'text-brand-600'
                    }`}
                  >
                    {t.total === 0
                      ? t.isCompleted
                        ? 'Completed'
                        : 'In progress'
                      : t.isCompleted
                      ? 'Completed'
                      : `${t.done} of ${t.total} sections`}
                  </span>
                  {isRevoked
                    ? onRestoreTrainingAccess && (
                        <button
                          type="button"
                          onClick={() => onRestoreTrainingAccess(t.trainingId, t.title)}
                          disabled={isPending}
                          className="text-[11px] px-2 py-0.5 rounded-[6px] border border-green-200 bg-white text-green-700 hover:bg-green-50 font-medium disabled:opacity-50"
                          title="Re-enable the candidate's existing training link"
                        >
                          {isPending ? 'Restoring…' : 'Restore access'}
                        </button>
                      )
                    : onRevokeTrainingAccess && (
                        <button
                          type="button"
                          onClick={() => onRevokeTrainingAccess(t.trainingId, t.title)}
                          disabled={isPending}
                          className="text-[11px] px-2 py-0.5 rounded-[6px] border border-red-200 bg-white text-red-700 hover:bg-red-50 font-medium disabled:opacity-50"
                          title="Invalidate every training link this candidate received for this training"
                        >
                          {isPending ? 'Revoking…' : 'Revoke access'}
                        </button>
                      )}
                </div>
              </div>
              <ProgressBar pct={t.isCompleted ? 100 : t.pct} tone={t.isCompleted ? 'green' : 'brand'} />
              {!t.isCompleted && t.currentSection && (
                <div className="text-xs text-grey-40 mt-1.5">
                  Currently on: {t.currentSection.title}
                  {t.currentLessonIdx !== null && (
                    <>
                      {' '}· Lesson {t.currentLessonIdx + 1}
                      {t.currentLessonTotal ? ` of ${t.currentLessonTotal}` : ''}
                    </>
                  )}
                  {t.lastPingAt && (
                    <span className="text-grey-50"> · last ping {relativeTime(t.lastPingAt).text.replace('Last active ', '').replace('Active now', 'just now')}</span>
                  )}
                </div>
              )}
              {t.isCompleted && t.completedAt && (
                <div className="text-xs text-grey-40 mt-1.5">
                  Finished {new Date(t.completedAt).toLocaleString()}
                </div>
              )}
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
