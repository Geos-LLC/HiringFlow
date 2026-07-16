/**
 * False-no-show reconciler.
 *
 * `handleBotCallEnded` (Recall) and `sync-on-read`'s attendance path both make
 * best-effort no-show calls before every attendance signal is in. When they
 * get it wrong the candidate lands in a terminal no-show state (rejection
 * pill + `status=lost` + `dispositionReason=interview_no_show` + automations
 * halted). Later, the recording finalizes and lands on the same
 * InterviewMeeting row — proof the meeting actually happened — but nothing
 * un-marks the candidate. She stays rejected forever.
 *
 * `reconcileFalseNoShow` is the un-mark. It's called from every path that
 * observes definitive proof of attendance (recording ready, actualStart
 * populated, Recall bot.done). Idempotent — if the session is already
 * active, or the meeting has no attendance evidence, it's a no-op.
 *
 * Also called by a cron sweep (Rule 6 in reconcile-automations) as a
 * backfill for meetings whose false no-show landed before this reconciler
 * shipped.
 */
import { prisma } from '../prisma'
import { logSchedulingEvent } from '../scheduling'
import { emitAutomationEvent, eventKeys } from '../automation-emit'
import { fireMeetingLifecycleAutomations } from '../automation'
import { statusTransitionPatch } from '../candidate-status'
import { setPipelineStatus } from '../pipeline-status'

export interface ReconcileResult {
  reverted: boolean
  reason?: string
}

/**
 * Did the meeting produce evidence the candidate was actually there? The
 * caller decides what counts as evidence — this predicate is deliberately
 * generous (any one of: primary recording landed on either side, Recall bot
 * has a recording id, or the meeting has an actualStart from attendance
 * sync). None of these can be produced by a legitimately no-show meeting.
 */
export function meetingHasAttendanceEvidence(m: {
  recordingState: string
  recallRecordingId: string | null
  driveRecordingFileId: string | null
  actualStart: Date | null
}): boolean {
  return (
    m.recordingState === 'ready' ||
    m.recallRecordingId != null ||
    m.driveRecordingFileId != null ||
    m.actualStart != null
  )
}

/**
 * Un-mark a false no-show. Safe to call on any meeting — will short-circuit
 * when either (a) the session isn't currently in a no-show state or (b) the
 * meeting has no attendance evidence.
 *
 * Order matters:
 *   1. Revert session status FIRST — the meeting_ended emit below routes
 *      through fireMeetingLifecycleAutomations which respects automationsHalted.
 *   2. Log the audit event so timelines show what happened.
 *   3. Emit meeting_ended (idempotent via eventKeys.meetingEnded). This runs
 *      applyStageTrigger('meeting_ended') so the kanban card moves off the
 *      no-show stage, and any post-meeting automations dispatch. If the
 *      workspace hasn't wired a meeting_ended stage, the card stays where
 *      the no-show trigger left it — recruiter drags manually. Better than
 *      guessing at a stage.
 */
export async function reconcileFalseNoShow(
  interviewMeetingId: string,
  source: string,
): Promise<ReconcileResult> {
  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: interviewMeetingId },
    select: {
      id: true,
      sessionId: true,
      workspaceId: true,
      actualStart: true,
      recordingState: true,
      recallRecordingId: true,
      driveRecordingFileId: true,
    },
  })
  if (!meeting) return { reverted: false }
  if (!meetingHasAttendanceEvidence(meeting)) return { reverted: false, reason: 'no_evidence' }

  const session = await prisma.session.findUnique({
    where: { id: meeting.sessionId },
    select: {
      id: true,
      status: true,
      rejectionReason: true,
      dispositionReason: true,
      automationsHaltedAt: true,
      automationsHaltedReason: true,
    },
  })
  if (!session) return { reverted: false }

  const wasNoShowRejection = session.rejectionReason === 'No-show'
  const wasNoShowLost = session.status === 'lost' && session.dispositionReason === 'interview_no_show'
  if (!wasNoShowRejection && !wasNoShowLost) return { reverted: false, reason: 'already_active' }

  const patch: Record<string, unknown> = {}
  if (wasNoShowRejection) {
    patch.rejectionReason = null
    patch.rejectionReasonAt = null
  }
  if (wasNoShowLost) {
    Object.assign(patch, statusTransitionPatch('active', { dispositionReason: null }))
  }
  // Only clear halted state when it was set by the same lifecycle event —
  // a recruiter-set manual halt for a different reason stays put.
  if (session.automationsHaltedReason === 'lifecycle:meeting_no_show') {
    patch.automationsHaltedAt = null
    patch.automationsHaltedReason = null
  }

  await prisma.session.update({ where: { id: session.id }, data: patch })

  // Restore the kanban stage the candidate was on before meeting_no_show
  // moved her. Emitting meeting_ended below would only work if the workspace
  // wired a stage to that trigger; without a wired stage the card would
  // otherwise stay pinned to the "Rejected" column. The auto:meeting_no_show
  // PipelineStatusChange row records the exact stage she came from — walk
  // back to it.
  try {
    // Exact-match source: `auto:meeting_no_show_reverted` also starts with
    // `auto:meeting_no_show`, so a startsWith filter would loop back onto
    // the reverter's own audit row on a second pass.
    const priorMove = await prisma.pipelineStatusChange.findFirst({
      where: {
        sessionId: session.id,
        source: 'auto:meeting_no_show',
      },
      orderBy: { createdAt: 'desc' },
      select: { fromStatus: true },
    })
    if (priorMove?.fromStatus) {
      await setPipelineStatus({
        sessionId: session.id,
        toStatus: priorMove.fromStatus,
        source: 'auto:meeting_no_show_reverted',
        metadata: { interviewMeetingId: meeting.id, reason: source },
      })
    }
  } catch (err) {
    console.error('[reconcile-no-show] restore prior stage failed:', (err as Error).message)
  }

  await logSchedulingEvent({
    sessionId: session.id,
    eventType: 'meeting_no_show_reverted',
    metadata: {
      interviewMeetingId: meeting.id,
      source,
      recordingState: meeting.recordingState,
      hadRecall: !!meeting.recallRecordingId,
      hadDrive: !!meeting.driveRecordingFileId,
      hadActualStart: !!meeting.actualStart,
    },
  }).catch((err) => console.error('[reconcile-no-show] logSchedulingEvent failed:', (err as Error).message))

  // Emit meeting_ended so applyStageTrigger + post-meeting automations run.
  // Deduped by eventKeys.meetingEnded — safe if a prior meeting_ended event
  // already landed (e.g. the sync path fired one before the no-show race).
  await emitAutomationEvent({
    workspaceId: meeting.workspaceId,
    sessionId: session.id,
    triggerType: 'meeting_ended',
    eventKey: eventKeys.meetingEnded(meeting.id),
    source: 'cron',
    payload: { interviewMeetingId: meeting.id, source: `reconcile_no_show:${source}` },
    dispatch: () => fireMeetingLifecycleAutomations(session.id, 'meeting_ended'),
  }).catch((err) => console.error('[reconcile-no-show] emit meeting_ended failed:', (err as Error).message))

  return { reverted: true, reason: source }
}
