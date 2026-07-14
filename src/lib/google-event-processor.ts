/**
 * Shared logic for turning a Google Calendar event into HireFunnel state.
 *
 * Extracted from the webhook route so it can be reused by the manual
 * "Sync calendar now" backfill endpoint. Both call sites have identical
 * semantics: match the event to a session, log a SchedulingEvent of the
 * right type, update pipeline status, and (best-effort) adopt the Meet
 * space for v2 lifecycle events.
 */

import type { calendar_v3 } from 'googleapis'
import { google } from 'googleapis'
import { prisma } from './prisma'
import { logSchedulingEvent, updatePipelineStatus } from './scheduling'
import { fireMeetingScheduledAutomations, fireMeetingRescheduledAutomations, cancelBeforeMeetingReminders, cancelMeetingDependentFollowups, rescheduleBeforeMeetingReminders } from './automation'
import { emitAutomationEvent, eventKeys } from './automation-emit'
import { meetIntegrationEnabled } from './meet/feature-flag'
import { getSpaceByMeetingCode, parseMeetingCodeFromUrl, updateSpaceSettings } from './meet/google-meet'
import { subscribeSpace, deleteSubscription } from './meet/workspace-events'
import { archivePrimaryArtifacts } from './meet/artifacts'
import { getAuthedClientForWorkspace, hasMeetScopes } from './google'
import { resolveHostMembers, sendHostAssignmentInvites } from './scheduling/meeting-hosts'

export interface ProcessEventResult {
  matched: boolean
  eventType?: 'meeting_scheduled' | 'meeting_rescheduled' | 'meeting_cancelled'
  sessionId?: string
}

