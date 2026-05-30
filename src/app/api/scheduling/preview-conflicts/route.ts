/**
 * POST /api/scheduling/preview-conflicts
 *
 * Recruiter-only diagnostic endpoint that powers the live "why is this day
 * empty?" panel inside the booking-rules editor. Mirrors the candidate-facing
 * availability route (busy sources, slot computer) but returns a per-day
 * breakdown — slot count + the busy intervals that overlap each working
 * window in the workspace timezone — so the recruiter can see exactly which
 * calendar event is killing a day before they save and preview.
 *
 * Body: { bookingRules, configId? }
 *   - bookingRules: the in-flight (unsaved) BookingRules from the editor
 *   - configId: optional. When editing an existing config, used to pick
 *     SchedulingConfig.calendarId. Omitted for new configs (the workspace
 *     default calendar is queried instead).
 *
 * Returns { days: PerDay[], totalSlots, calendarError? }
 *
 * Display cap: at most 14 days even if bookingRules.maxDaysOut is higher,
 * to keep the editor panel compact.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { parseBookingRules } from '@/lib/scheduling/booking-rules'
import type { WorkingHourRange, Weekday } from '@/lib/scheduling/booking-rules'
import { getBusyIntervals } from '@/lib/scheduling/free-busy'
import {
  computeAvailableSlots,
  zonedFromUtc,
  zonedTimeToUtc,
  type BusyInterval,
} from '@/lib/scheduling/slot-computer'

const PREVIEW_DAY_CAP = 14

const WEEKDAY_KEYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface PerDayBusy {
  start: string // HH:MM in workspace tz
  end: string
}

interface PerDay {
  date: string // YYYY-MM-DD in workspace tz
  weekday: Weekday
  workingRanges: WorkingHourRange[]
  busyIntervals: PerDayBusy[]
  slotCount: number
  reason: 'off' | 'window_too_short' | 'min_notice' | 'past_max_days' | 'calendar_conflict' | 'available' | 'unknown'
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatHHMM(date: Date, tz: string): string {
  const z = zonedFromUtc(date, tz)
  return `${pad2(z.hour)}:${pad2(z.minute)}`
}

function rangeMinutes(r: WorkingHourRange): number {
  const [sh, sm] = r.start.split(':').map(Number)
  const [eh, em] = r.end.split(':').map(Number)
  return eh * 60 + em - (sh * 60 + sm)
}

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = await request.json().catch(() => ({}))
  const bustCache = body.bustCache === true

  let rules
  try {
    rules = parseBookingRules(body.bookingRules)
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_booking_rules', message: (err as Error).message },
      { status: 400 },
    )
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: ws.workspaceId },
    select: { timezone: true },
  })
  if (!workspace) return NextResponse.json({ error: 'workspace_not_found' }, { status: 404 })
  const recruiterTimezone = workspace.timezone || 'UTC'

  // Optional configId: used to (a) pick THIS config's calendarId, and (b) so
  // the preview can include OTHER active workspace configs' calendars in the
  // busy set — mirroring availability/route.ts behavior.
  const configId: string | undefined = typeof body.configId === 'string' ? body.configId : undefined

  let primaryCalendarId: string | null = null
  if (configId) {
    const cfg = await prisma.schedulingConfig.findFirst({
      where: { id: configId, workspaceId: ws.workspaceId },
      select: { calendarId: true },
    })
    if (cfg) primaryCalendarId = cfg.calendarId
  }

  const otherConfigs = await prisma.schedulingConfig.findMany({
    where: {
      workspaceId: ws.workspaceId,
      isActive: true,
      useBuiltInScheduler: true,
      ...(configId ? { NOT: { id: configId } } : {}),
    },
    select: { calendarId: true },
  })

  // Set of calendarIds to query. `undefined` means "workspace default".
  const calendarIds = new Set<string | undefined>()
  calendarIds.add(primaryCalendarId || undefined)
  for (const c of otherConfigs) {
    if (c.calendarId) calendarIds.add(c.calendarId)
  }

  const nowUtc = new Date()
  const effectiveDays = Math.min(rules.maxDaysOut, PREVIEW_DAY_CAP)
  // Pad the upper window so a working range that extends past midnight of
  // day N still sees its overlapping busy events.
  const toUtc = new Date(nowUtc.getTime() + (effectiveDays + 1) * 24 * 60 * 60 * 1000)

  const busyChunks: BusyInterval[][] = []
  let failedCalendars = 0
  let calendarError: string | null = null
  await Promise.all(
    Array.from(calendarIds).map(async (calId) => {
      try {
        const chunk = await getBusyIntervals({
          workspaceId: ws.workspaceId,
          calendarId: calId,
          fromUtc: nowUtc,
          toUtc,
          bustCache,
        })
        busyChunks.push(chunk)
      } catch (err) {
        failedCalendars++
        calendarError = (err as Error).message
      }
    }),
  )

  // InterviewMeeting rows as a backstop — same as availability route.
  const meetings = await prisma.interviewMeeting.findMany({
    where: {
      workspaceId: ws.workspaceId,
      scheduledEnd: { gt: nowUtc },
      scheduledStart: { lt: toUtc },
    },
    select: { scheduledStart: true, scheduledEnd: true },
  })
  busyChunks.push(meetings.map((m) => ({ start: m.scheduledStart, end: m.scheduledEnd })))

  const busy = busyChunks.flat()

  // Run the same slot computer the candidate-facing endpoint uses.
  const slots = computeAvailableSlots({
    rules,
    recruiterTimezone,
    busyIntervals: busy,
    nowUtc,
    fromUtc: nowUtc,
    toUtc,
    maxSlots: 1000,
  })

  // Bucket slot count per workspace-local date.
  const slotCountByDate = new Map<string, number>()
  for (const s of slots) {
    const z = zonedFromUtc(s.startUtc, recruiterTimezone)
    const key = `${z.year}-${pad2(z.month)}-${pad2(z.day)}`
    slotCountByDate.set(key, (slotCountByDate.get(key) || 0) + 1)
  }

  const earliestStartMs = nowUtc.getTime() + rules.minNoticeHours * 60 * 60 * 1000
  const latestEndMs = nowUtc.getTime() + rules.maxDaysOut * 24 * 60 * 60 * 1000
  // A slot fits inside a working range when range_length >= durationMinutes.
  // bufferBefore/After expand busy intervals, not the working window — so they
  // don't enter the "is the window big enough?" check.
  const durationMs = rules.durationMinutes * 60 * 1000

  // Walk each day in workspace tz, build the per-day report.
  const startDay = zonedFromUtc(nowUtc, recruiterTimezone)
  const days: PerDay[] = []
  for (let dayOffset = 0; dayOffset < effectiveDays; dayOffset++) {
    const anchor = new Date(Date.UTC(startDay.year, startDay.month - 1, startDay.day))
    anchor.setUTCDate(anchor.getUTCDate() + dayOffset)
    const Y = anchor.getUTCFullYear()
    const M = anchor.getUTCMonth() + 1
    const D = anchor.getUTCDate()
    const noonAnchorUtc = new Date(Date.UTC(Y, M - 1, D, 12))
    const weekdayInTz = zonedFromUtc(noonAnchorUtc, recruiterTimezone).weekday
    const weekdayKey = WEEKDAY_KEYS[weekdayInTz]
    const ranges: WorkingHourRange[] = rules.workingHours[weekdayKey] ?? []
    const dateKey = `${Y}-${pad2(M)}-${pad2(D)}`

    if (ranges.length === 0) {
      // Off day — don't include. Editor toggles already show "Off".
      continue
    }

    // Collect busy intervals that fall within this day's working window
    // (clipped to the working ranges so 24h all-day events don't render
    // as e.g. "busy 00:00–23:59" — show the slice that's actually relevant).
    const dayBusy: PerDayBusy[] = []
    for (const range of ranges) {
      const [sh, sm] = range.start.split(':').map(Number)
      const [eh, em] = range.end.split(':').map(Number)
      const rangeStart = zonedTimeToUtc(Y, M, D, sh, sm, recruiterTimezone)
      const rangeEnd = zonedTimeToUtc(Y, M, D, eh, em, recruiterTimezone)
      if (!rangeStart || !rangeEnd) continue

      for (const b of busy) {
        const ovStart = Math.max(b.start.getTime(), rangeStart.getTime())
        const ovEnd = Math.min(b.end.getTime(), rangeEnd.getTime())
        if (ovEnd > ovStart) {
          dayBusy.push({
            start: formatHHMM(new Date(ovStart), recruiterTimezone),
            end: formatHHMM(new Date(ovEnd), recruiterTimezone),
          })
        }
      }
    }
    // Dedupe + sort
    const seen = new Set<string>()
    const dedupedBusy = dayBusy
      .filter((b) => {
        const k = `${b.start}|${b.end}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      .sort((a, b) => a.start.localeCompare(b.start))

    const count = slotCountByDate.get(dateKey) || 0
    let reason: PerDay['reason'] = 'available'
    if (count === 0) {
      // Diagnose. Priority: window-too-short > past-max-days > min-notice > calendar.
      const longestRangeMs = Math.max(...ranges.map(rangeMinutes)) * 60 * 1000
      if (longestRangeMs < durationMs) {
        reason = 'window_too_short'
      } else {
        // Does this day's earliest working range start fall past latestEndMs?
        const firstRange = ranges[0]
        const [fsh, fsm] = firstRange.start.split(':').map(Number)
        const firstStartUtc = zonedTimeToUtc(Y, M, D, fsh, fsm, recruiterTimezone)
        const lastRange = ranges[ranges.length - 1]
        const [leh, lem] = lastRange.end.split(':').map(Number)
        const lastEndUtc = zonedTimeToUtc(Y, M, D, leh, lem, recruiterTimezone)

        if (lastEndUtc && lastEndUtc.getTime() > latestEndMs) {
          reason = 'past_max_days'
        } else if (firstStartUtc && firstStartUtc.getTime() < earliestStartMs && lastEndUtc) {
          // Earliest possible slot start in this day = max(earliest, range start)
          // If even that can't fit a full duration into the range, blame min-notice.
          const effectiveStart = Math.max(firstStartUtc.getTime(), earliestStartMs)
          if (effectiveStart + durationMs > lastEndUtc.getTime()) {
            reason = 'min_notice'
          } else if (dedupedBusy.length > 0) {
            reason = 'calendar_conflict'
          } else {
            reason = 'unknown'
          }
        } else if (dedupedBusy.length > 0) {
          reason = 'calendar_conflict'
        } else {
          reason = 'unknown'
        }
      }
    }

    days.push({
      date: dateKey,
      weekday: weekdayKey,
      workingRanges: ranges,
      busyIntervals: dedupedBusy,
      slotCount: count,
      reason,
    })
  }

  return NextResponse.json({
    days,
    totalSlots: slots.length,
    recruiterTimezone,
    previewDayCap: PREVIEW_DAY_CAP,
    truncated: rules.maxDaysOut > PREVIEW_DAY_CAP,
    calendarError: failedCalendars === calendarIds.size && calendarIds.size > 0 ? calendarError : null,
  })
}
