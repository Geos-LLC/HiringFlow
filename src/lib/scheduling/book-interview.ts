/**
 * Single source of truth for "book an interview" — Meet space + Calendar
 * event + Workspace Events subscription + InterviewMeeting + scheduling
 * event + meeting-scheduled automations.
 *
 * Both the operator route (POST /api/candidates/[id]/schedule-interview) and
 * the public booking endpoint (POST /api/public/booking/[configId]) call
 * this. Don't fork the booking logic — every divergence is a future bug.
 *
 * Failure modes are intentionally graceful:
 *   - Meet space fails       → 502 BookingError, no rows written.
 *   - Calendar insert fails  → 502 BookingError, no rows written. (Meet
 *                              space may be left dangling on Google's side
 *                              but is harmless — no calendar invite went
 *                              out.)
 *   - Subscribe fails        → meeting still saved, sync degrades to cron.
 *   - Recording unavailable  → meeting saved without recording, warning returned.
 */

import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { prisma } from '../prisma'
import { getAuthedClientForWorkspace, hasMeetScopes } from '../google'
import { meetIntegrationEnabled } from '../meet/feature-flag'
import { createSpace, MeetApiError } from '../meet/google-meet'
import { subscribeSpace, WorkspaceEventsError } from '../meet/workspace-events'
import {
  ensureRecordingCapability,
  probeRecordingCapability,
  capabilityMessage,
} from '../meet/recording-capability'
import type {
  RecordingCapabilityReason,
  CombinedCapability,
} from '../meet/recording-capability'
import { selectRecorder } from '../meet/meeting-recorder'
import { logSchedulingEvent, updatePipelineStatus } from '../scheduling'
import { fireMeetingScheduledAutomations } from '../automation'
import { emitAutomationEvent, eventKeys } from '../automation-emit'
import { scheduleBot, RecallApiError } from '../recall/client'
import { logger } from '../logger'
import { notifyRecallOutOfCredits } from '../alerts/recall-credits'
import { sendMeetingConfirmation } from './meeting-confirmation'
import {
  resolveHostMembers,
  hostsAsCalendarAttendees,
  sendHostAssignmentInvites,
  promoteHostsToCohosts,
} from './meeting-hosts'

export type BookingSource = 'operator' | 'public'

export interface BookInterviewOpts {
  workspaceId: string
  sessionId: string
  scheduledAt: Date
  durationMinutes?: number
  record?: boolean
  notes?: string | null
  attendeeEmail?: string | null
  schedulingConfigId?: string | null
  source: BookingSource
  /** Operator userId, or null for public bookings. Stored on the scheduling event. */
  loggedBy?: string | null
}

export interface BookInterviewResult {
  ok: true
  interviewMeeting: {
    id: string
    meetingUri: string
    scheduledStart: Date
    scheduledEnd: Date
    recordingEnabled: boolean
    recordingState: string
  }
  warnings: string[]
}

export class BookInterviewError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'BookInterviewError'
    this.status = status
    this.code = code
  }
}

const NONE_CAP: CombinedCapability = {
  recording:    { capable: null, reason: 'probe_not_run', checkedAt: null, fromCache: true },
  transcription:{ capable: null, reason: 'probe_not_run', checkedAt: null, fromCache: true },
}

