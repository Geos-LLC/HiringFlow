/**
 * Translate Recall.ai bot lifecycle events into our existing
 * InterviewMeeting + SchedulingEvent + InterviewMeetingArtifact writes.
 *
 * Source-of-truth contract: the SAME lifecycle events that the Meet
 * Workspace Events webhook emits (meeting_started / meeting_ended /
 * meeting_no_show / recording_ready) are fired here when the equivalent
 * Recall event arrives. Downstream automation rules don't need to know
 * whether the signal came from Meet or Recall — they just trigger off the
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
import { emitAutomationEvent, eventKeys } from '../automation-emit'
import { bumpSessionProgress } from '../session-activity'
import { recordArtifact } from '../meet/artifacts'
import { reconcileFalseNoShow } from '../meet/reconcile-no-show'
import { getBot, listBotParticipants, type RecallParticipant } from './client'

/**
 * Idempotently emit a meeting lifecycle event + run automations. Dedupes
 * by (sessionId, eventType, metadata.interviewMeetingId) against any prior
 * Workspace Events / sync-on-read emission for the same meeting.
 */
async function emitLifecycleOnce(
  interviewMeetingId: string,
  sessionId: string,
  eventType: 'meeting_started' | 'meeting_ended' | 'meeting_no_show' | 'recording_ready',
  at: Date,
  extra: Record<string, unknown>,
): Promise<boolean> {
  // SchedulingEvent dedup remains as the timeline-row guard (only one
  // "meeting_started" row per interview shows up in the candidate's
  // scheduling history). Automation dispatch dedup now lives in
  // AutomationEvent — see emitAutomationEvent below.
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
  // workspaceId comes off the meeting (always set for valid rows). Without
  // it the AutomationEvent insert can't form its (workspaceId, eventKey)
  // unique key — we fall through to fire-and-forget in the (rare) case
  // the lookup fails, matching the prior behaviour.
  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: interviewMeetingId },
    select: { workspaceId: true },
  })
  if (!meeting) {
    await fireMeetingLifecycleAutomations(sessionId, eventType).catch((err) =>
      console.error(`[recall] ${eventType} automations failed (no meeting):`, err),
    )
    return true
  }
  const eventKey =
    eventType === 'meeting_started' ? eventKeys.meetingStarted(interviewMeetingId)
    : eventType === 'meeting_ended' ? eventKeys.meetingEnded(interviewMeetingId)
    : eventType === 'meeting_no_show' ? eventKeys.meetingNoShow(interviewMeetingId)
    : eventKeys.recordingReadyMeet(interviewMeetingId)
  await emitAutomationEvent({
    workspaceId: meeting.workspaceId,
    sessionId,
    triggerType: eventType,
    eventKey,
    source: 'webhook',
    payload: { interviewMeetingId, at: at.toISOString(), source: 'recall', ...extra },
    dispatch: () => fireMeetingLifecycleAutomations(sessionId, eventType),
  }).catch((err) => console.error(`[recall] ${eventType} emit failed:`, err))
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
 * Workspace Events path produces.
 */
function participantToRow(p: RecallParticipant): StoredParticipantRow {
  const joins = (p.events || []).filter((e) => /join/i.test(e.code)).map((e) => e.created_at)
  const leaves = (p.events || []).filter((e) => /leave/i.test(e.code)).map((e) => e.created_at)
  joins.sort()
  leaves.sort()
  return {
    // The participants_download_url endpoint exposes email at the top level;
    // the legacy in-call streaming endpoint nested it under extra_data. Read
    // both so this works regardless of which Recall API returned the row.
    email: p.email ?? p.extra_data?.email ?? p.extra_data?.user_id ?? null,
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
    await bumpSessionProgress(meeting.sessionId).catch(() => {})
  }
}