export async function processCalendarEvent(
  workspaceId: string,
  event: calendar_v3.Schema$Event,
): Promise<ProcessEventResult> {
  if (!event.id) return { matched: false }

  const sessionId = await matchSession(workspaceId, event)
  if (!sessionId) return { matched: false }

  const start = event.start?.dateTime || event.start?.date
  const end = event.end?.dateTime || event.end?.date
  const meetingUrl = event.hangoutLink || extractMeetingLink(event.location) || extractMeetingLink(event.description)

  if (event.status === 'cancelled') {
    // Soft-delete the InterviewMeeting row so it stops blocking FreeBusy
    // queries. Without this, a cancelled meeting kept tying up the slot
    // (see project_meeting_cancelled_phantom_busy memory).
    await prisma.interviewMeeting.updateMany({
      where: {
        workspaceId,
        googleCalendarEventId: event.id,
        cancelledAt: null,
      },
      data: { cancelledAt: new Date() },
    }).catch((err) => {
      console.error('[GCal] InterviewMeeting cancelledAt update failed:', err)
    })
    await logSchedulingEvent({
      sessionId,
      eventType: 'meeting_cancelled',
      metadata: { googleEventId: event.id, source: 'google_calendar' },
    })
    // Void any queued before_meeting reminders so the candidate doesn't get
    // a "your interview starts in 1h" email after the meeting was cancelled.
    await cancelBeforeMeetingReminders(sessionId).catch((err) => {
      console.error('[GCal] cancelBeforeMeetingReminders failed:', err)
    })
    // Also nuke queued post-booking follow-ups (meeting_scheduled /
    // meeting_rescheduled rules) — "thanks for booking" / "see you Friday"
    // is wrong if the meeting was cancelled.
    await cancelMeetingDependentFollowups(sessionId).catch((err) => {
      console.error('[GCal] cancelMeetingDependentFollowups failed:', err)
    })
    return { matched: true, eventType: 'meeting_cancelled', sessionId }
  }

  const existing = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId,
      eventType: { in: ['meeting_scheduled', 'meeting_rescheduled'] },
      metadata: { path: ['googleEventId'], equals: event.id },
    },
    orderBy: { eventAt: 'desc' },
  })

  // Google Calendar fires a watch notification for *any* change to an event
  // — RSVP status, Calendly metadata touches, internal field updates. Only
  // count it as a reschedule when start/end/meeting URL actually changed,
  // otherwise the candidate timeline fills up with phantom reschedule rows.
  //
  // Timestamp normalisation is critical here: bookInterview writes the
  // initial `meeting_scheduled` event with `start.toISOString()` (UTC `…Z`
  // form), while the watch webhook that fires ~4s later carries the same
  // moment in Google's RFC3339-with-offset form (e.g. `2026-05-20T10:00:00
  // -04:00`). Comparing those strings raw always reports "changed" even
  // though they're the same instant, so every fresh booking immediately
  // gets a phantom meeting_rescheduled row + fires reschedule automations.
  // Round-trip through Date.toISOString() to compare on instants.
  if (existing) {
    const prevMeta = (existing.metadata as Record<string, unknown> | null) || {}
    const prevStart = normaliseTimestamp(prevMeta.scheduledAt as string | null)
    const prevEnd = normaliseTimestamp(prevMeta.endAt as string | null)
    const prevUrl = (prevMeta.meetingUrl as string | null) ?? null
    const newStart = normaliseTimestamp(start)
    const newEnd = normaliseTimestamp(end)
    const unchanged =
      prevStart === newStart &&
      prevEnd === newEnd &&
      prevUrl === (meetingUrl || null)
    if (unchanged) {
      return { matched: true, eventType: 'meeting_scheduled', sessionId }
    }
  }

  const eventType = existing ? 'meeting_rescheduled' : 'meeting_scheduled'

  await logSchedulingEvent({
    sessionId,
    eventType,
    metadata: {
      scheduledAt: start || null,
      endAt: end || null,
      meetingUrl: meetingUrl || null,
      googleEventId: event.id,
      attendeeEmail: event.attendees?.find((a) => !a.self)?.email || null,
      source: 'google_calendar',
    },
  })

  if (eventType === 'meeting_scheduled') {
    await updatePipelineStatus(sessionId, 'scheduled').catch(() => {})
    // Adopt the Meet space FIRST so the InterviewMeeting row exists before
    // automations dispatch. Steps with timingMode='before_meeting' /
    // 'after_meeting' read scheduledStart off that row to compute their
    // fire time — without it they'd silently fall back to trigger semantics
    // and fire delayMinutes from now instead of relative to the meeting.
    await adoptExternalMeet(workspaceId, sessionId, event, start, end, meetingUrl).catch((err) => {
      console.error('[GCal] adoptExternalMeet failed (non-fatal):', (err as Error).message)
    })
    // The InterviewMeeting row that adoptExternalMeet just created/found is
    // the stable identity for dedup. Look it up by googleEventId (most
    // reliable across calendar updates).
    const meetingId = event.id
      ? (await prisma.interviewMeeting.findFirst({
          where: { workspaceId, sessionId, googleCalendarEventId: event.id },
          select: { id: true },
        }))?.id ?? null
      : null
    if (meetingId) {
      await emitAutomationEvent({
        workspaceId,
        sessionId,
        triggerType: 'meeting_scheduled',
        eventKey: eventKeys.meetingScheduled(meetingId),
        source: 'webhook',
        payload: { interviewMeetingId: meetingId, googleEventId: event.id, source: 'google_calendar' },
        dispatch: () => fireMeetingScheduledAutomations(sessionId),
      }).catch((err) => {
        console.error('[GCal] meeting_scheduled emit failed:', err)
      })
    } else {
      await fireMeetingScheduledAutomations(sessionId).catch((err) => {
        console.error('[GCal] fireMeetingScheduledAutomations failed:', err)
      })
    }
  } else if (eventType === 'meeting_rescheduled' && start) {
    // Re-key any pending before_meeting reminders to the new scheduledStart.
    await rescheduleBeforeMeetingReminders(sessionId, new Date(start)).catch((err) => {
      console.error('[GCal] rescheduleBeforeMeetingReminders failed:', err)
    })
    // Calendar's "regenerate Meet link" produces a new Meet space; re-bind
    // our InterviewMeeting + subscription + recording config to it. No-op if
    // the meeting code didn't change. Order matters — run this BEFORE
    // fireMeetingRescheduledAutomations so token rendering sees the new
    // InterviewMeeting.scheduledStart and meetingUri.
    await reconcileExternalMeetReschedule(workspaceId, event, start, end, meetingUrl).catch((err) => {
      console.error('[GCal] reconcileExternalMeetReschedule failed (non-fatal):', (err as Error).message)
    })
    // Look up the now-rebound InterviewMeeting for the dedup key. Same
    // (meetingId, newScheduledStartIso) shape — re-receiving the same
    // calendar update is a no-op, but a new time produces a new event.
    const meetingId = event.id
      ? (await prisma.interviewMeeting.findFirst({
          where: { workspaceId, sessionId, googleCalendarEventId: event.id },
          select: { id: true },
        }))?.id ?? null
      : null
    if (meetingId) {
      await emitAutomationEvent({
        workspaceId,
        sessionId,
        triggerType: 'meeting_rescheduled',
        eventKey: eventKeys.meetingRescheduled(meetingId, new Date(start).toISOString()),
        source: 'webhook',
        payload: { interviewMeetingId: meetingId, newScheduledStart: new Date(start).toISOString() },
        dispatch: () => fireMeetingRescheduledAutomations(sessionId),
      }).catch((err) => {
        console.error('[GCal] meeting_rescheduled emit failed:', err)
      })
    } else {
      await fireMeetingRescheduledAutomations(sessionId).catch((err) => {
        console.error('[GCal] fireMeetingRescheduledAutomations failed:', err)
      })
    }
  }

  return { matched: true, eventType, sessionId }
}

