/**
 * Translate Recall.ai bot lifecycle events into our existing
 * InterviewMeeting + SchedulingEvent + InterviewMeetingArtifact writes.
 *
 * Source-of-truth contract: the SAME lifecycle events that the Meet
 * Workspace Events webhook / chrome-extension attendance route emit
 * (meeting_started / meeting_ended / meeting_no_show / recording_ready)
 * are fired here when the equivalent Recall event arrives. Downstream
 * automation rules don't need to know whether the signal came from Meet,
 * the chrome extension, or Recall — they just trigger off the
 * SchedulingEvent.
 *
 * Idempotency: every dispatch goes through emitLifecycleOnce / recordArtifact
 * which dedupe on (sessionId, eventType, metadata.interviewMeetingId) and
 * (interviewMeetingId, driveFileId) respectively. Safe to replay any
 * webhook delivery.
 */

import { prisma } from '../prisma'
import { logSchedulingEvent } from '../scheduling'
import { fireMeetingLifecycleAutomations } from '../automation'
import { bumpSessionActivity } from '../session-activity'
import { recordArtifact } from '../meet/artifacts'
import { getBot, listBotParticipants, type RecallParticipant } from './client'

/**
 * Idempotently emit a meeting lifecycle event + run automations.
 * Mirrors emitLifecycleOnce in /api/google-meet/attendance/route.ts so a
 * Recall-driven meeting_started doesn't double-fire with a stale extension
 * snapshot for the same meeting.
 */
async function emitLifecycleOnce(
  interviewMeetingId: string,
  sessionId: string,
  eventType: 'meeting_started' | 'meeting_ended' | 'meeting_no_show' | 'recording_ready',
  at: Date,
  extra: Record<string, unknown>,
): Promise<boolean> {
  const existing = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId,
      eventType,
      metadata: { path: ['interviewMeetingId'], equals: interviewMeetingId },
    },
    select: { id: true },
  })
  if (existing) return false
  await logSchedulingEvent({
    sessionId,
    eventType,
    metadata: { interviewMeetingId, at: at.toISOString(), source: 'recall', ...extra },
  })
  await fireMeetingLifecycleAutomations(sessionId, eventType).catch((err) =>
    console.error(`[recall] ${eventType} automations failed:`, err),
  )
  return true
}

interface StoredParticipantRow {
  email: string | null
  displayName: string | null
  isHost?: boolean
  joinTime?: string
  leaveTime?: string
  source: 'recall'
  recallParticipantId?: number
}

/**
 * Recall participant events array contains a chronological log of
 * join/leave-style codes. We collapse it into the earliest join + latest
 * leave timestamps so the merged participants[] is comparable to what the
 * Workspace Events / chrome-extension paths produce.
 */
function participantToRow(p: RecallParticipant): StoredParticipantRow {
  const joins = (p.events || []).filter((e) => /join/i.test(e.code)).map((e) => e.created_at)
  const leaves = (p.events || []).filter((e) => /leave/i.test(e.code)).map((e) => e.created_at)
  joins.sort()
  leaves.sort()
  return {
    email: p.extra_data?.email ?? p.extra_data?.user_id ?? null,
    displayName: p.name ?? null,
    isHost: !!p.is_host,
    joinTime: joins[0],
    leaveTime: leaves[leaves.length - 1],
    source: 'recall',
    recallParticipantId: p.id,
  }
}

/**
 * Handle the Recall bot's "now recording" event. First time we see it for
 * this meeting we set actualStart and fire meeting_started.
 */
export async function handleBotInCallRecording(
  meetingId: string,
  occurredAt: Date,
): Promise<void> {
  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    select: { id: true, sessionId: true, actualStart: true },
  })
  if (!meeting) {
    console.warn('[recall] in_call_recording for unknown meeting', meetingId)
    return
  }
  if (!meeting.actualStart) {
    await prisma.interviewMeeting.update({
      where: { id: meeting.id },
      data: { actualStart: occurredAt },
    })
  }
  const fired = await emitLifecycleOnce(
    meeting.id, meeting.sessionId, 'meeting_started', occurredAt,
    { event: 'bot.in_call_recording' },
  )
  if (fired) {
    await bumpSessionActivity(meeting.sessionId).catch(() => {})
  }
}

