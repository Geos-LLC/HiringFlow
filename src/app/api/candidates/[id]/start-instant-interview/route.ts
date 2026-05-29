/**
 * POST /api/candidates/[id]/start-instant-interview
 *
 * Spins up a fresh Meet space + Recall bot for an *ad-hoc* interview that
 * starts right now — the recovery path for "scheduled interview was a no-show
 * but the candidate actually showed up late and we joined on a fresh link".
 *
 * Behaves like `bookInterview` but with three deliberate divergences:
 *  - `scheduledStart = now`, so `scheduleBot` drops its 10-min `join_at`
 *    requirement and Recall dispatches the bot immediately.
 *  - Calendar event is inserted with `sendUpdates='none'` — the candidate is
 *    already on the call, no point emailing them a calendar invite for a
 *    meeting that's already in progress.
 *  - Does NOT fire `fireMeetingScheduledAutomations`. The recruiter is
 *    initiating an ad-hoc call; they don't want auto-emails like "Your
 *    interview is scheduled for…" to a candidate sitting on the line. The
 *    bot's `meeting_started` webhook will fire normally when it connects.
 *
 * Auto-revert: if the candidate was previously marked as no-show (by the
 * mark-no-show button or the lifecycle automation), the rejectionReason,
 * status='lost', dispositionReason='interview_no_show', and the automations
 * kill-switch are all cleared. The kanban card is moved to the workspace's
 * `meeting_scheduled` stage when one is configured. The original
 * InterviewMeeting row is left in place as historical truth (10am scheduled,
 * never joined) — the new row is the do-over.
 */

import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getAuthedClientForWorkspace, hasMeetScopes } from '@/lib/google'
import { meetIntegrationEnabled } from '@/lib/meet/feature-flag'
import { createSpace, MeetApiError } from '@/lib/meet/google-meet'
import { subscribeSpace, WorkspaceEventsError } from '@/lib/meet/workspace-events'
import {
  ensureRecordingCapability,
  probeRecordingCapability,
  capabilityMessage,
  type RecordingCapabilityReason,
  type CombinedCapability,
} from '@/lib/meet/recording-capability'
import { selectRecorder } from '@/lib/meet/meeting-recorder'
import { logSchedulingEvent } from '@/lib/scheduling'
import { scheduleBot, RecallApiError } from '@/lib/recall/client'
import { statusTransitionPatch } from '@/lib/candidate-status'
import { resolvePipelineForSession, stagesFor } from '@/lib/pipelines'
import { findStageForEvent } from '@/lib/funnel-stages'