async function adoptExternalMeet(
  workspaceId: string,
  sessionId: string,
  event: calendar_v3.Schema$Event,
  start: string | null | undefined,
  end: string | null | undefined,
  meetingUrl: string | null,
): Promise<void> {
  if (!event.id || !start || !end) return
  const enabled = await meetIntegrationEnabled(workspaceId)
  if (!enabled) return

  const code = parseMeetingCodeFromUrl(meetingUrl || event.hangoutLink)
  if (!code) return

  const existing = await prisma.interviewMeeting.findUnique({ where: { googleCalendarEventId: event.id } })
  if (existing) return

  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) return
  if (!hasMeetScopes(authed.integration.grantedScopes)) return

  let space
  try {
    space = await getSpaceByMeetingCode(authed.client, code)
  } catch (err: unknown) {
    console.log('[AdoptMeet] spaces.get failed for code', code, (err as Error).message)
    return
  }

  // Calendly / direct calendar invites create the Meet space without recording
  // configured, and with Google's default accessType (usually OPEN or TRUSTED
  // depending on the account). Patch the space to:
  //   - recording ON when the workspace can record (matches in-app behavior)
  //   - accessType RESTRICTED so ONLY invited attendees can join without
  //     knocking. This lets outside-org team member hosts we're about to add
  //     as attendees join without the connected account having to admit them
  //     from the lobby.
  // Space settings are mutable until the first participant joins, so this
  // works as long as the calendar event lands ahead of meeting time.
  let recordingTurnedOn = space.config?.artifactConfig?.recordingConfig?.autoRecordingGeneration === 'ON'
  let transcriptionTurnedOn = space.config?.artifactConfig?.transcriptionConfig?.autoTranscriptionGeneration === 'ON'
  const wantAccessRestricted = space.config?.accessType !== 'RESTRICTED'
  const wantRecordingOn = authed.integration.recordingCapable && !recordingTurnedOn
  if (wantAccessRestricted || wantRecordingOn) {
    try {
      const updated = await updateSpaceSettings(authed.client, space.name, {
        ...(wantAccessRestricted ? { accessType: 'RESTRICTED' as const } : {}),
        ...(wantRecordingOn ? { autoRecording: 'ON' as const, autoTranscription: 'ON' as const } : {}),
      })
      recordingTurnedOn = updated.config?.artifactConfig?.recordingConfig?.autoRecordingGeneration === 'ON'
      transcriptionTurnedOn = updated.config?.artifactConfig?.transcriptionConfig?.autoTranscriptionGeneration === 'ON'
      console.log('[AdoptMeet] patched adopted space', space.name, {
        accessType: updated.config?.accessType,
        recording: recordingTurnedOn,
      })
    } catch (err) {
      // Non-fatal: meeting may already be in progress, or the API rejected
      // the patch. Fall through and persist with whatever settings the space
      // currently has.
      console.warn('[AdoptMeet] updateSpaceSettings failed:', (err as Error).message)
    }
  }

  // Resolve host team members from the workspace's default SchedulingConfig.
  // Calendly-created events don't carry a HF configId, so we fall back to
  // the workspace default. Empty when the workspace hasn't assigned anyone.
  let hostMembers: Awaited<ReturnType<typeof resolveHostMembers>> = []
  try {
    const defaultConfig = await prisma.schedulingConfig.findFirst({
      where: { workspaceId, isActive: true, isDefault: true },
      select: { assignedMemberIds: true },
    })
    if (defaultConfig?.assignedMemberIds?.length) {
      hostMembers = await resolveHostMembers(workspaceId, defaultConfig.assignedMemberIds)
    }
  } catch (err) {
    console.warn('[AdoptMeet] host lookup failed (non-fatal):', (err as Error).message)
  }

  // Patch the calendar event to include host team members as attendees so
  // Google fires them native invites/reminders and RESTRICTED lets them into
  // the Meet room. Preserve any attendees Calendly already put on the event
  // (the candidate, the Calendly organizer, etc.); de-dupe by email so we
  // don't double-invite.
  if (hostMembers.length > 0) {
    const existingAttendees = event.attendees ?? []
    const existingEmails = new Set(
      existingAttendees.map((a) => (a.email ?? '').toLowerCase()).filter(Boolean),
    )
    const additions = hostMembers
      .filter((h) => !existingEmails.has(h.email.toLowerCase()))
      .map((h) => ({ email: h.email, displayName: h.name ?? undefined }))
    if (additions.length > 0) {
      try {
        const calendar = google.calendar({ version: 'v3', auth: authed.client })
        await calendar.events.patch({
          calendarId: authed.integration.calendarId,
          eventId: event.id,
          sendUpdates: 'all',
          requestBody: {
            attendees: [...existingAttendees, ...additions],
          },
        })
        console.log('[AdoptMeet] added', additions.length, 'host attendees to', event.id)
      } catch (err) {
        console.warn('[AdoptMeet] events.patch(attendees) failed (non-fatal):', (err as Error).message)
      }
    }
  }

  let subName: string | null = null
  let subExpires: Date | null = null
  try {
    const sub = await subscribeSpace(authed.client, space.name)
    subName = sub.name
    subExpires = sub.expireTime ? new Date(sub.expireTime) : null
  } catch (err) {
    console.error('[AdoptMeet] subscribeSpace failed:', (err as Error).message)
  }

  const created = await prisma.interviewMeeting.create({
    data: {
      workspaceId,
      sessionId,
      meetSpaceName: space.name,
      meetingCode: space.meetingCode || code,
      meetingUri: space.meetingUri || meetingUrl || '',
      googleCalendarEventId: event.id,
      scheduledStart: new Date(start),
      scheduledEnd: new Date(end),
      recordingEnabled: recordingTurnedOn,
      recordingProvider: recordingTurnedOn ? 'google_meet' : null,
      recordingState: recordingTurnedOn ? 'requested' : 'disabled',
      transcriptState: transcriptionTurnedOn ? 'processing' : 'disabled',
      workspaceEventsSubName: subName,
      workspaceEventsSubExpiresAt: subExpires,
      hosts: hostMembers.length
        ? { create: hostMembers.map((h) => ({ workspaceMemberId: h.memberId })) }
        : undefined,
    },
  }).catch((err) => {
    console.log('[AdoptMeet] insert skipped (likely race):', (err as Error).message)
    return null as { id: string; meetingUri: string; scheduledStart: Date } | null
  })

  // HF-side host assignment notification (belt-and-suspenders alongside
  // Google's native calendar invite — Google's invite delivery is unreliable
  // when the calendar owner is on personal Gmail). Best-effort, non-fatal.
  if (created && created.id && hostMembers.length > 0) {
    await sendHostAssignmentInvites(created.id, hostMembers).catch((err) => {
      console.error('[AdoptMeet] sendHostAssignmentInvites failed:', (err as Error).message)
    })
  }

  // Recall.ai bot for adopted (Calendly-flavored) meetings — same gating as
  // bookInterview. Skips silently if the create above lost a race.
  if (created && created.id) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { recallBotEnabled: true },
    })
    if (workspace?.recallBotEnabled && process.env.RECALL_API_KEY) {
      try {
        const { scheduleBot } = await import('./recall/client')
        const bot = await scheduleBot({
          meetingUrl: created.meetingUri,
          joinAt: created.scheduledStart,
          metadata: { interviewMeetingId: created.id, workspaceId, sessionId },
        })
        await prisma.interviewMeeting.update({
          where: { id: created.id },
          data: {
            recallBotId: bot.id,
            attendanceSource: 'recall',
            recordingProvider: 'recall',
            recordingState: 'requested',
          },
        })
      } catch (err) {
        console.error('[AdoptMeet] recall scheduleBot failed:', (err as Error).message)
      }
    }
  }
}

