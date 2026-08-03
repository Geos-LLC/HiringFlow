/**
 * Pure slot-computation for the in-app booking page. No I/O — takes
 * BookingRules, busy intervals, and a window; returns UTC slot timestamps.
 *
 * Timezone handling uses Intl.DateTimeFormat (built-in) instead of date-fns-tz
 * to avoid a new dep. The helpers `zonedTimeToUtc` / `getTzOffsetMinutes`
 * are accurate for IANA zones and handle DST transitions correctly.
 *
 * Edge cases explicitly addressed:
 *   - DST spring-forward: the lost wall-clock hour is skipped (zonedTimeToUtc
 *     returns null, slots in that range are dropped).
 *   - DST fall-back: the repeated wall-clock hour resolves to the first
 *     occurrence (the standard-time interpretation).
 *   - Slot end past working-hour window: dropped.
 *   - Slot start before now + minNoticeHours: dropped.
 *   - Slot end past now + maxDaysOut: dropped.
 *   - Busy interval expanded by bufferBefore (subtracted from busy.start) and
 *     bufferAfter (added to busy.end). A candidate slot collides if the
 *     expanded-busy and the slot intersect on a half-open interval basis.
 */

import type { BookingRules, Weekday, WorkingHourRange } from './booking-rules'

export interface BusyInterval {
  start: Date
  end: Date
}

export interface Slot {
  startUtc: Date
  endUtc: Date
}

export interface ComputeAvailableSlotsOpts {
  rules: BookingRules
  recruiterTimezone: string
  busyIntervals: BusyInterval[]
  /** Window start, UTC. Defaults to nowUtc. */
  fromUtc?: Date
  /** Window end, UTC. Defaults to nowUtc + maxDaysOut * 24h. */
  toUtc?: Date
  /** Current time, UTC. Injectable for deterministic tests. */
  nowUtc: Date
  /** Hard cap on slots returned. Defaults to 200 to keep payloads small. */
  maxSlots?: number
  /**
   * Map of `YYYY-MM-DD` (in `recruiterTimezone`) → count of already-booked
   * meetings on that day for this config. When `rules.maxPerDay` is set,
   * days at or above the cap are skipped entirely. Caller (availability
   * endpoint) queries `InterviewMeeting` filtered to the same
   * `schedulingConfigId` and populates this map.
   */
  bookedCountsByDay?: Record<string, number>
}

const WEEKDAY_KEYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
//                                ^ JS Date.getDay() returns 0=Sunday..6=Saturday.

interface ZonedYMD {
  year: number
  month: number // 1-12
  day: number   // 1-31
  hour: number
  minute: number
  weekday: number // 0=Sun..6=Sat per Date.getDay() convention
}

const tzPartsCache = new Map<string, Intl.DateTimeFormat>()
function getTzFormatter(tz: string): Intl.DateTimeFormat {
  let f = tzPartsCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      weekday: 'short',
    })
    tzPartsCache.set(tz, f)
  }
  return f
}

const SHORT_WEEKDAY: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

export function zonedFromUtc(utc: Date, tz: string): ZonedYMD {
  const parts = getTzFormatter(tz).formatToParts(utc)
  const map: Record<string, string> = {}
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value
  }
  // Intl returns hour="24" at midnight on some runtimes; normalize to 0.
  let hour = parseInt(map.hour, 10)
  if (hour === 24) hour = 0
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour,
    minute: parseInt(map.minute, 10),
    weekday: SHORT_WEEKDAY[map.weekday] ?? 0,
  }
}

/**
 * Offset (in minutes) east of UTC for the given UTC instant in tz.
 * America/New_York in winter: -300; in summer: -240.
 */
export function getTzOffsetMinutes(utc: Date, tz: string): number {
  const z = zonedFromUtc(utc, tz)
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute)
  // Round to nearest minute to absorb the second/ms component the formatter strips.
  const utcMin = Math.floor(utc.getTime() / 60000) * 60000
  return Math.round((asUtc - utcMin) / 60000)
}

/**
 * Convert a wall-clock time in `tz` to a UTC Date.
 * Returns null when the wall-clock time does not exist (DST spring-forward
 * gap, e.g. 02:30 on 2026-03-08 in America/New_York).
 *
 * For the DST fall-back case (wall-clock time is ambiguous, e.g. 01:30 on
 * 2026-11-01 in America/New_York occurs twice), this returns the *first*
 * occurrence (the pre-fallback / standard-time interpretation). This matches
 * Calendly's behavior and is what users expect.
 */
export function zonedTimeToUtc(
  year: number, month: number, day: number, hour: number, minute: number, tz: string,
): Date | null {
  // Pass 1: interpret components as if they were UTC.
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute))
  // Find the offset at *that* instant in the target tz, then adjust.
  let off = getTzOffsetMinutes(candidate, tz)
  candidate = new Date(candidate.getTime() - off * 60_000)
  // Pass 2: re-check; offset may differ if we crossed a DST boundary.
  let off2 = getTzOffsetMinutes(candidate, tz)
  if (off2 !== off) {
    candidate = new Date(new Date(Date.UTC(year, month - 1, day, hour, minute)).getTime() - off2 * 60_000)
  }
  // Verify the result actually represents the requested wall time.
  const z = zonedFromUtc(candidate, tz)
  if (z.year !== year || z.month !== month || z.day !== day || z.hour !== hour || z.minute !== minute) {
    return null
  }
  return candidate
}

function parseHHMMToMinutes(s: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s)
  if (!m) return NaN
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

