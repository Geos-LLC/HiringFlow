/**
 * POST /api/public/booking/[configId]
 *
 * Public — auth via signed `t` token (purpose='book'). Books the slot the
 * candidate selected. Re-checks availability under the same FreeBusy lookup
 * the picker used so race-conditions are caught at submit time, not after
 * a Meet event has been created.
 *
 * Idempotency: if the session has a meeting_scheduled SchedulingEvent
 * created within the last 5 minutes from this scheduler, we treat the
 * incoming POST as a duplicate (browser double-submit, retry, etc.) and
 * return the existing meeting rather than booking a second one.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifyBookingToken, issueBookingToken } from '@/lib/scheduling/booking-links'
import { parseBookingRulesOrDefault } from '@/lib/scheduling/booking-rules'
import { getBusyIntervals } from '@/lib/scheduling/free-busy'
import { computeAvailableSlots } from '@/lib/scheduling/slot-computer'
import { bookInterview, BookInterviewError } from '@/lib/scheduling/book-interview'
import { bookingErrorMessage } from '@/lib/scheduling/error-messages'
import { notifyTenantOfBookingFailure } from '@/lib/google-auth-notifier'

export async function POST(request: NextRequest, { params }: { params: { configId: string } }) {
  const body = await request.json().catch(() => ({})) as {
    t?: string
    slotStartUtc?: string
    candidateName?: string | null
    candidateEmail?: string | null
    candidatePhone?: string | null
    notes?: string | null
  }

  if (!body.slotStartUtc) {
    return NextResponse.json({ error: 'slotStartUtc_required', message: bookingErrorMessage('slotStartUtc_required') }, { status: 400 })
  }
  const slotStart = new Date(body.slotStartUtc)
  if (isNaN(slotStart.getTime())) {
    return NextResponse.json({ error: 'invalid_slot', message: bookingErrorMessage('invalid_slot') }, { status: 400 })
  }

  // Two modes:
  //  - With token: per-candidate flow (existing). Token must verify and
  //    bind to an existing session.
  //  - Without token: anonymous public-link flow. Caller must supply
  //    candidateName + candidateEmail; we create a session inline.
  let sessionId: string
  let isAnonymous = false

  if (body.t) {
    const verified = verifyBookingToken(body.t)
    if (!verified.ok) {
      return NextResponse.json({ error: 'invalid_token', message: bookingErrorMessage('invalid_token'), reason: verified.reason }, { status: 401 })
    }
    if (verified.payload.purpose !== 'book') {
      return NextResponse.json({ error: 'wrong_purpose', message: bookingErrorMessage('wrong_purpose') }, { status: 401 })
    }
    if (verified.payload.configId !== params.configId) {
      return NextResponse.json({ error: 'config_mismatch', message: bookingErrorMessage('config_mismatch') }, { status: 401 })
    }
    sessionId = verified.payload.sessionId
  } else {
    isAnonymous = true
    const name = (body.candidateName || '').trim()
    const email = (body.candidateEmail || '').trim()
    if (!name) return NextResponse.json({ error: 'name_required', message: bookingErrorMessage('name_required') }, { status: 400 })
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'invalid_email', message: bookingErrorMessage('invalid_email') }, { status: 400 })
    }
    // sessionId resolved below after we've loaded the config (need workspaceId).
    sessionId = ''
  }

  const config = await prisma.schedulingConfig.findUnique({
    where: { id: params.configId },
    select: {
      id: true,
      isActive: true,
      useBuiltInScheduler: true,
      bookingRules: true,
      calendarId: true,
      workspaceId: true,
      workspace: { select: { timezone: true, senderEmail: true } },
    },
  })
  if (!config || !config.isActive || !config.useBuiltInScheduler) {
    if (config) void notifyTenantOfBookingFailure(config.workspaceId, 'config_not_found')
    return NextResponse.json({ error: 'config_not_found', message: bookingErrorMessage('config_not_found') }, { status: 404 })
  }
  const contactEmail = config.workspace.senderEmail

  // Anonymous-mode session creation: now that we have the workspace, find a
  // flow to attach to and either reuse a recent public_booking session for
  // the same email or create a new one.
  if (isAnonymous) {
    const flow = await prisma.flow.findFirst({
      where: { workspaceId: config.workspaceId },
      orderBy: [{ isPublished: 'desc' }, { createdAt: 'asc' }],
      select: { id: true },
    })
    if (!flow) {
      void notifyTenantOfBookingFailure(config.workspaceId, 'no_flow_available')
      return NextResponse.json({
        error: 'no_flow_available',
        message: bookingErrorMessage('no_flow_available', { contactEmail }),
      }, { status: 409 })
    }
    const email = (body.candidateEmail || '').trim()
    const name = (body.candidateName || '').trim()
    const phone = (body.candidatePhone || '').trim()
    const recentSession = await prisma.session.findFirst({
      where: {
        workspaceId: config.workspaceId,
        candidateEmail: email,
        source: 'public_booking',
        startedAt: { gt: new Date(Date.now() - 60 * 60_000) },
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    })
    if (recentSession) {
      sessionId = recentSession.id
      // Refresh name/phone if changed.
      await prisma.session.update({
        where: { id: sessionId },
        data: { candidateName: name, candidatePhone: phone || null },
      })
    } else {
      // V1: writes 'training_completed' as before. V2 (workspace/pipeline
      // opted in): writes the pipeline's first stage id. Fallback to the
      // legacy value if V2 pipeline resolution fails — public booking must
      // never 500 on session create.
      const { getInitialPipelineStatusForCreate } = await import('@/lib/pipeline-transitions')
      const initialStatus = await getInitialPipelineStatusForCreate({
        workspaceId: config.workspaceId,
        flowId: flow.id,
        legacyStatus: 'training_completed',
      })
      const created = await prisma.session.create({
        data: {
          workspaceId: config.workspaceId,
          flowId: flow.id,
          candidateName: name,
          candidateEmail: email,
          candidatePhone: phone || null,
          source: 'public_booking',
          pipelineStatus: initialStatus,
        },
        select: { id: true },
      })
      sessionId = created.id
    }
  }

  // Idempotency: returning duplicate within 5 min as success.
  const recent = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId,
      eventType: 'meeting_scheduled',
      createdAt: { gt: new Date(Date.now() - 5 * 60_000) },
    },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
  })
  if (recent && recent.metadata && typeof recent.metadata === 'object' && 'source' in recent.metadata) {
    const md = recent.metadata as { source?: string; meetingUrl?: string; interviewMeetingId?: string }
    if (md.source === 'built_in_scheduler') {
      return NextResponse.json({
        ok: true,
        idempotent: true,
        meetingUri: md.meetingUrl || null,
        interviewMeetingId: md.interviewMeetingId || null,
      })
    }
  }

  // Re-validate slot is still free with a fresh FreeBusy fetch.
  const rules = parseBookingRulesOrDefault(config.bookingRules)
  const slotEnd = new Date(slotStart.getTime() + rules.durationMinutes * 60_000)
  const fromUtc = new Date(slotStart.getTime() - 60_000)
  const toUtc = new Date(slotEnd.getTime() + 60_000)

  let busy
  try {
    busy = await getBusyIntervals({
      workspaceId: config.workspaceId,
      calendarId: config.calendarId || undefined,
      fromUtc,
      toUtc,
      bustCache: true,
    })
  } catch (err) {
    console.error('[booking] freeBusy failed:', err)
    void notifyTenantOfBookingFailure(config.workspaceId, 'free_busy_failed', { err })
    return NextResponse.json({
      error: 'free_busy_failed',
      message: bookingErrorMessage('free_busy_failed', { contactEmail }),
      detail: (err as Error).message,
    }, { status: 502 })
  }

  const stillAvailable = computeAvailableSlots({
    rules,
    recruiterTimezone: config.workspace.timezone,
    busyIntervals: busy,
    fromUtc,
    toUtc,
    nowUtc: new Date(),
  }).some((s) => s.startUtc.getTime() === slotStart.getTime())

  if (!stillAvailable) {
    return NextResponse.json({ error: 'slot_unavailable', message: bookingErrorMessage('slot_unavailable') }, { status: 409 })
  }

  // For per-candidate (tokened) flow, update session contact info if the
  // candidate filled in fresh details. Anonymous flow already wrote these
  // when creating the session above.
  if (!isAnonymous) {
    const updates: Record<string, string> = {}
    if (body.candidateName && body.candidateName.trim()) updates.candidateName = body.candidateName.trim()
    if (body.candidateEmail && body.candidateEmail.trim()) updates.candidateEmail = body.candidateEmail.trim()
    if (body.candidatePhone && body.candidatePhone.trim()) updates.candidatePhone = body.candidatePhone.trim()
    if (Object.keys(updates).length > 0) {
      await prisma.session.update({
        where: { id: sessionId },
        data: updates,
      }).catch((err) => console.error('[booking] session update failed:', err))
    }
  }

  try {
    const result = await bookInterview({
      workspaceId: config.workspaceId,
      sessionId,
      scheduledAt: slotStart,
      durationMinutes: rules.durationMinutes,
      // Default to ON — bookInterview's selectRecorder gates this on the
      // workspace's recordingCapable flag, and a 403 from createSpace falls
      // back to OFF gracefully. Without this, every self-booked meeting
      // landed with autoRecording OFF regardless of capability.
      record: true,
      notes: body.notes,
      attendeeEmail: body.candidateEmail,
      schedulingConfigId: config.id,
      source: 'public',
      loggedBy: null,
    })

    // Issue reschedule + cancel tokens, expiring at slotStart - 1h (no
    // changes after the meeting starts).
    const cutoff = new Date(slotStart.getTime() - 60 * 60_000)
    const rescheduleToken = issueBookingToken({
      sessionId, configId: params.configId, purpose: 'reschedule', expiresAt: cutoff,
    })
    const cancelToken = issueBookingToken({
      sessionId, configId: params.configId, purpose: 'cancel', expiresAt: cutoff,
    })

    return NextResponse.json({
      ok: true,
      meetingUri: result.interviewMeeting.meetingUri,
      scheduledStart: result.interviewMeeting.scheduledStart,
      scheduledEnd: result.interviewMeeting.scheduledEnd,
      interviewMeetingId: result.interviewMeeting.id,
      rescheduleToken,
      cancelToken,
      warnings: result.warnings,
    })
  } catch (err) {
    if (err instanceof BookInterviewError) {
      // bookInterview throws when Google Meet space creation / Calendar
      // insert fails. The notifier inspects the underlying message to pick
      // oauth_revoked vs integration_down.
      void notifyTenantOfBookingFailure(config.workspaceId, err.code || 'free_busy_failed', { err })
      return NextResponse.json({
        error: err.code,
        message: bookingErrorMessage(err.code, { contactEmail }) || err.message,
        detail: err.message,
      }, { status: err.status })
    }
    console.error('[booking] unexpected error:', err)
    void notifyTenantOfBookingFailure(config.workspaceId, 'internal', { err })
    return NextResponse.json({
      error: 'internal',
      message: bookingErrorMessage('internal', { contactEmail }),
      detail: (err as Error).message,
    }, { status: 500 })
  }
}
