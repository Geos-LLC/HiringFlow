/**
 * GET /api/public/booking/[configId]/availability
 *
 * Public. Two modes:
 *   - `t` query param present: verify signed booking token (per-candidate
 *     flow from automation emails). Token is rate-limited per-token.
 *   - no `t`: anonymous global-link flow. Rate-limited per-IP. Used by the
 *     Calendly-style public booking page where visitors browse slots
 *     before identifying themselves.
 *
 * Either way, only built-in active configs are allowed.
 *
 * Query params:
 *   t       — signed booking token (optional)
 *   from    — ISO timestamp (optional; defaults to nowUtc)
 *   to      — ISO timestamp (optional; defaults to from + maxDaysOut)
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifyBookingToken } from '@/lib/scheduling/booking-links'
import { parseBookingRulesOrDefault } from '@/lib/scheduling/booking-rules'
import { getBusyIntervals } from '@/lib/scheduling/free-busy'
import { computeAvailableSlots, type BusyInterval } from '@/lib/scheduling/slot-computer'
import { bookingErrorMessage } from '@/lib/scheduling/error-messages'
import { recordGoogleAuthError } from '@/lib/google-auth-notifier'

// Per-key rate limiter (in-memory). 30 req/min. Same shape used for both
// the per-token (authoritative candidate flow) and per-IP (anonymous)
// modes — the key just differs.
const rateBuckets = new Map<string, { count: number; resetAt: number }>()
function rateLimitOk(key: string, max = 30): boolean {
  const now = Date.now()
  const cur = rateBuckets.get(key)
  if (!cur || now >= cur.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (cur.count >= max) return false
  cur.count++
  return true
}

export async function GET(request: NextRequest, { params }: { params: { configId: string } }) {
  const url = new URL(request.url)
  const t = url.searchParams.get('t')

  // ── Auth + rate limiting ──
  // These all run before config is loaded, so no workspace contact email
  // is available to interpolate into the friendly message.
  if (t) {
    const verified = verifyBookingToken(t)
    if (!verified.ok) {
      return NextResponse.json({ error: 'invalid_token', message: bookingErrorMessage('invalid_token'), reason: verified.reason }, { status: 401 })
    }
    if (verified.payload.purpose !== 'book') {
      return NextResponse.json({ error: 'wrong_purpose', message: bookingErrorMessage('wrong_purpose') }, { status: 401 })
    }
    if (verified.payload.configId !== params.configId) {
      return NextResponse.json({ error: 'config_mismatch', message: bookingErrorMessage('config_mismatch') }, { status: 401 })
    }
    if (!rateLimitOk(`tok:${t}`)) {
      return NextResponse.json({ error: 'rate_limited', message: bookingErrorMessage('rate_limited') }, { status: 429 })
    }
  } else {
    // Anonymous flow: rate limit per IP. Cheaper bucket (30/min/IP) is fine
    // since each unique IP only browses for a few minutes.
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (!rateLimitOk(`ip:${ip}:${params.configId}`)) {
      return NextResponse.json({ error: 'rate_limited', message: bookingErrorMessage('rate_limited') }, { status: 429 })
    }
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
      workspace: { select: { timezone: true, name: true, senderEmail: true } },
    },
  })
  if (!config || !config.isActive) {
    return NextResponse.json({ error: 'config_not_found', message: bookingErrorMessage('config_not_found') }, { status: 404 })
  }
  const contactEmail = config.workspace.senderEmail
  if (!config.useBuiltInScheduler) {
    return NextResponse.json({ error: 'built_in_disabled', message: bookingErrorMessage('built_in_disabled', { contactEmail }) }, { status: 409 })
  }

  const rules = parseBookingRulesOrDefault(config.bookingRules)
  const recruiterTimezone = config.workspace.timezone

  const nowUtc = new Date()
  const fromParam = url.searchParams.get('from')
  const toParam = url.searchParams.get('to')
  const fromUtc = fromParam ? new Date(fromParam) : nowUtc
  const toUtc = toParam
    ? new Date(toParam)
    : new Date(nowUtc.getTime() + rules.maxDaysOut * 24 * 60 * 60 * 1000)

  if (isNaN(fromUtc.getTime()) || isNaN(toUtc.getTime()) || toUtc <= fromUtc) {
    return NextResponse.json({ error: 'invalid_window', message: bookingErrorMessage('invalid_window', { contactEmail }) }, { status: 400 })
  }

  // Build the busy set from THREE sources so a recruiter can never be
  // double-booked:
  //   1. Google Calendar FreeBusy for THIS config's calendar
  //   2. Google Calendar FreeBusy for every OTHER active config's calendar
  //      in this workspace (covers the case where the same recruiter runs
  //      multiple booking links pointed at different calendar ids)
  //   3. Existing InterviewMeeting rows for this workspace — guaranteed
  //      signal in case a recent booking hasn't propagated to Google
  //      Calendar yet, or the calendar sync is mid-failure
  const otherConfigs = await prisma.schedulingConfig.findMany({
    where: {
      workspaceId: config.workspaceId,
      isActive: true,
      useBuiltInScheduler: true,
      NOT: { id: config.id },
    },
    select: { calendarId: true },
  })
  const calendarIds = new Set<string | undefined>()
  calendarIds.add(config.calendarId || undefined)
  for (const c of otherConfigs) {
    if (c.calendarId) calendarIds.add(c.calendarId)
  }

  const busyChunks: BusyInterval[][] = []
  // Track per-calendar errors so we can detect the "all calendars failed"
  // case. Previously a per-calendar `.catch` returned `[]` and we kept
  // marching — when EVERY calendar failed (e.g. workspace OAuth refresh
  // token revoked, returning invalid_grant on every freebusy call) the
  // picker rendered a fully-free grid. Candidates filled in name/email/
  // phone/notes, hit Confirm, and only THEN saw `free_busy_failed` from
  // the booking POST (which re-validates with bustCache). Fail at listing
  // time instead so the candidate sees the problem before they invest in
  // filling the form.
  let failedCalendars = 0
  let lastCalendarError: unknown = null
  try {
    const results = await Promise.all(
      Array.from(calendarIds).map((calId) =>
        getBusyIntervals({
          workspaceId: config.workspaceId,
          calendarId: calId,
          fromUtc,
          toUtc,
        }).catch((err) => {
          console.error('[availability] freeBusy failed for', calId, err)
          failedCalendars++
          lastCalendarError = err
          return [] as BusyInterval[]
        }),
      ),
    )
    busyChunks.push(...results)
  } catch (err) {
    console.error('[availability] freeBusy fan-out failed:', err)
    void recordGoogleAuthError(config.workspaceId, err)
    return NextResponse.json({
      error: 'free_busy_failed',
      message: bookingErrorMessage('free_busy_failed', { contactEmail }),
      detail: (err as Error).message,
    }, { status: 502 })
  }

  if (failedCalendars > 0 && failedCalendars === calendarIds.size) {
    // Every calendar threw. The integration is almost certainly broken at
    // the auth layer — notify the workspace owner so the picker doesn't
    // sit half-broken indefinitely.
    void recordGoogleAuthError(config.workspaceId, lastCalendarError)
    return NextResponse.json({
      error: 'free_busy_failed',
      message: bookingErrorMessage('free_busy_failed', { contactEmail }),
    }, { status: 502 })
  }

  // Existing meetings as a backstop. Includes the workspace's own bookings
  // through any config, even ones we couldn't pull from Google Calendar.
  const meetings = await prisma.interviewMeeting.findMany({
    where: {
      workspaceId: config.workspaceId,
      scheduledEnd: { gt: fromUtc },
      scheduledStart: { lt: toUtc },
    },
    select: { scheduledStart: true, scheduledEnd: true },
  })
  busyChunks.push(meetings.map((m) => ({ start: m.scheduledStart, end: m.scheduledEnd })))

  const busy = busyChunks.flat()

  const slots = computeAvailableSlots({
    rules,
    recruiterTimezone,
    busyIntervals: busy,
    fromUtc,
    toUtc,
    nowUtc,
  })

  return NextResponse.json({
    slots: slots.map((s) => ({ startUtc: s.startUtc.toISOString(), endUtc: s.endUtc.toISOString() })),
    rules: {
      durationMinutes: rules.durationMinutes,
      slotIntervalMinutes: rules.slotIntervalMinutes,
      minNoticeHours: rules.minNoticeHours,
      maxDaysOut: rules.maxDaysOut,
    },
    recruiterTimezone,
    workspaceName: config.workspace.name,
  })
}