interface ExpandedBusy {
  start: number // ms epoch
  end: number   // ms epoch
}

function expandBusy(intervals: BusyInterval[], bufferBeforeMs: number, bufferAfterMs: number): ExpandedBusy[] {
  const out: ExpandedBusy[] = []
  for (const i of intervals) {
    out.push({
      start: i.start.getTime() - bufferBeforeMs,
      end: i.end.getTime() + bufferAfterMs,
    })
  }
  // Sort + merge overlaps so the slot loop below can break early.
  out.sort((a, b) => a.start - b.start)
  const merged: ExpandedBusy[] = []
  for (const cur of out) {
    if (merged.length === 0 || cur.start > merged[merged.length - 1].end) {
      merged.push({ ...cur })
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, cur.end)
    }
  }
  return merged
}

/** Half-open overlap: [a.start, a.end) intersects [b.start, b.end)? */
function overlapsAny(slotStart: number, slotEnd: number, busy: ExpandedBusy[]): boolean {
  // Linear scan is fine — busy lists for a 14-day window are tiny.
  for (const b of busy) {
    if (slotStart < b.end && slotEnd > b.start) return true
    if (b.start >= slotEnd) break // sorted; no further overlap possible
  }
  return false
}

export function computeAvailableSlots(opts: ComputeAvailableSlotsOpts): Slot[] {
  const { rules, recruiterTimezone, busyIntervals, nowUtc } = opts
  const fromUtc = opts.fromUtc ?? nowUtc
  const toUtc = opts.toUtc ?? new Date(nowUtc.getTime() + rules.maxDaysOut * 24 * 60 * 60 * 1000)
  const maxSlots = opts.maxSlots ?? 200

  const earliestStartMs = nowUtc.getTime() + rules.minNoticeHours * 60 * 60 * 1000
  const latestEndMs = Math.min(
    toUtc.getTime(),
    nowUtc.getTime() + rules.maxDaysOut * 24 * 60 * 60 * 1000,
  )

  const durationMs = rules.durationMinutes * 60 * 1000
  const slotIntervalMs = rules.slotIntervalMinutes * 60 * 1000
  const busy = expandBusy(
    busyIntervals,
    rules.bufferBeforeMinutes * 60 * 1000,
    rules.bufferAfterMinutes * 60 * 1000,
  )

  const out: Slot[] = []

  const bookedCounts = opts.bookedCountsByDay ?? {}
  const dayCap = rules.maxPerDay

  // Iterate calendar days in the recruiter's timezone. Start from the
  // recruiter-local day of `fromUtc`; stop after maxDaysOut days or once we
  // pass `toUtc`.
  const startDay = zonedFromUtc(fromUtc, recruiterTimezone)
  for (let dayOffset = 0; dayOffset < rules.maxDaysOut + 2; dayOffset++) {
    // Compute the calendar day at startDay + dayOffset using a UTC anchor
    // (works because we only care about Y-M-D, then re-zone for ranges).
    const anchor = new Date(Date.UTC(startDay.year, startDay.month - 1, startDay.day))
    anchor.setUTCDate(anchor.getUTCDate() + dayOffset)
    const Y = anchor.getUTCFullYear()
    const M = anchor.getUTCMonth() + 1
    const D = anchor.getUTCDate()
    // Determine the weekday of (Y, M, D) — using a noon UTC instant in the
    // target tz to avoid edge-case wrap at midnight.
    const noonAnchorUtc = new Date(Date.UTC(Y, M - 1, D, 12))
    const weekdayInTz = zonedFromUtc(noonAnchorUtc, recruiterTimezone).weekday
    const weekdayKey = WEEKDAY_KEYS[weekdayInTz]
    const ranges: WorkingHourRange[] = rules.workingHours[weekdayKey] ?? []
    if (ranges.length === 0) continue

    // Per-day cap: skip the entire day when this config already has
    // `maxPerDay` non-cancelled meetings on this recruiter-local calendar
    // day. Caller supplies bookedCountsByDay keyed by YYYY-MM-DD.
    if (dayCap != null) {
      const dayKey = `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`
      if ((bookedCounts[dayKey] ?? 0) >= dayCap) continue
    }

    for (const range of ranges) {
      const startMin = parseHHMMToMinutes(range.start)
      const endMin = parseHHMMToMinutes(range.end)
      const startH = Math.floor(startMin / 60)
      const startM = startMin % 60
      const endH = Math.floor(endMin / 60)
      const endM = endMin % 60

      const rangeStartUtc = zonedTimeToUtc(Y, M, D, startH, startM, recruiterTimezone)
      const rangeEndUtc = zonedTimeToUtc(Y, M, D, endH, endM, recruiterTimezone)
      if (!rangeStartUtc || !rangeEndUtc) continue
      if (rangeEndUtc.getTime() <= rangeStartUtc.getTime()) continue

      // Walk slot starts on slotIntervalMs grid. Iterate until either out of
      // range or out of window.
      for (let t = rangeStartUtc.getTime(); t + durationMs <= rangeEndUtc.getTime(); t += slotIntervalMs) {
        const slotStart = t
        const slotEnd = t + durationMs
        if (slotStart < earliestStartMs) continue
        if (slotEnd > latestEndMs) {
          // Past the end-of-window — no further slots in this range or future ranges.
          break
        }
        if (overlapsAny(slotStart, slotEnd, busy)) continue
        out.push({ startUtc: new Date(slotStart), endUtc: new Date(slotEnd) })
        if (out.length >= maxSlots) return out
      }
    }
  }

  return out
}