async function matchSession(
  workspaceId: string,
  event: calendar_v3.Schema$Event,
): Promise<string | null> {
  const haystack = [event.description, event.summary, event.location].filter(Boolean).join(' ')
  const utm = haystack.match(/utm_content=([a-zA-Z0-9_-]+)/)
  if (utm) {
    const match = await prisma.session.findFirst({
      where: { id: utm[1], workspaceId },
      select: { id: true },
    })
    if (match) return match.id
  }

  // Skip:
  //  - Calendar resource accounts (rooms etc).
  //  - The organizer / self attendee — that's the workspace's connected
  //    Google account, NOT the candidate. Calendly puts the connected
  //    account on every event it creates. If the workspace owner has ever
  //    submitted a test application using their own Gmail (very common
  //    during onboarding), their email matches a candidateEmail in the
  //    workspace and EVERY Calendly booking gets misattributed to that
  //    test session — real candidates lose their meeting attribution.
  const attendeeEmails = (event.attendees || [])
    .filter((a) => !a.organizer && !a.self)
    .map((a) => a.email)
    .filter((e): e is string => !!e && !e.includes('calendar.google.com'))

  for (const email of attendeeEmails) {
    // Case-insensitive email match — Google preserves casing as entered, but
    // we want to match a candidate even if their session was registered with
    // mixed case.
    const match = await prisma.session.findFirst({
      where: { workspaceId, candidateEmail: { equals: email, mode: 'insensitive' } },
      select: { id: true },
      orderBy: { startedAt: 'desc' },
    })
    if (match) return match.id
  }

  return null
}

