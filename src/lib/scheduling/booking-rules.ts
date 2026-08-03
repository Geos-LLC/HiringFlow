/**
 * BookingRules — per-SchedulingConfig configuration for the in-app slot
 * picker. Stored as a JSON blob on SchedulingConfig.bookingRules so we can
 * evolve the shape without schema migrations on a project that has no
 * migration history.
 *
 * All times in `workingHours` are interpreted in the recruiter's
 * (workspace) timezone. Storage of resulting booking timestamps is in UTC.
 */

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface WorkingHourRange {
  start: string // "HH:mm" 24h, e.g. "09:00"
  end: string   // "HH:mm" 24h, e.g. "17:00"
}

export type WorkingHours = Record<Weekday, WorkingHourRange[]>

export interface BookingRules {
  durationMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minNoticeHours: number
  maxDaysOut: number
  slotIntervalMinutes: number
  workingHours: WorkingHours
  /**
   * Optional cap on interviews per calendar day (in the workspace timezone),
   * counted per SchedulingConfig. When the day already has this many booked
   * (non-cancelled) meetings, the picker hides all remaining slots for the
   * day and the booking POST rejects with `daily_cap_reached`. `null` = no
   * cap.
   */
  maxPerDay: number | null
}

const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export function defaultBookingRules(): BookingRules {
  const weekdayHours: WorkingHourRange[] = [{ start: '09:00', end: '17:00' }]
  return {
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 15,
    minNoticeHours: 2,
    maxDaysOut: 14,
    slotIntervalMinutes: 30,
    workingHours: {
      mon: [...weekdayHours],
      tue: [...weekdayHours],
      wed: [...weekdayHours],
      thu: [...weekdayHours],
      fri: [...weekdayHours],
      sat: [],
      sun: [],
    },
    maxPerDay: null,
  }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function parseHHMM(s: string): number | null {
  const m = HHMM.exec(s)
  if (!m) return null
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

class RuleError extends Error {
  constructor(public field: string, message: string) {
    super(`bookingRules.${field}: ${message}`)
    this.name = 'BookingRuleError'
  }
}

function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new RuleError(field, `must be an integer (got ${typeof v})`)
  }
  if (v < min || v > max) {
    throw new RuleError(field, `must be between ${min} and ${max} (got ${v})`)
  }
  return v
}

function parseRange(raw: unknown, field: string): WorkingHourRange {
  if (!isObject(raw)) throw new RuleError(field, 'must be an object {start,end}')
  const startStr = raw.start
  const endStr = raw.end
  if (typeof startStr !== 'string' || typeof endStr !== 'string') {
    throw new RuleError(field, 'start/end must be strings (HH:mm)')
  }
  const startMin = parseHHMM(startStr)
  const endMin = parseHHMM(endStr)
  if (startMin === null) throw new RuleError(`${field}.start`, `invalid HH:mm "${startStr}"`)
  if (endMin === null) throw new RuleError(`${field}.end`, `invalid HH:mm "${endStr}"`)
  if (endMin <= startMin) {
    throw new RuleError(field, `end (${endStr}) must be after start (${startStr})`)
  }
  return { start: startStr, end: endStr }
}

function parseWorkingHours(raw: unknown): WorkingHours {
  if (!isObject(raw)) throw new RuleError('workingHours', 'must be an object keyed by weekday')
  const out = {} as WorkingHours
  for (const day of WEEKDAYS) {
    const dayRaw = raw[day]
    if (dayRaw === undefined || dayRaw === null) {
      out[day] = []
      continue
    }
    if (!Array.isArray(dayRaw)) {
      throw new RuleError(`workingHours.${day}`, 'must be an array of {start,end}')
    }
    const ranges = dayRaw.map((r, i) => parseRange(r, `workingHours.${day}[${i}]`))
    // Disallow overlapping ranges within the same day — slot computation
    // assumes ranges are disjoint and would otherwise produce duplicate slots.
    const sorted = [...ranges].sort((a, b) => parseHHMM(a.start)! - parseHHMM(b.start)!)
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = parseHHMM(sorted[i - 1].end)!
      const curStart = parseHHMM(sorted[i].start)!
      if (curStart < prevEnd) {
        throw new RuleError(`workingHours.${day}`, 'ranges overlap')
      }
    }
    out[day] = ranges
  }
  // Reject any extra keys (typos like "monday" instead of "mon").
  const allowed = new Set<string>(WEEKDAYS)
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) {
      throw new RuleError(`workingHours.${k}`, 'unknown weekday key (use mon/tue/wed/thu/fri/sat/sun)')
    }
  }
  return out
}

export function parseBookingRules(input: unknown): BookingRules {
  if (!isObject(input)) {
    throw new RuleError('', 'must be an object')
  }
  const durationMinutes = int(input.durationMinutes, 'durationMinutes', 5, 8 * 60)
  const slotIntervalMinutes = int(input.slotIntervalMinutes, 'slotIntervalMinutes', 5, 8 * 60)
  const bufferBeforeMinutes = int(input.bufferBeforeMinutes, 'bufferBeforeMinutes', 0, 8 * 60)
  const bufferAfterMinutes = int(input.bufferAfterMinutes, 'bufferAfterMinutes', 0, 8 * 60)
  const minNoticeHours = int(input.minNoticeHours, 'minNoticeHours', 0, 30 * 24)
  const maxDaysOut = int(input.maxDaysOut, 'maxDaysOut', 1, 365)
  const workingHours = parseWorkingHours(input.workingHours)
  // maxPerDay is optional and nullable — undefined / null / 0 all mean "no
  // cap". Positive integer 1..100 caps the day. Historical rows written
  // before this field existed omit it entirely; treat those as uncapped.
  let maxPerDay: number | null = null
  if (input.maxPerDay !== undefined && input.maxPerDay !== null && input.maxPerDay !== 0) {
    maxPerDay = int(input.maxPerDay, 'maxPerDay', 1, 100)
  }
  return {
    durationMinutes,
    slotIntervalMinutes,
    bufferBeforeMinutes,
    bufferAfterMinutes,
    minNoticeHours,
    maxDaysOut,
    workingHours,
    maxPerDay,
  }
}

/**
 * Lenient parse — returns defaults if the JSON is missing/invalid. Used for
 * read paths where we don't want a malformed config to 500 the whole page.
 * Write paths must use parseBookingRules to surface errors to the user.
 */
export function parseBookingRulesOrDefault(input: unknown): BookingRules {
  if (input === null || input === undefined) return defaultBookingRules()
  try {
    return parseBookingRules(input)
  } catch {
    return defaultBookingRules()
  }
}