/**
 * Handle the bot finishing the call. Emit ONE definitive attendance signal
 * per meeting (meeting_ended or meeting_no_show) — never fire-then-revert.
 *
 * Decision matrix:
 *   - Recall returned a non-empty participant list showing a non-host present
 *     → meeting_ended (attended, proven). Fire + write actualEnd.
 *   - Recall returned a non-empty participant list showing host-only
 *     → meeting_no_show (confirmed no-show). Fire + write actualEnd.
 *   - Recall returned NO participant data AND stored participants[] has no
 *     non-host AND recording-duration fallback couldn't confirm attendance
 *     → DEFER. Do NOT write actualEnd, do NOT fire any lifecycle event.
 *     Log a `meeting_attendance_pending` audit event and return.
 *     bot.done (arriving ~seconds later when a recording exists) will fire
 *     meeting_ended. The reconcile-automations cron (Rule 4, 30min grace)
 *     is the final safety net if bot.done never comes.
 *
 * Why defer instead of guess:
 *   - Recall's `/bot/{id}/participants/` endpoint has an in-the-wild race
 *     where it returns an empty list when polled milliseconds after
 *     bot.call_ended even though the candidate clearly attended (recording
 *     shows up a few seconds later via bot.done).
 *   - The old code fired meeting_no_show eagerly on empty data, then
 *     `reconcileFalseNoShow` reverted from bot.done. This produced a
 *     "no-show → reverted" flip on every candidate's timeline and a
 *     transient `status='lost' + automationsHaltedAt` window that raced
 *     the "after meeting" automation dispatch.
 *   - Deferring means the candidate sees ONE clean event, the halt/revert
 *     dance goes away, and downstream automations dispatch off a stable
 *     lifecycle signal instead of a reverted one.
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
  // Presence in the participants list = they joined. Don't require a
  // join/leave timestamp — the participants_download_url Recall now exposes
  // doesn't include the events array, so requiring joinTime here would
  // never match a non-host even when one was clearly present.
  const nonHostPresentFromRecall = rows.some((r) => !r.isHost)
  const recallReturnedData = rows.length > 0

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

  // Recording-duration fallback (Alyona Rybachenko 2026-05-29): when
  // Recall's participants endpoint 404s AND there's no Workspace Events
  // Meet API snapshot (personal Gmail workspaces), a non-trivial recording
  // duration is our best remaining signal that a candidate was present —
  // BUT only safe to apply once we know the meeting played out to its
  // scheduled end. Premature ends are filtered further down for that reason.
  //
  // Skip when Recall returned actual data showing host-only: a long
  // recording with only the host in the room is just the recruiter waiting,
  // not the candidate attending — fire meeting_no_show instead of falsely
  // marking meeting_ended.
  let recordingFallbackReason: string | null = null
  if (!nonHostPresent && !recallReturnedData) {
    try {
      const bot = await getBot(botId)
      const rec = bot?.recordings?.[0]
      if (rec?.started_at && rec?.completed_at) {
        const durMs = new Date(rec.completed_at).getTime() - new Date(rec.started_at).getTime()
        if (durMs >= 2 * 60 * 1000) {
          nonHostPresent = true
          attendedSource = `recording_duration_${Math.round(durMs / 1000)}s`
          recordingFallbackReason = attendedSource
        }
      }
    } catch (err) {
      console.error('[recall] recording-duration fallback getBot failed for', botId, ':', (err as Error).message)
    }
  }

  // Defer decision when Recall's data is inconclusive. See function docstring
  // for the full rationale. Two conditions must BOTH hold to defer:
  //   1. We couldn't prove non-host presence from any signal (Recall
  //      participants, stored participants, or recording-duration fallback).
  //   2. Recall itself returned no participant data — the endpoint may have
  //      raced the bot's finalize step and we should wait for bot.done.
  //
  // When Recall returned definitive host-only data (Ekaterine 2026-06-08),
  // we DO fire meeting_no_show immediately — that's not a race, that's a
  // confirmed absence.
  if (!nonHostPresent && !recallReturnedData) {
    await logSchedulingEvent({
      sessionId: meeting.sessionId,
      eventType: 'meeting_attendance_pending',
      metadata: {
        interviewMeetingId: meeting.id,
        source: 'recall',
        event: 'bot.call_ended',
        at: occurredAt.toISOString(),
        reason: 'recall_participants_empty',
      },
    }).catch((err) =>
      console.error('[recall] logSchedulingEvent(meeting_attendance_pending) failed:', (err as Error).message),
    )
    console.warn(
      `[recall] deferred attendance decision for ${meeting.id}: ` +
      `occurredAt=${occurredAt.toISOString()} scheduledEnd=${meeting.scheduledEnd?.toISOString() ?? '?'} ` +
      `(Recall returned no participant data — waiting for bot.done / cron)`,
    )
    // Don't touch actualEnd — the lifecycle middleware fires on that write
    // and would emit meeting_ended for a meeting we haven't classified. If
    // bot.done arrives with a recording, it will resolve to meeting_ended.
    // If nothing arrives, the reconcile-automations cron (Rule 4) picks it
    // up after MEETING_ENDED_RECOVERY_GRACE_MS (30 min).
    return
  }

  // ORDER MATTERS. For the no-show branch we MUST write the
  // meeting_no_show SchedulingEvent BEFORE the InterviewMeeting.actualEnd
  // update — the lifecycle middleware fires on the actualEnd write and
  // reads the SchedulingEvent table to decide whether to skip meeting_ended.
  // If we wrote actualEnd first, the middleware would fire meeting_ended
  // and race the meeting_no_show emit, sending the "after meeting" email
  // to a candidate who never joined.
  const eventType: 'meeting_ended' | 'meeting_no_show' =
    nonHostPresent ? 'meeting_ended' : 'meeting_no_show'
  const extra: Record<string, unknown> = { event: 'bot.call_ended' }
  if (eventType === 'meeting_ended') extra.attendedSource = attendedSource
  else extra.nonHostCount = 0
  if (recordingFallbackReason) extra.attendedSource = recordingFallbackReason

  const fired = await emitLifecycleOnce(
    meeting.id, meeting.sessionId, eventType, occurredAt, extra,
  )

  // Merge Recall's snapshot into the stored participants[] WITHOUT clobbering
  // a richer snapshot that the Workspace Events Meet API sync may have already
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

  if (fired && eventType === 'meeting_ended') {
    await bumpSessionProgress(meeting.sessionId).catch(() => {})
  }
}

/**
 * Handle bot.done — the recording is finalized and downloadable. This is
 * ALSO the definitive attendance signal for meetings that handleBotCallEnded
 * deferred (Recall's participants API returned empty at bot.call_ended time).
 * The presence of a finalized recording proves the meeting happened, so we
 * write actualEnd + fire meeting_ended if no lifecycle event has fired yet.
 *
 * Ordering: fire meeting_ended BEFORE the actualEnd write so the lifecycle
 * middleware's SchedulingEvent check finds the row and skips its own emit —
 * same invariant handleBotCallEnded relies on.
 */
