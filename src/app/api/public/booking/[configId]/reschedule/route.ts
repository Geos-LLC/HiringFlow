/**
 * POST /api/public/booking/[configId]/reschedule
 *
 * Public — auth via signed `t` token (purpose='reschedule'). Patches the
 * existing calendar event with the new start/end. We re-validate the new
 * slot against FreeBusy before committing.
 *
 * The Meet space and Calendar event itself are NOT recreated — `events.patch`
 * keeps the same conferenceData (Meet link), so the candidate uses the same
 * URL for the rescheduled meeting. The InterviewMeeting row is updated
 * locally so the dashboard reflects the new time immediately; the watch
 * webhook would otherwise reconcile it eventually.
 */

import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { prisma } from '@/lib/prisma'
import { verifyBookingToken } from '@/lib/scheduling/booking-links'
import { parseBookingRulesOrDefault } from '@/lib/scheduling/booking-rules'
import { getBusyIntervals } from '@/lib/scheduling/free-busy'
import { computeAvailableSlots } from '@/lib/scheduling/slot-computer'
import { getAuthedClientForWorkspace, hasMeetScopes } from '@/lib/google'
import { logSchedulingEvent } from '@/lib/scheduling'
import { bookingErrorMessage } from '@/lib/scheduling/error-messages'
import { recordGoogleAuthError } from '@/lib/google-auth-notifier'

