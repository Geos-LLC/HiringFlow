/**
 * POST /api/public/booking/[configId]/cancel
 *
 * Public — auth via signed `t` token (purpose='cancel'). Deletes the
 * candidate's calendar event in Google. The webhook handler picks up the
 * deletion and logs `meeting_cancelled` + cancels pending reminder
 * automations. We log here too as a defensive belt-and-suspenders.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifyBookingToken } from '@/lib/scheduling/booking-links'
import { deleteCalendarEvent } from '@/lib/google'
import { logSchedulingEvent } from '@/lib/scheduling'
import { bookingErrorMessage } from '@/lib/scheduling/error-messages'
import { notifyTenantOfBookingFailure } from '@/lib/google-auth-notifier'

export async function POST(request: NextRequest, { params }: { params: { configId: string } }) {
  const body = await request.json().catch(() => ({})) as { t?: string; reason?: string }

  const verified = verifyBookingToken(body.t)
  if (!verified.ok) {
    return NextResponse.json({ error: 'invalid_token', message: bookingErrorMessage('invalid_token'), reason: verified.reason }, { status: 401 })
  }
  if (verified.payload.purpose !== 'cancel') {
    return NextResponse.json({ error: 'wrong_purpose', message: bookingErrorMessage('wrong_purpose') }, { status: 401 })
  }
  if (verified.payload.configId !== params.configId) {
    return NextResponse.json({ error: 'config_mismatch', message: bookingErrorMessage('config_mismatch') }, { status: 401 })
  }

  // Find the most recent active interview meeting for this session.
  const meeting = await prisma.interviewMeeting.findFirst({
    where: {
      sessionId: verified.payload.sessionId,
      scheduledStart: { gt: new Date() },
    },
    orderBy: { scheduledStart: 'asc' },
    select: { id: true, googleCalendarEventId: true, workspaceId: true },
  })
  if (!meeting) {
    // Look up workspace contact email via the config so the friendly
    // message can include it.
    const cfg = await prisma.schedulingConfig.findUnique({
      where: { id: params.configId },
      select: { workspaceId: true, workspace: { select: { senderEmail: true } } },
    })
    if (cfg) void notifyTenantOfBookingFailure(cfg.workspaceId, 'no_meeting_to_cancel')
    return NextResponse.json({
      error: 'no_meeting_to_cancel',
      message: bookingErrorMessage('no_meeting_to_cancel', { contactEmail: cfg?.workspace.senderEmail }),
    }, { status: 404 })
  }

  if (meeting.googleCalendarEventId) {
    try {
      await deleteCalendarEvent(meeting.workspaceId, meeting.googleCalendarEventId)
    } catch (err) {
      console.error('[cancel] deleteCalendarEvent failed:', err)
      void notifyTenantOfBookingFailure(meeting.workspaceId, 'calendar_patch_failed', { err })
      // Continue — log the cancel locally even if Google delete failed,
      // so the candidate's pipeline state moves.
    }
  }

  // Soft-delete the row so the slot frees up immediately in
  // availability/preview-conflicts. If we relied only on the GCal webhook
  // path to set cancelledAt, a Google failure above would leave the row
  // active forever.
  await prisma.interviewMeeting.update({
    where: { id: meeting.id },
    data: { cancelledAt: new Date() },
  }).catch((err) => console.error('[cancel] InterviewMeeting cancelledAt update failed:', err))

  await logSchedulingEvent({
    sessionId: verified.payload.sessionId,
    schedulingConfigId: params.configId,
    eventType: 'meeting_cancelled',
    metadata: {
      interviewMeetingId: meeting.id,
      source: 'built_in_scheduler',
      cancelledBy: 'candidate',
      reason: body.reason || null,
    },
  }).catch((err) => console.error('[cancel] logSchedulingEvent failed:', err))

  return NextResponse.json({ ok: true })
}