/**
 * Handle the bot finishing the call. Pulls the full participant list from
 * Recall to decide whether the candidate showed up; sets actualEnd; fires
 * meeting_ended (someone joined besides the host) or meeting_no_show
 * (only the bot + host in the room).
 *
 * Recording-ready is handled separately in handleBotDone since some
 * `call_ended` deliveries arrive before the recording artifact finalizes.
 *
 * No-show defense in depth (Shedrack Amadi 2026-05-27 incident): Recall's
 * participant list is sometimes empty or mislabels everyone as host when
 * polled milliseconds after bot.call_ended. We refuse to fire meeting_no_show
 * if ANY of these prove the candidate actually attended:
 *   1. occurredAt < scheduledEnd (port of the c47d752 chrome-ext gate;
 *      bot.call_ended can fire when the host leaves first, mid-interview).
 *   2. InterviewMeeting.participants[] already has a non-host with a
 *      joinTime (chrome-ext snapshot or earlier Meet API sync saw them).
 *   3. An attendance_uploaded SchedulingEvent with participantCount > 1
 *      exists (chrome ext saw multiple humans in the room at some point).
 * In any of those cases we emit meeting_ended instead.
 */
export async function handleBotCallEnded(
  meetingId: string,
  botId: string,
  occurredAt: Date,
): Promise<void> {
  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true, sessionId: true, workspaceId: true,
      actualEnd: true, participants: true,
      scheduledStart: true, scheduledEnd: true,
    },
  })
  if (!meeting) {
    console.warn('[recall] call_ended for unknown meeting', meetingId)
    return
  }

  let participants: RecallParticipant[] = []
  try {
    participants = await listBotParticipants(botId)
  } catch (err) {
    console.error('[recall] listBotParticipants failed for', botId, ':', (err as Error).message)
  }
  // Recall counts the bot itself as a participant — strip it out so the
  // "anyone besides host present?" check is honest.
  const realParticipants = participants.filter((p) => !/^Interview Notes$|^Meeting Notetaker$/i.test(p.name || ''))
  const rows = realParticipants.map(participantToRow)
  const nonHostPresentFromRecall = rows.some((r) => !r.isHost && (r.joinTime || r.leaveTime))

  // Merge Recall's snapshot into the stored participants[] WITHOUT clobbering
  // a richer snapshot that the chrome ext / Meet API sync may have already
  // written. If Recall returned nothing, keep what we have.
  const updateData: { actualEnd: Date; participants?: object } = {
    actualEnd: meeting.actualEnd ?? occurredAt,
  }
  if (rows.length > 0) {
    updateData.participants = rows as unknown as object
  }
  await prisma.interviewMeeting.update({
    where: { id: meeting.id },
    data: updateData,
  })

  // Defense-in-depth: even if Recall says no non-host, trust earlier signals.
  let nonHostPresent = nonHostPresentFromRecall
  let attendedSource: string | null = nonHostPresentFromRecall ? 'recall' : null

  if (!nonHostPresent) {
    const stored = Array.isArray(meeting.participants) ? (meeting.participants as unknown as StoredParticipantRow[]) : []
    const storedNonHost = stored.some((r) => r && !r.isHost && (r.joinTime || r.leaveTime))
    if (storedNonHost) {
      nonHostPresent = true
      attendedSource = 'stored_participants'
    }
  }

  if (!nonHostPresent) {
    const attendanceEvent = await prisma.schedulingEvent.findFirst({
      where: {
        sessionId: meeting.sessionId,
        eventType: 'attendance_uploaded',
        metadata: { path: ['interviewMeetingId'], equals: meeting.id },
      },
      orderBy: { eventAt: 'desc' },
      select: { metadata: true },
    })
    const pc = (attendanceEvent?.metadata as { participantCount?: number } | null)?.participantCount
    if (typeof pc === 'number' && pc > 1) {
      nonHostPresent = true
      attendedSource = 'attendance_uploaded_event'
    }
  }

  if (nonHostPresent) {
    const fired = await emitLifecycleOnce(
      meeting.id, meeting.sessionId, 'meeting_ended', occurredAt,
      { event: 'bot.call_ended', attendedSource },
    )
    if (fired) await bumpSessionActivity(meeting.sessionId).catch(() => {})
    return
  }

  // Premature gate: Recall's bot.call_ended can fire BEFORE scheduledEnd if
  // the host leaves first or wraps up the bot early. The chrome-ext path
  // hardened this in c47d752; mirror it here. Drop the verdict silently —
  // the cron stalled-detector will still catch true no-shows after the
  // scheduledEnd + grace window.
  if (meeting.scheduledEnd && occurredAt < meeting.scheduledEnd) {
    console.warn(
      `[recall] suppressed premature meeting_no_show for ${meeting.id}: ` +
      `occurredAt=${occurredAt.toISOString()} < scheduledEnd=${meeting.scheduledEnd.toISOString()}`,
    )
    return
  }

  await emitLifecycleOnce(
    meeting.id, meeting.sessionId, 'meeting_no_show', occurredAt,
    { event: 'bot.call_ended', nonHostCount: 0 },
  )
}