export async function POST(request: NextRequest, { params }: { params: { configId: string } }) {
  const body = await request.json().catch(() => ({})) as {
    t?: string
    slotStartUtc?: string
  }

  const verified = verifyBookingToken(body.t)
  if (!verified.ok) {
    return NextResponse.json({ error: 'invalid_token', message: bookingErrorMessage('invalid_token'), reason: verified.reason }, { status: 401 })
  }
  if (verified.payload.purpose !== 'reschedule') {
    return NextResponse.json({ error: 'wrong_purpose', message: bookingErrorMessage('wrong_purpose') }, { status: 401 })
  }
  if (verified.payload.configId !== params.configId) {
    return NextResponse.json({ error: 'config_mismatch', message: bookingErrorMessage('config_mismatch') }, { status: 401 })
  }
  if (!body.slotStartUtc) {
    return NextResponse.json({ error: 'slotStartUtc_required', message: bookingErrorMessage('slotStartUtc_required') }, { status: 400 })
  }
  const slotStart = new Date(body.slotStartUtc)
  if (isNaN(slotStart.getTime())) {
    return NextResponse.json({ error: 'invalid_slot', message: bookingErrorMessage('invalid_slot') }, { status: 400 })
  }

  const config = await prisma.schedulingConfig.findUnique({
    where: { id: params.configId },
    select: {
      id: true, isActive: true, useBuiltInScheduler: true, bookingRules: true,
      calendarId: true, workspaceId: true,
      workspace: { select: { timezone: true, senderEmail: true } },
    },
  })
  if (!config || !config.isActive || !config.useBuiltInScheduler) {
    return NextResponse.json({ error: 'config_not_found', message: bookingErrorMessage('config_not_found') }, { status: 404 })
  }
  const contactEmail = config.workspace.senderEmail

  // Find the existing meeting for this session.
  const meeting = await prisma.interviewMeeting.findFirst({
    where: { sessionId: verified.payload.sessionId, scheduledStart: { gt: new Date() } },
    orderBy: { scheduledStart: 'asc' },
  })
  if (!meeting) {
    return NextResponse.json({ error: 'no_meeting_to_reschedule', message: bookingErrorMessage('no_meeting_to_reschedule', { contactEmail }) }, { status: 404 })
  }
  if (!meeting.googleCalendarEventId) {
    return NextResponse.json({ error: 'no_calendar_event', message: bookingErrorMessage('no_calendar_event', { contactEmail }) }, { status: 409 })
  }

  const rules = parseBookingRulesOrDefault(config.bookingRules)
  const slotEnd = new Date(slotStart.getTime() + rules.durationMinutes * 60_000)

  // Re-validate against FreeBusy. Exclude the current meeting's window from
  // busy so the candidate can't be falsely told their existing slot is taken.
  const fromUtc = new Date(slotStart.getTime() - 60_000)
  const toUtc = new Date(slotEnd.getTime() + 60_000)
  let busy
  try {
    busy = await getBusyIntervals({
      workspaceId: config.workspaceId,
      calendarId: config.calendarId || undefined,
      fromUtc, toUtc,
      bustCache: true,
    })
  } catch (err) {
    console.error('[reschedule] freeBusy failed:', err)
    void recordGoogleAuthError(config.workspaceId, err)
    return NextResponse.json({
      error: 'free_busy_failed',
      message: bookingErrorMessage('free_busy_failed', { contactEmail }),
      detail: (err as Error).message,
    }, { status: 502 })
  }
  // Filter out the current meeting's interval — it shows up as busy on its own calendar.
  const filteredBusy = busy.filter((b) => !(b.start.getTime() === meeting.scheduledStart.getTime() && b.end.getTime() === meeting.scheduledEnd.getTime()))

  const stillAvailable = computeAvailableSlots({
    rules,
    recruiterTimezone: config.workspace.timezone,
    busyIntervals: filteredBusy,
    fromUtc, toUtc,
    nowUtc: new Date(),
  }).some((s) => s.startUtc.getTime() === slotStart.getTime())

  if (!stillAvailable) {
    return NextResponse.json({ error: 'slot_unavailable', message: bookingErrorMessage('slot_unavailable') }, { status: 409 })
  }

  // Patch the calendar event.
  const authed = await getAuthedClientForWorkspace(config.workspaceId)
  if (!authed) return NextResponse.json({ error: 'google_not_connected', message: bookingErrorMessage('google_not_connected', { contactEmail }) }, { status: 502 })
  if (!hasMeetScopes(authed.integration.grantedScopes)) {
    return NextResponse.json({ error: 'reconnect_required', message: bookingErrorMessage('reconnect_required', { contactEmail }) }, { status: 502 })
  }
  const calendar = google.calendar({ version: 'v3', auth: authed.client })
  try {
    await calendar.events.patch({
      calendarId: authed.integration.calendarId,
      eventId: meeting.googleCalendarEventId,
      sendUpdates: 'all',
      requestBody: {
        start: { dateTime: slotStart.toISOString() },
        end: { dateTime: slotEnd.toISOString() },
      },
    })
  } catch (err) {
    console.error('[reschedule] events.patch failed:', err)
    void recordGoogleAuthError(config.workspaceId, err)
    return NextResponse.json({
      error: 'calendar_patch_failed',
      message: bookingErrorMessage('calendar_patch_failed', { contactEmail }),
      detail: (err as Error).message,
    }, { status: 502 })
  }

  // Update local InterviewMeeting; the watch webhook would reconcile this
  // eventually but candidate should see the new time immediately.
  await prisma.interviewMeeting.update({
    where: { id: meeting.id },
    data: { scheduledStart: slotStart, scheduledEnd: slotEnd },
  })

  await logSchedulingEvent({
    sessionId: verified.payload.sessionId,
    schedulingConfigId: params.configId,
    eventType: 'meeting_rescheduled',
    metadata: {
      interviewMeetingId: meeting.id,
      previousStart: meeting.scheduledStart.toISOString(),
      newStart: slotStart.toISOString(),
      newEnd: slotEnd.toISOString(),
      meetingUrl: meeting.meetingUri,
      source: 'built_in_scheduler',
      rescheduledBy: 'candidate',
    },
  }).catch((err) => console.error('[reschedule] log failed:', err))

  return NextResponse.json({
    ok: true,
    meetingUri: meeting.meetingUri,
    scheduledStart: slotStart,
    scheduledEnd: slotEnd,
  })
}