const NONE_CAP: CombinedCapability = {
  recording:    { capable: null, reason: 'probe_not_run', checkedAt: null, fromCache: true },
  transcription:{ capable: null, reason: 'probe_not_run', checkedAt: null, fromCache: true },
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const enabled = await meetIntegrationEnabled(ws.workspaceId)
  if (!enabled) {
    return NextResponse.json(
      { error: 'meet_disabled', message: 'Meet integration is not enabled for this workspace' },
      { status: 404 },
    )
  }

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({})) as { durationMinutes?: number }
  const durationMinutes = Math.max(10, Math.min(240, body.durationMinutes || 30))

  const authed = await getAuthedClientForWorkspace(ws.workspaceId)
  if (!authed) {
    return NextResponse.json(
      { error: 'google_not_connected', message: 'Google account not connected' },
      { status: 409 },
    )
  }
  const { client, integration } = authed
  if (!hasMeetScopes(integration.grantedScopes)) {
    return NextResponse.json(
      { error: 'reconnect_required', message: 'Reconnect Google account to enable Meet scheduling' },
      { status: 409 },
    )
  }

  const start = new Date()
  const end = new Date(start.getTime() + durationMinutes * 60_000)
  const warnings: string[] = []

  // Recording capability — instant meetings always want recording when the
  // workspace is capable. Cached probe is fine; the freshness window matches
  // bookInterview.
  let capability = NONE_CAP
  try {
    const cached = await ensureRecordingCapability(ws.workspaceId)
    capability = cached.recording.capable === true
      ? cached
      : await probeRecordingCapability(ws.workspaceId)
  } catch (err) {
    console.error('[start-instant-interview] capability probe failed:', err)
  }

  const selection = selectRecorder({ record: true, capable: capability.recording.capable })
  const transcriptionEnabledFinal = capability.transcription.capable !== false
  if (!selection.recordingEnabled) {
    warnings.push(capabilityMessage(capability.recording.reason as RecordingCapabilityReason))
  }

  // Create fresh Meet space (with 403-recording fallback mirroring bookInterview).
  let space: Awaited<ReturnType<typeof createSpace>> | undefined
  try {
    space = await createSpace(client, {
      accessType: 'TRUSTED',
      entryPointAccess: 'ALL',
      autoRecording: selection.recordingEnabled ? 'ON' : 'OFF',
      autoTranscription: transcriptionEnabledFinal ? 'ON' : 'OFF',
    })
  } catch (err) {
    if (selection.recordingEnabled && err instanceof MeetApiError && err.status === 403) {
      const reason = err.recordingReason ?? 'permission_denied_other'
      await prisma.googleIntegration.update({
        where: { workspaceId: ws.workspaceId },
        data: {
          recordingCapable: false,
          recordingCapabilityReason: reason,
          recordingCapabilityCheckedAt: new Date(),
        },
      }).catch(() => {})
      try {
        space = await createSpace(client, {
          accessType: 'TRUSTED',
          entryPointAccess: 'ALL',
          autoRecording: 'OFF',
          autoTranscription: transcriptionEnabledFinal ? 'ON' : 'OFF',
        })
        warnings.push(capabilityMessage(reason as RecordingCapabilityReason))
      } catch (err2) {
        console.error('[start-instant-interview] Meet space creation failed:', err2)
        return NextResponse.json(
          { error: 'meet_space_failed', message: (err2 as Error).message },
          { status: 502 },
        )
      }
    } else {
      console.error('[start-instant-interview] Meet space creation failed:', err)
      return NextResponse.json(
        { error: 'meet_space_failed', message: (err as Error).message },
        { status: 502 },
      )
    }
  }
  if (!space) {
    return NextResponse.json({ error: 'meet_space_failed', message: 'No space returned' }, { status: 502 })
  }

  const persistedRecording = space.config?.artifactConfig?.recordingConfig?.autoRecordingGeneration === 'ON'
  const persistedTranscription = space.config?.artifactConfig?.transcriptionConfig?.autoTranscriptionGeneration === 'ON'

  // Calendar event — sendUpdates='none' because the candidate is already on
  // the call. The event still needs to exist so the InterviewMeeting row
  // (which requires googleCalendarEventId) can attach to it for downstream
  // reconcile logic.
  const calendar = google.calendar({ version: 'v3', auth: client })
  let calEvent
  try {
    const res = await calendar.events.insert({
      calendarId: integration.calendarId,
      sendUpdates: 'none',
      requestBody: {
        summary: `Instant interview — ${session.candidateName || 'Candidate'}`,
        description: `Ad-hoc interview started from the candidate page.\n\n— HireFunnel (utm_content=${session.id})`,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        conferenceData: {
          conferenceSolution: { key: { type: 'hangoutsMeet' } },
          entryPoints: [{ entryPointType: 'video', uri: space.meetingUri, meetingCode: space.meetingCode }],
        },
      },
      conferenceDataVersion: 1,
    })
    calEvent = res.data
  } catch (err) {
    console.error('[start-instant-interview] Calendar insert failed:', err)
    return NextResponse.json(
      { error: 'calendar_event_failed', message: (err as Error).message },
      { status: 502 },
    )
  }
  if (!calEvent.id) {
    return NextResponse.json({ error: 'calendar_event_failed', message: 'No event id returned' }, { status: 502 })
  }

  // Workspace Events subscription (best-effort) so meeting_started / ended
  // signals route correctly even when Recall is the primary source.
  let subName: string | null = null
  let subExpires: Date | null = null
  try {
    const sub = await subscribeSpace(client, space.name)
    subName = sub.name
    subExpires = sub.expireTime ? new Date(sub.expireTime) : null
  } catch (err) {
    if (err instanceof WorkspaceEventsError) {
      console.error('[start-instant-interview] subscribeSpace failed:', err.status, err.message)
    } else {
      console.error('[start-instant-interview] subscribeSpace failed:', err)
    }
  }

  const configId = (await prisma.schedulingConfig.findFirst({
    where: { workspaceId: ws.workspaceId, isActive: true, isDefault: true }, select: { id: true },
  }))?.id ?? null

  const meeting = await prisma.interviewMeeting.create({
    data: {
      workspaceId: ws.workspaceId,
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
    },
  })

  // Recall bot — fires immediately because joinAt is `now`. scheduleBot's
  // 10-min guard drops join_at and Recall provisions the bot as soon as
  // possible (typically <30s).
  const workspace = await prisma.workspace.findUnique({
    where: { id: ws.workspaceId },
    select: { recallBotEnabled: true },
  })
  let botScheduled = false
  if (workspace?.recallBotEnabled && process.env.RECALL_API_KEY) {
    try {
      const bot = await scheduleBot({
        meetingUrl: space.meetingUri,
        joinAt: start,
        metadata: {
          interviewMeetingId: meeting.id,
          workspaceId: ws.workspaceId,
          sessionId: session.id,
        },
      })
      await prisma.interviewMeeting.update({
        where: { id: meeting.id },
        data: {
          recallBotId: bot.id,
          attendanceSource: 'recall',
          recordingProvider: 'recall',
          recordingState: 'requested',
        },
      })
      botScheduled = true
    } catch (err) {
      const msg = err instanceof RecallApiError
        ? `Recall ${err.status}: ${err.message}`
        : (err as Error).message
      console.error('[start-instant-interview] recall scheduleBot failed:', msg)
      warnings.push('Recording bot could not be scheduled — Google Meet recording will be used as a fallback.')
    }
  }

  // Log the scheduling event for the timeline. Tagged `source='instant'` so
  // the audit log distinguishes ad-hoc do-overs from normal bookings.
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
      source: 'instant',
      loggedBy: ws.userId ?? null,
    },
  })

  // Auto-revert prior no-show state. The recruiter is spinning up a do-over
  // — by definition the candidate is not lost. Clear the no-show stamps so
  // automations re-enable, the red pill disappears, and analytics stop
  // counting this candidate as lost.
  const revertedNoShow = await revertNoShowState(session.id)

  // Move the kanban card back into the interview lane when the workspace has
  // a stage wired for meeting_scheduled. If nothing is wired, leave
  // pipelineStatus alone — the recruiter can drag the card manually.
  let pipelineStatusUpdated: string | null = null
  try {
    const pipeline = await resolvePipelineForSession({
      sessionId: session.id,
      workspaceId: ws.workspaceId,
    })
    if (pipeline) {
      const stages = stagesFor(pipeline)
      const targetStage = findStageForEvent(stages, 'meeting_scheduled', {
        flowId: session.flowId,
      })
      if (targetStage) {
        await prisma.session.update({
          where: { id: session.id },
          data: { pipelineStatus: targetStage.id },
        })
        pipelineStatusUpdated = targetStage.id
      }
    }
  } catch (err) {
    console.error('[start-instant-interview] stage move failed:', err)
  }

  return NextResponse.json({
    ok: true,
    interviewMeetingId: meeting.id,
    meetingUri: space.meetingUri,
    scheduledStart: meeting.scheduledStart,
    scheduledEnd: meeting.scheduledEnd,
    botScheduled,
    revertedNoShow,
    pipelineStatusUpdated,
    warnings,
  })
}

/**
 * Clear the no-show stamps from a candidate. Returns true if any field was
 * actually changed (so the response can tell the UI whether to surface a
 * "we cleared the no-show" hint). Idempotent — safe to call when no prior
 * no-show is present.
 */
async function revertNoShowState(sessionId: string): Promise<boolean> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      rejectionReason: true,
      status: true,
      dispositionReason: true,
    },
  })
  if (!session) return false

  const wasNoShowRejection = session.rejectionReason === 'No-show'
  const wasNoShowLost = session.status === 'lost' && session.dispositionReason === 'interview_no_show'

  if (!wasNoShowRejection && !wasNoShowLost) return false

  const patch: Record<string, unknown> = {}
  if (wasNoShowRejection) {
    patch.rejectionReason = null
    patch.rejectionReasonAt = null
  }
  if (wasNoShowLost) {
    Object.assign(patch, statusTransitionPatch('active', { dispositionReason: null }))
  }

  await prisma.session.update({
    where: { id: sessionId },
    data: patch,
  })
  return true
}