/**
 * Handle bot.done — the recording is finalized and downloadable. Persist
 * the recording id on the meeting + write an artifact row, then fire
 * recording_ready so any waiting automations dispatch.
 */
export async function handleBotDone(meetingId: string, botId: string, occurredAt: Date): Promise<void> {
  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    select: { id: true, sessionId: true, recordingState: true, recallRecordingId: true },
  })
  if (!meeting) {
    console.warn('[recall] bot.done for unknown meeting', meetingId)
    return
  }
  let bot: Awaited<ReturnType<typeof getBot>> | null = null
  try {
    bot = await getBot(botId)
  } catch (err) {
    console.error('[recall] getBot failed in done handler', botId, ':', (err as Error).message)
  }
  const recording = bot?.recordings?.[0]
  if (!recording) {
    console.warn('[recall] bot.done with no recordings array for', botId)
    return
  }

  await prisma.interviewMeeting.update({
    where: { id: meeting.id },
    data: {
      recordingState: 'ready',
      recallRecordingId: recording.id,
    },
  })
  await recordArtifact(meeting.id, 'recording', {
    driveFileId: `recall:${recording.id}`,
    fileName: bot?.bot_name ?? 'Interview Notes',
    meetSpaceName: `recall:${botId}`,
    driveCreatedTime: recording.completed_at ? new Date(recording.completed_at) : occurredAt,
  }).catch((err) => console.warn('[recall] recordArtifact failed:', (err as Error).message))

  if (meeting.recordingState !== 'ready') {
    await fireMeetingLifecycleAutomations(meeting.sessionId, 'recording_ready').catch((err) =>
      console.error('[recall] recording_ready automations failed:', err),
    )
  }
}

/**
 * Generic dispatcher — picks the right handler based on the Recall event
 * code. Webhook route calls this once per delivery.
 */
export async function dispatchRecallEvent(input: {
  event: string
  meetingId: string
  botId: string
  occurredAt: Date
}): Promise<void> {
  switch (input.event) {
    case 'bot.in_call_recording':
      await handleBotInCallRecording(input.meetingId, input.occurredAt)
      return
    case 'bot.call_ended':
      await handleBotCallEnded(input.meetingId, input.botId, input.occurredAt)
      return
    case 'bot.done':
      await handleBotDone(input.meetingId, input.botId, input.occurredAt)
      return
    case 'bot.fatal':
    case 'bot.recording_permission_denied': {
      // Don't fire lifecycle — leave room for the legacy chrome-ext path to
      // catch attendance if the workspace still has it installed. But do
      // record an audit event so recruiters can see why the recording
      // doesn't exist.
      const m = await prisma.interviewMeeting.findUnique({
        where: { id: input.meetingId },
        select: { sessionId: true },
      })
      if (m) {
        await logSchedulingEvent({
          sessionId: m.sessionId,
          eventType: 'recall_bot_failed',
          metadata: { interviewMeetingId: input.meetingId, event: input.event, at: input.occurredAt.toISOString() },
        }).catch(() => {})
      }
      return
    }
    default:
      // Other status changes (joining_call / in_waiting_room / etc.) we just
      // ignore — they're for observability, not state transitions.
      return
  }
}