export async function handleBotDone(meetingId: string, botId: string, occurredAt: Date): Promise<void> {
  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true, sessionId: true, workspaceId: true,
      recordingState: true, recallRecordingId: true,
      actualEnd: true,
    },
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

  // Resolve any deferred attendance decision from handleBotCallEnded. If
  // actualEnd is still null AND no lifecycle event has fired yet, we now
  // have to classify the meeting. Re-poll participants (Recall's endpoint
  // is usually reliable by the time bot.done fires) and pick meeting_ended
  // or meeting_no_show. Emit BEFORE writing actualEnd so the lifecycle
  // middleware's no-op check sees the SchedulingEvent.
  const recordingCompletedAt = recording.completed_at ? new Date(recording.completed_at) : occurredAt
  let resolvedParticipantRows: StoredParticipantRow[] | null = null
  if (!meeting.actualEnd) {
    const alreadyClassified = await prisma.schedulingEvent.findFirst({
      where: {
        sessionId: meeting.sessionId,
        eventType: { in: ['meeting_ended', 'meeting_no_show'] },
        metadata: { path: ['interviewMeetingId'], equals: meeting.id },
      },
      select: { id: true },
    })
    if (!alreadyClassified) {
      let laterParticipants: RecallParticipant[] = []
      try {
        laterParticipants = await listBotParticipants(botId)
      } catch (err) {
        console.error('[recall] listBotParticipants failed in done handler for', botId, ':', (err as Error).message)
      }
      const realLater = laterParticipants.filter((p) => !/^Interview Notes$|^Meeting Notetaker$/i.test(p.name || ''))
      resolvedParticipantRows = realLater.map(participantToRow)
      const nonHostPresent = resolvedParticipantRows.some((r) => !r.isHost)
      // If Recall still returns nothing, use the recording duration as a
      // heuristic. A ≥2min recording without a definitive host-only signal
      // is treated as attended — matches the fallback in handleBotCallEnded.
      // Anything shorter with no participant data → no-show.
      let resolvedType: 'meeting_ended' | 'meeting_no_show'
      let attendedSource: string
      if (resolvedParticipantRows.length > 0) {
        resolvedType = nonHostPresent ? 'meeting_ended' : 'meeting_no_show'
        attendedSource = nonHostPresent ? 'participants_at_done' : 'host_only_at_done'
      } else if (recording.started_at && recording.completed_at) {
        const durMs = new Date(recording.completed_at).getTime() - new Date(recording.started_at).getTime()
        if (durMs >= 2 * 60 * 1000) {
          resolvedType = 'meeting_ended'
          attendedSource = `recording_duration_${Math.round(durMs / 1000)}s`
        } else {
          resolvedType = 'meeting_no_show'
          attendedSource = `short_recording_${Math.round(durMs / 1000)}s`
        }
      } else {
        // No participant data, no recording timing — safest default is
        // meeting_ended (recording exists at all). Cron already assumes
        // attended for actualStart-without-actualEnd anyway.
        resolvedType = 'meeting_ended'
        attendedSource = 'default_recording_exists'
      }
      await emitLifecycleOnce(
        meeting.id, meeting.sessionId, resolvedType, recordingCompletedAt,
        { event: 'bot.done', attendedSource },
      )
      if (resolvedType === 'meeting_ended') {
        await bumpSessionProgress(meeting.sessionId).catch(() => {})
      }
    }
  }

  await prisma.interviewMeeting.update({
    where: { id: meeting.id },
    data: {
      recordingState: 'ready',
      recallRecordingId: recording.id,
      // Backfill actualEnd for deferred meetings. Use recording.completed_at
      // as the truthful "when did the call actually end" timestamp; falls
      // back to bot.done's occurredAt if Recall didn't include it.
      ...(meeting.actualEnd ? {} : { actualEnd: recordingCompletedAt }),
      // If we re-fetched participants during deferral resolution and got a
      // richer snapshot than what's stored, persist it. Otherwise leave the
      // existing participants[] untouched.
      ...(resolvedParticipantRows && resolvedParticipantRows.length > 0
        ? { participants: resolvedParticipantRows as unknown as object }
        : {}),
    },
  })
  await recordArtifact(meeting.id, 'recording', {
    driveFileId: `recall:${recording.id}`,
    fileName: bot?.bot_name ?? 'Interview Notes',
    meetSpaceName: `recall:${botId}`,
    driveCreatedTime: recording.completed_at ? new Date(recording.completed_at) : occurredAt,
  }).catch((err) => console.warn('[recall] recordArtifact failed:', (err as Error).message))

  // Legacy revert path: kept as a defense-in-depth guard for cases where a
  // no-show fired via sync-on-read / Meet webhook before this bot.done
  // arrived. With handleBotCallEnded now deferring instead of eagerly
  // firing, the common Recall path shouldn't produce a revert anymore.
  await reconcileFalseNoShow(meeting.id, 'recall_bot_done').catch((err) =>
    console.error('[recall] reconcileFalseNoShow failed:', (err as Error).message))

  if (meeting.recordingState !== 'ready') {
    await emitAutomationEvent({
      workspaceId: meeting.workspaceId,
      sessionId: meeting.sessionId,
      triggerType: 'recording_ready',
      eventKey: eventKeys.recordingReadyMeet(meeting.id),
      source: 'webhook',
      payload: { interviewMeetingId: meeting.id, source: 'recall', recordingId: recording.id },
      dispatch: () => fireMeetingLifecycleAutomations(meeting.sessionId, 'recording_ready'),
    }).catch((err) => console.error('[recall] recording_ready emit failed:', err))
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
      // Record the audit event either way.
      const m = await prisma.interviewMeeting.findUnique({
        where: { id: input.meetingId },
        select: { id: true, sessionId: true, actualEnd: true },
      })
      if (!m) return
      await logSchedulingEvent({
        sessionId: m.sessionId,
        eventType: 'recall_bot_failed',
        metadata: { interviewMeetingId: input.meetingId, event: input.event, at: input.occurredAt.toISOString() },
      }).catch(() => {})
      // If handleBotCallEnded deferred the attendance decision and bot.done
      // is never coming (because the bot crashed / lost recording perms),
      // resolve to meeting_no_show now. Without this the deferred meeting
      // sits in limbo until the reconcile-automations cron defaults it to
      // meeting_ended after 30 min — wrong for a crashed bot with no proof
      // of attendance. Workspace-plan customers still have the sync-on-read
      // Drive-artifact fallback, which flips through reconcileFalseNoShow if
      // a late recording lands.
      if (!m.actualEnd) {
        const alreadyClassified = await prisma.schedulingEvent.findFirst({
          where: {
            sessionId: m.sessionId,
            eventType: { in: ['meeting_ended', 'meeting_no_show'] },
            metadata: { path: ['interviewMeetingId'], equals: m.id },
          },
          select: { id: true },
        })
        if (!alreadyClassified) {
          await emitLifecycleOnce(
            m.id, m.sessionId, 'meeting_no_show', input.occurredAt,
            { event: input.event, reason: 'recall_bot_failed' },
          )
          await prisma.interviewMeeting.update({
            where: { id: m.id },
            data: { actualEnd: input.occurredAt },
          }).catch((err) => console.error('[recall] actualEnd write on bot.fatal failed:', (err as Error).message))
        }
      }
      return
    }
    default:
      // Other status changes (joining_call / in_waiting_room / etc.) we just
      // ignore — they're for observability, not state transitions.
      return
  }
}