function extractMeetingLink(text: string | null | undefined): string | null {
  if (!text) return null
  const match = text.match(/https?:\/\/[^\s<>"']+(meet\.google\.com|zoom\.us|teams\.microsoft\.com|whereby\.com)[^\s<>"']*/i)
  return match ? match[0] : null
}

// Compare two timestamp strings as the same moment, regardless of whether
// one is RFC3339-with-offset (Google Calendar's `dateTime`) and the other
// is `toISOString()` UTC form. Returns null for absent/unparseable inputs
// so they compare equal to other null inputs.
function normaliseTimestamp(s: string | null | undefined): string | null {
  if (!s) return null
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

/**
 * Reschedule reconciliation: when a calendar event is updated and Google
 * regenerates the Meet link (different meeting code), our existing
 * InterviewMeeting row still references the old space — recording config we
 * patched, the Workspace Events subscription, and the Drive recording artifact
 * lookup all become useless. This function detects the URL change and
 * re-binds the row to the new space:
 *
 *   - Updates scheduledStart/scheduledEnd unconditionally (even on no-op URL).
 *   - When the meeting code differs:
 *       - Best-effort delete the old Workspace Events subscription.
 *       - Patches the new space to autoRecording=ON / autoTranscription=ON
 *         per the workspace's per-feature capability flags.
 *       - Subscribes to the new space.
 *       - Updates meetSpaceName/meetingCode/meetingUri/sub fields on the row
 *         and resets the recording state to 'requested' (or 'disabled').
 *
 * No-ops when the calendar event has no Meet link, when there is no existing
 * InterviewMeeting for the event, or when the meeting code is unchanged
 * (besides the scheduled-window update).
 */
async function reconcileExternalMeetReschedule(
  workspaceId: string,
  event: calendar_v3.Schema$Event,
  start: string | null | undefined,
  end: string | null | undefined,
  meetingUrl: string | null,
): Promise<void> {
  if (!event.id || !start || !end) return
  const existing = await prisma.interviewMeeting.findUnique({ where: { googleCalendarEventId: event.id } })
  if (!existing) return

  const newScheduledStart = new Date(start)
  const newScheduledEnd = new Date(end)
  const newCode = parseMeetingCodeFromUrl(meetingUrl || event.hangoutLink)

  // Same meeting code (or new event has no Meet link): only refresh the
  // scheduled window if it shifted.
  if (!newCode || newCode === existing.meetingCode) {
    if (
      existing.scheduledStart.getTime() !== newScheduledStart.getTime() ||
      existing.scheduledEnd.getTime() !== newScheduledEnd.getTime()
    ) {
      await prisma.interviewMeeting.update({
        where: { id: existing.id },
        data: { scheduledStart: newScheduledStart, scheduledEnd: newScheduledEnd },
      })
    }
    return
  }

  const enabled = await meetIntegrationEnabled(workspaceId)
  if (!enabled) return

  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) return
  if (!hasMeetScopes(authed.integration.grantedScopes)) return

  let newSpace
  try {
    newSpace = await getSpaceByMeetingCode(authed.client, newCode)
  } catch (err) {
    console.warn('[ReconcileReschedule] spaces.get failed for new code', newCode, (err as Error).message)
    return
  }

  // Best-effort delete the old subscription so we stop receiving (none) events
  // for a space we no longer care about. Failures are common (already expired,
  // or never created) and non-fatal.
  if (existing.workspaceEventsSubName) {
    try { await deleteSubscription(authed.client, existing.workspaceEventsSubName) }
    catch (err) { console.warn('[ReconcileReschedule] deleteSubscription (old) failed:', (err as Error).message) }
  }

  // Patch new space to ON for whatever the workspace can actually do.
  let recordingTurnedOn = newSpace.config?.artifactConfig?.recordingConfig?.autoRecordingGeneration === 'ON'
  let transcriptionTurnedOn = newSpace.config?.artifactConfig?.transcriptionConfig?.autoTranscriptionGeneration === 'ON'
  const wantRecording = authed.integration.recordingCapable === true && !recordingTurnedOn
  const wantTranscription = authed.integration.transcriptionCapable !== false && !transcriptionTurnedOn
  if (wantRecording || wantTranscription) {
    try {
      const patched = await updateSpaceSettings(authed.client, newSpace.name, {
        ...(wantRecording ? { autoRecording: 'ON' as const } : {}),
        ...(wantTranscription ? { autoTranscription: 'ON' as const } : {}),
      })
      recordingTurnedOn = patched.config?.artifactConfig?.recordingConfig?.autoRecordingGeneration === 'ON'
      transcriptionTurnedOn = patched.config?.artifactConfig?.transcriptionConfig?.autoTranscriptionGeneration === 'ON'
    } catch (err) {
      console.warn('[ReconcileReschedule] updateSpaceSettings (new) failed:', (err as Error).message)
    }
  }

  // Subscribe to the new space (best-effort).
  let subName: string | null = null
  let subExpires: Date | null = null
  try {
    const sub = await subscribeSpace(authed.client, newSpace.name)
    subName = sub.name
    subExpires = sub.expireTime ? new Date(sub.expireTime) : null
  } catch (err) {
    console.warn('[ReconcileReschedule] subscribeSpace (new) failed:', (err as Error).message)
  }

  // Archive any artifacts that were already pinned to the OLD space before
  // we wipe the primary pointers below. Without this step a recording made
  // on the old link would be orphaned — no row in the DB would reference it.
  // The child table preserves it with the old space tag so the candidate
  // detail UI can still list it.
  await archivePrimaryArtifacts(existing.id, {
    driveRecordingFileId: existing.driveRecordingFileId,
    driveTranscriptFileId: existing.driveTranscriptFileId,
    driveGeminiNotesFileId: existing.driveGeminiNotesFileId,
    meetSpaceName: existing.meetSpaceName,
  }).catch((err) => {
    console.warn('[ReconcileReschedule] archivePrimaryArtifacts failed (non-fatal):', (err as Error).message)
  })

  // Rebind the Recall.ai bot to the new Meet URL. The original bot was
  // configured against the OLD meeting_id and would otherwise wait out the
  // 20-min lobby timer in the dead space (see project_recall_reschedule_orphan).
  // We delete the old bot best-effort and schedule a fresh one; on any
  // failure we fall the row back to the 'meet' attendance source so the
  // Meet-native auto-record path still produces a recording.
  let nextRecallBotId: string | null = null
  let nextAttendanceSource: 'meet' | 'recall' = 'meet'
  let nextRecordingProvider: 'google_meet' | 'recall' | null = recordingTurnedOn ? 'google_meet' : null
  if (existing.recallBotId) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { recallBotEnabled: true },
    })
    if (workspace?.recallBotEnabled && process.env.RECALL_API_KEY) {
      const { deleteBot, scheduleBot } = await import('./recall/client')
      try { await deleteBot(existing.recallBotId) }
      catch (err) { console.warn('[ReconcileReschedule] deleteBot (old) failed:', (err as Error).message) }
      try {
        const bot = await scheduleBot({
          meetingUrl: newSpace.meetingUri || meetingUrl || '',
          joinAt: newScheduledStart,
          metadata: {
            interviewMeetingId: existing.id,
            workspaceId,
            sessionId: existing.sessionId,
          },
        })
        nextRecallBotId = bot.id
        nextAttendanceSource = 'recall'
        nextRecordingProvider = 'recall'
      } catch (err) {
        console.error('[ReconcileReschedule] scheduleBot (new) failed:', (err as Error).message)
      }
    }
  }

  await prisma.interviewMeeting.update({
    where: { id: existing.id },
    data: {
      meetSpaceName: newSpace.name,
      meetingCode: newSpace.meetingCode || newCode,
      meetingUri: newSpace.meetingUri || meetingUrl || '',
      scheduledStart: newScheduledStart,
      scheduledEnd: newScheduledEnd,
      recordingEnabled: recordingTurnedOn || nextRecordingProvider === 'recall',
      recordingProvider: nextRecordingProvider,
      recordingState: nextRecordingProvider ? 'requested' : 'disabled',
      transcriptState: transcriptionTurnedOn || nextRecordingProvider === 'recall' ? 'processing' : 'disabled',
      workspaceEventsSubName: subName,
      workspaceEventsSubExpiresAt: subExpires,
      spaceAdoptedFromReschedule: true,
      recallBotId: nextRecallBotId,
      attendanceSource: nextAttendanceSource,
      // Clear cached artifacts; they belonged to the old space / old bot.
      driveRecordingFileId: null,
      driveTranscriptFileId: null,
      driveGeminiNotesFileId: null,
      recallRecordingId: null,
      meetApiSyncedAt: null,
      actualStart: null,
      actualEnd: null,
      participants: undefined,
      rawEvents: undefined,
    },
  })
  console.log('[Meet] space adopted from reschedule', { meetingId: existing.id, oldSpace: existing.meetSpaceName, newSpace: newSpace.name })
}