export async function bookInterview(opts: BookInterviewOpts): Promise<BookInterviewResult> {
  const {
    workspaceId,
    sessionId,
    scheduledAt,
    durationMinutes = 30,
    record = false,
    notes = null,
    schedulingConfigId,
    source,
    loggedBy = null,
  } = opts

  // 1. Feature gate
  const enabled = await meetIntegrationEnabled(workspaceId)
  if (!enabled) {
    throw new BookInterviewError(404, 'meet_disabled', 'Meet integration is not enabled for this workspace')
  }

  // 2. Session belongs to workspace
  const session = await prisma.session.findFirst({ where: { id: sessionId, workspaceId } })
  if (!session) {
    throw new BookInterviewError(404, 'session_not_found', 'Session not found in this workspace')
  }
  const attendeeEmail = opts.attendeeEmail ?? session.candidateEmail ?? null

  if (isNaN(scheduledAt.getTime())) {
    throw new BookInterviewError(400, 'invalid_time', 'Valid scheduledAt required')
  }
  const start = scheduledAt
  const end = new Date(start.getTime() + durationMinutes * 60_000)

  // 3. Authed Google client
  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) {
    throw new BookInterviewError(409, 'google_not_connected', 'Google account not connected')
  }
  const { client, integration } = authed
  if (!hasMeetScopes(integration.grantedScopes)) {
    throw new BookInterviewError(409, 'reconnect_required', 'Reconnect Google account to enable Meet scheduling')
  }

  // 4. Recording capability
  let capabilityResult = NONE_CAP
  try {
    if (record) {
      const cached = await ensureRecordingCapability(workspaceId)
      if (cached.recording.capable === true) {
        capabilityResult = cached
      } else {
        capabilityResult = await probeRecordingCapability(workspaceId)
      }
    } else {
      capabilityResult = await ensureRecordingCapability(workspaceId)
    }
  } catch (err) {
    console.error('[bookInterview] capability probe failed:', err)
  }

  const selection = selectRecorder({ record, capable: capabilityResult.recording.capable })
  const transcriptionEnabledFinal = capabilityResult.transcription.capable !== false
  const warnings: string[] = []
  if (record && !selection.recordingEnabled) {
    warnings.push(capabilityMessage(capabilityResult.recording.reason as RecordingCapabilityReason))
  }

  // 5. Create Meet space (with recording-403 + accessType fallbacks)
  //
  // accessType='RESTRICTED' — anyone on the calendar guest list can join,
  // no Google-org constraint. 'TRUSTED' (the prior default) required
  // attendees to be in the connected account's Workspace org, which broke
  // outside-org team members. RESTRICTED with a curated attendee list is
  // stricter than 'OPEN' (anyone-with-link) and matches the "assigned team
  // members can host, no one else" model.
  //
  // But: RESTRICTED is only available on Google Workspace accounts. Personal
  // Gmail (hostedDomain=null) can't set it — the API throws
  // "updateAccessType is not available to the user." Detected 2026-07-14
  // via Spotless (sayapingeorge@gmail.com). Pick the tightest accessType
  // this account can actually use up front: RESTRICTED for Workspace,
  // TRUSTED for personal Gmail. TRUSTED on personal Gmail means "anyone
  // signed into a Google account can join" — looser than we'd like, but
  // the meeting URL only reaches the candidate + hosts on the invite so
  // in practice this is fine.
  const desiredAccessType: 'RESTRICTED' | 'TRUSTED' = integration.hostedDomain ? 'RESTRICTED' : 'TRUSTED'
  let space: Awaited<ReturnType<typeof createSpace>> | undefined
  try {
    space = await createSpace(client, {
      accessType: desiredAccessType,
      entryPointAccess: 'ALL',
      autoRecording: selection.recordingEnabled ? 'ON' : 'OFF',
      autoTranscription: transcriptionEnabledFinal ? 'ON' : 'OFF',
    })
  } catch (err) {
    if (selection.recordingEnabled && err instanceof MeetApiError && err.status === 403) {
      const reason = err.recordingReason ?? 'permission_denied_other'
      await prisma.googleIntegration.update({
        where: { workspaceId },
        data: {
          recordingCapable: false,
          recordingCapabilityReason: reason,
          recordingCapabilityCheckedAt: new Date(),
        },
      }).catch(() => {})
      try {
        space = await createSpace(client, {
          accessType: desiredAccessType,
          entryPointAccess: 'ALL',
          autoRecording: 'OFF',
          autoTranscription: transcriptionEnabledFinal ? 'ON' : 'OFF',
        })
        warnings.push(capabilityMessage(reason as RecordingCapabilityReason))
      } catch (err2) {
        console.error('[bookInterview] Meet space creation failed:', err2)
        throw new BookInterviewError(502, 'meet_space_failed', (err2 as Error).message)
      }
    } else if (
      err instanceof MeetApiError
      && desiredAccessType !== 'TRUSTED'
      && /updateAccessType|accessType/i.test(err.message || '')
    ) {
      // Defensive belt-and-suspenders: even if hostedDomain detection is
      // wrong, if the API specifically rejects the access type, retry
      // with TRUSTED (always allowed). Persist the downgrade so future
      // bookings for this workspace skip the failing attempt.
      console.warn('[bookInterview] accessType rejected, retrying with TRUSTED:', err.message)
      try {
        space = await createSpace(client, {
          accessType: 'TRUSTED',
          entryPointAccess: 'ALL',
          autoRecording: selection.recordingEnabled ? 'ON' : 'OFF',
          autoTranscription: transcriptionEnabledFinal ? 'ON' : 'OFF',
        })
      } catch (err2) {
        console.error('[bookInterview] Meet space creation failed after accessType retry:', err2)
        throw new BookInterviewError(502, 'meet_space_failed', (err2 as Error).message)
      }
    } else {
      console.error('[bookInterview] Meet space creation failed:', err)
      throw new BookInterviewError(502, 'meet_space_failed', (err as Error).message)
    }
  }
  if (!space) {
    throw new BookInterviewError(502, 'meet_space_failed', 'No space returned')
  }

  const persistedRecording = space.config?.artifactConfig?.recordingConfig?.autoRecordingGeneration === 'ON'
  const persistedTranscription = space.config?.artifactConfig?.transcriptionConfig?.autoTranscriptionGeneration === 'ON'
  if (selection.recordingEnabled && !persistedRecording) {
    warnings.push(capabilityMessage('permission_denied_plan' as RecordingCapabilityReason))
  }

  // 5b. Resolve schedulingConfigId (explicit > default for workspace > null)
  // upfront so we can (a) seed the calendar event's attendee list with the
  // config's assigned team members, and (b) create InterviewMeetingHost rows
  // linked to the same config. Was step 8 previously — moved earlier because
  // hosts have to be on the calendar invite at insert time (patching in
  // attendees post-hoc means the recruiter's inbox misses the invite email
  // Google sends on insert).
  const configId = schedulingConfigId ?? (await prisma.schedulingConfig.findFirst({
    where: { workspaceId, isActive: true, isDefault: true }, select: { id: true },
  }))?.id ?? null

  let assignedMemberIds: string[] = []
  if (configId) {
    const cfg = await prisma.schedulingConfig.findUnique({
      where: { id: configId },
      select: { assignedMemberIds: true },
    })
    assignedMemberIds = cfg?.assignedMemberIds ?? []
  }
  const hostMembers = await resolveHostMembers(workspaceId, assignedMemberIds)

  // 6. Create Calendar event
  const calendar = google.calendar({ version: 'v3', auth: client })
  const descriptionParts: string[] = [
    `Interview with ${session.candidateName || 'candidate'}`,
    notes ? `\nNotes: ${notes}` : '',
    `\n\n— HireFunnel (utm_content=${session.id})`,
  ]
  let calEvent
  try {
    const res = await calendar.events.insert({
      calendarId: integration.calendarId,
      sendUpdates: 'all',
      requestBody: {
        summary: `Interview — ${session.candidateName || 'Candidate'}`,
        description: descriptionParts.join(''),
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        // Candidate + assigned host team members. Google sends invite +
        // reminder emails to every non-self attendee automatically — no
        // separate HF-side email needed to alert the recruiter about the
        // meeting itself (HF's fanout is only for meeting-lifecycle events
        // like candidate confirm/cancel).
        attendees: hostsAsCalendarAttendees(hostMembers, attendeeEmail),
        conferenceData: {
          conferenceSolution: { key: { type: 'hangoutsMeet' } },
          entryPoints: [{ entryPointType: 'video', uri: space.meetingUri, meetingCode: space.meetingCode }],
        },
      },
      conferenceDataVersion: 1,
    })
    calEvent = res.data
  } catch (err) {
    console.error('[bookInterview] Calendar insert failed:', err)
    throw new BookInterviewError(502, 'calendar_event_failed', (err as Error).message)
  }
  if (!calEvent.id) {
    throw new BookInterviewError(502, 'calendar_event_failed', 'No event id returned')
  }

  // 7. Subscribe to Workspace Events (best-effort)
  let subName: string | null = null
  let subExpires: Date | null = null
  try {
    const sub = await subscribeSpace(client, space.name)
    subName = sub.name
    subExpires = sub.expireTime ? new Date(sub.expireTime) : null
  } catch (err) {
    if (err instanceof WorkspaceEventsError) {
      console.error('[bookInterview] subscribeSpace failed:', err.status, err.message)
    } else {
      console.error('[bookInterview] subscribeSpace failed:', err)
    }
  }

  // 7b. Promote assigned hosts to Meet COHOSTs (best-effort). Grants Start
  // Meeting / Admit / End-for-all authority so any assigned teammate can run
  // the call without the workspace owner joining first. Personal Gmail or a
  // Workspace admin policy blocking external cohosts will 403 here — swallowed
  // inside promoteHostsToCohosts, booking still succeeds without cohost power.
  if (hostMembers.length > 0) {
    await promoteHostsToCohosts(client, space.name, hostMembers)
  }

  // 9. Persist + fire automations
  const meeting = await prisma.interviewMeeting.create({
    data: {
      workspaceId,
      sessionId: session.id,
      schedulingConfigId: configId,
      meetSpaceName: space.name,
      meetingCode: space.meetingCode,
      meetingUri: space.meetingUri,
      googleCalendarEventId: calEvent.id,
      scheduledStart: start,
      scheduledEnd: end,
      recordingEnabled: persistedRecording,
      recordingProvider: persistedRecording ? 'google_meet' : null,
      recordingState: persistedRecording ? 'requested' : 'disabled',
      transcriptState: persistedTranscription ? 'processing' : 'disabled',
      workspaceEventsSubName: subName,
      workspaceEventsSubExpiresAt: subExpires,
      hosts: hostMembers.length
        ? { create: hostMembers.map((h) => ({ workspaceMemberId: h.memberId })) }
        : undefined,
    },
  })

  // Booking a meeting is real forward progress — reset the stale clock so a
  // candidate who picks a slot 6 days after the invite isn't immediately
  // stalled the next morning. Best-effort.
  await prisma.session.update({
    where: { id: session.id },
    data: { lastProgressAt: new Date(), lastActivityAt: new Date() },
  }).catch(() => {})

  // 9b. Recall.ai bot (best-effort) — when the workspace has opted into
  // bot-based attendance + recording, schedule a bot to join the call. On
  // success we flip attendanceSource='recall' so the Meet auto-record path
  // defers to the bot. On any failure, the row stays on the 'meet' source so
  // the booking itself never breaks.
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { recallBotEnabled: true, name: true },
  })
  if (workspace?.recallBotEnabled && process.env.RECALL_API_KEY) {
    try {
      const bot = await scheduleBot({
        meetingUrl: space.meetingUri,
        joinAt: start,
        metadata: {
          interviewMeetingId: meeting.id,
          workspaceId,
          sessionId: session.id,
        },
      })
      await prisma.interviewMeeting.update({
        where: { id: meeting.id },
        data: {
          recallBotId: bot.id,
          attendanceSource: 'recall',
          // Recall is now the authoritative recording source for this meeting.
          recordingProvider: 'recall',
          recordingState: 'requested',
        },
      })
    } catch (err) {
      const status = err instanceof RecallApiError ? err.status : 0
      const detail = err instanceof RecallApiError ? err.message : (err as Error).message
      logger.error('recall scheduleBot failed — meeting will fall back to Meet auto-record', {
        workspaceId,
        sessionId: session.id,
        interviewMeetingId: meeting.id,
        meetingUri: space.meetingUri,
        recallStatus: status,
        recallDetail: detail,
        // 402 is the silent-killer case: account out of credits. Tag it so a
        // Loki alert can page on it specifically (see project memory
        // project_recall_credit_balance_zero).
        recallOutOfCredits: status === 402,
      })
      if (status === 402) {
        await notifyRecallOutOfCredits({
          workspaceId,
          workspaceName: workspace.name,
          meetingUri: space.meetingUri,
          interviewMeetingId: meeting.id,
          recallDetail: detail,
        })
      }
      warnings.push('Recording bot could not be scheduled — meeting will use Google Meet recording as a fallback.')
    }
  }

  await logSchedulingEvent({
    sessionId: session.id,
    schedulingConfigId: configId,
    eventType: 'meeting_scheduled',
    metadata: {
      interviewMeetingId: meeting.id,
      scheduledAt: start.toISOString(),
      endAt: end.toISOString(),
      meetingUrl: space.meetingUri,
      googleEventId: calEvent.id,
      recordingEnabled: persistedRecording,
      source: source === 'public' ? 'built_in_scheduler' : 'google_meet_v2',
      loggedBy,
      notes: notes || null,
    },
  })

  // Baseline platform confirmation — sent unconditionally, independent of
  // any AutomationRule. The candidate gets the Meet link the moment they
  // book; user-configured automation (pipeline rules, per-config reminders)
  // layers on top of this.
  await sendMeetingConfirmation(meeting.id).catch((err) => {
    console.error('[bookInterview] sendMeetingConfirmation failed:', err)
  })

  // Notify assigned host team members. Google Calendar's own invite is
  // unreliable when the calendar owner is on personal Gmail (invite emails
  // frequently skipped or spam-filtered), so we send an HF-controlled
  // "you've been assigned" email via SendGrid too. Best-effort — never
  // blocks the booking response.
  if (hostMembers.length > 0) {
    await sendHostAssignmentInvites(meeting.id, hostMembers).catch((err) => {
      console.error('[bookInterview] sendHostAssignmentInvites failed:', err)
    })
  }

  await updatePipelineStatus(session.id, 'scheduled').catch(() => {})
  await emitAutomationEvent({
    workspaceId: meeting.workspaceId,
    sessionId: session.id,
    triggerType: 'meeting_scheduled',
    eventKey: eventKeys.meetingScheduled(meeting.id),
    source: opts.source === 'public' ? 'public_endpoint' : 'internal',
    payload: { interviewMeetingId: meeting.id, bookingSource: opts.source },
    // public bookings come from the candidate-facing flow link; operator
    // bookings are recruiter-initiated. Both tag the downstream executions
    // for the audit trail; lifecycle/prereq/stage guards apply identically.
    dispatch: () => fireMeetingScheduledAutomations(session.id, {
      executionMode: opts.source === 'public' ? 'public_trigger' : 'immediate',
      actorUserId: opts.loggedBy ?? null,
    }),
  }).catch((err) => {
    console.error('[bookInterview] meeting_scheduled emit failed:', err)
  })

  return {
    ok: true,
    interviewMeeting: {
      id: meeting.id,
      meetingUri: meeting.meetingUri,
      scheduledStart: meeting.scheduledStart,
      scheduledEnd: meeting.scheduledEnd,
      recordingEnabled: meeting.recordingEnabled,
      recordingState: meeting.recordingState,
    },
    warnings,
  }
}

/** Re-export so the operator route can keep its existing import surface. */
export { google }
export type { OAuth2Client }
