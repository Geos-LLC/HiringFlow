import { describe, expect, it } from 'vitest'
import { defaultBookingRules } from '../booking-rules'
import {
  computeAvailableSlots,
  getTzOffsetMinutes,
  zonedFromUtc,
  zonedTimeToUtc,
} from '../slot-computer'

const NY = 'America/New_York'

describe('zonedFromUtc / getTzOffsetMinutes', () => {
  it('returns -300 in NY winter', () => {
    // 2026-01-15 12:00 UTC → 07:00 EST
    const utc = new Date('2026-01-15T12:00:00Z')
    expect(getTzOffsetMinutes(utc, NY)).toBe(-300)
    const z = zonedFromUtc(utc, NY)
    expect(z).toMatchObject({ year: 2026, month: 1, day: 15, hour: 7, minute: 0 })
  })

  it('returns -240 in NY summer', () => {
    // 2026-07-15 12:00 UTC → 08:00 EDT
    const utc = new Date('2026-07-15T12:00:00Z')
    expect(getTzOffsetMinutes(utc, NY)).toBe(-240)
    expect(zonedFromUtc(utc, NY).hour).toBe(8)
  })
})

describe('zonedTimeToUtc', () => {
  it('round-trips a normal time', () => {
    const utc = zonedTimeToUtc(2026, 6, 15, 9, 0, NY)
    expect(utc).not.toBeNull()
    // 9am EDT = 13:00 UTC
    expect(utc!.toISOString()).toBe('2026-06-15T13:00:00.000Z')
  })

  it('handles winter standard time', () => {
    const utc = zonedTimeToUtc(2026, 1, 15, 9, 0, NY)
    // 9am EST = 14:00 UTC
    expect(utc!.toISOString()).toBe('2026-01-15T14:00:00.000Z')
  })

  it('returns null for the DST spring-forward gap (NY 2026 = March 8)', () => {
    // 02:30 on 2026-03-08 in NY does not exist (jumps from 02:00 EST to 03:00 EDT).
    const utc = zonedTimeToUtc(2026, 3, 8, 2, 30, NY)
    expect(utc).toBeNull()
  })

  it('resolves DST fall-back (NY 2026 = November 1) to first occurrence', () => {
    // 01:30 happens twice on 2026-11-01: once at -04 (EDT) and once at -05 (EST).
    // We expect the first occurrence (EDT, 05:30 UTC).
    const utc = zonedTimeToUtc(2026, 11, 1, 1, 30, NY)
    expect(utc!.toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })
})

function rules(overrides: Partial<ReturnType<typeof defaultBookingRules>> = {}) {
  return { ...defaultBookingRules(), ...overrides }
}

describe('computeAvailableSlots — basic', () => {
  it('produces 16 slots on a working Monday with 30m duration / 30m interval / no busy', () => {
    // Mon 2026-01-12, 9:00-17:00 EST = 16 half-hour slots starting on the half-hour grid.
    const nowUtc = new Date('2026-01-12T05:00:00Z') // 0:00 EST Mon
    const slots = computeAvailableSlots({
      rules: rules({
        minNoticeHours: 0,
        maxDaysOut: 1,
        bufferAfterMinutes: 0,
      }),
      recruiterTimezone: NY,
      busyIntervals: [],
      nowUtc,
    })
    // First slot 9:00 EST = 14:00 UTC; last slot starts at 16:30 EST = 21:30 UTC, ends at 17:00 EST = 22:00 UTC.
    expect(slots).toHaveLength(16)
    expect(slots[0].startUtc.toISOString()).toBe('2026-01-12T14:00:00.000Z')
    expect(slots[slots.length - 1].startUtc.toISOString()).toBe('2026-01-12T21:30:00.000Z')
  })

  it('returns no slots on a Saturday (sat=[])', () => {
    // Sat 2026-01-10
    const nowUtc = new Date('2026-01-10T00:00:00Z')
    const slots = computeAvailableSlots({
      rules: rules({ maxDaysOut: 1, minNoticeHours: 0 }),
      recruiterTimezone: NY,
      busyIntervals: [],
      nowUtc,
    })
    expect(slots).toHaveLength(0)
  })
})

describe('computeAvailableSlots — minNoticeHours', () => {
  it('drops slots before now + minNoticeHours', () => {
    // Now: Mon 2026-01-12 14:00 UTC = 9:00 EST. minNotice 4h → first eligible slot >= 13:00 EST = 18:00 UTC.
    const nowUtc = new Date('2026-01-12T14:00:00Z')
    const slots = computeAvailableSlots({
      rules: rules({ minNoticeHours: 4, maxDaysOut: 1, bufferAfterMinutes: 0 }),
      recruiterTimezone: NY,
      busyIntervals: [],
      nowUtc,
    })
    // First slot must be >= 18:00 UTC (13:00 EST).
    expect(slots.length).toBeGreaterThan(0)
    expect(slots[0].startUtc.getTime()).toBeGreaterThanOrEqual(new Date('2026-01-12T18:00:00Z').getTime())
  })
})

describe('computeAvailableSlots — buffers and busy', () => {
  it('drops slots fully inside busy', () => {
    const nowUtc = new Date('2026-01-12T05:00:00Z')
    const busy = [{ start: new Date('2026-01-12T15:00:00Z'), end: new Date('2026-01-12T16:00:00Z') }]
    const slots = computeAvailableSlots({
      rules: rules({ minNoticeHours: 0, maxDaysOut: 1, bufferAfterMinutes: 0 }),
      recruiterTimezone: NY,
      busyIntervals: busy,
      nowUtc,
    })
    // No slot whose [start,end) overlaps [15:00,16:00) UTC.
    for (const s of slots) {
      const overlaps = s.startUtc.getTime() < busy[0].end.getTime() && s.endUtc.getTime() > busy[0].start.getTime()
      expect(overlaps).toBe(false)
    }
  })

  it('respects bufferAfter on a busy interval', () => {
    const nowUtc = new Date('2026-01-12T05:00:00Z')
    // Busy 14:00-15:00 UTC (9-10 EST). bufferAfter 30m → expanded busy [14:00, 15:30).
    const busy = [{ start: new Date('2026-01-12T14:00:00Z'), end: new Date('2026-01-12T15:00:00Z') }]
    const slots = computeAvailableSlots({
      rules: rules({ minNoticeHours: 0, maxDaysOut: 1, bufferBeforeMinutes: 0, bufferAfterMinutes: 30 }),
      recruiterTimezone: NY,
      busyIntervals: busy,
      nowUtc,
    })
    const startsIso = new Set(slots.map((s) => s.startUtc.toISOString()))
    // 10:00 EST (15:00 UTC) slot = [15:00, 15:30) — overlaps expanded busy → blocked.
    expect(startsIso.has('2026-01-12T15:00:00.000Z')).toBe(false)
    // 10:30 EST (15:30 UTC) slot = [15:30, 16:00) — touches the buffer-end exactly (half-open) → allowed.
    expect(startsIso.has('2026-01-12T15:30:00.000Z')).toBe(true)
    // 9:00 EST (14:00 UTC) slot = [14:00, 14:30) — fully inside busy → blocked.
    expect(startsIso.has('2026-01-12T14:00:00.000Z')).toBe(false)
  })

  it('respects bufferBefore on a busy interval', () => {
    const nowUtc = new Date('2026-01-12T05:00:00Z')
    // Busy 16:00-17:00 UTC (11-12 EST). bufferBefore 30m → expanded busy [15:30, 17:00).
    const busy = [{ start: new Date('2026-01-12T16:00:00Z'), end: new Date('2026-01-12T17:00:00Z') }]
    const slots = computeAvailableSlots({
      rules: rules({ minNoticeHours: 0, maxDaysOut: 1, bufferBeforeMinutes: 30, bufferAfterMinutes: 0 }),
      recruiterTimezone: NY,
      busyIntervals: busy,
      nowUtc,
    })
    const startsIso = new Set(slots.map((s) => s.startUtc.toISOString()))
    // 10:30 EST (15:30 UTC) slot = [15:30, 16:00) — fully inside expanded busy → blocked.
    expect(startsIso.has('2026-01-12T15:30:00.000Z')).toBe(false)
    // 10:00 EST (15:00 UTC) slot = [15:00, 15:30) — touches buffer-start exactly (half-open) → allowed.
    expect(startsIso.has('2026-01-12T15:00:00.000Z')).toBe(true)
    // 9:30 EST (14:30 UTC) slot = [14:30, 15:00) — entirely before buffer → allowed.
    expect(startsIso.has('2026-01-12T14:30:00.000Z')).toBe(true)
  })
})

describe('computeAvailableSlots — DST spring-forward', () => {
  it('skips the lost hour on 2026-03-08 in NY', () => {
    // Sun 2026-03-08 — but Sunday has no working hours by default; force one.
    const r = rules({
      minNoticeHours: 0,
      maxDaysOut: 1,
      bufferAfterMinutes: 0,
      slotIntervalMinutes: 30,
      durationMinutes: 30,
      workingHours: {
        ...defaultBookingRules().workingHours,
        sun: [{ start: '01:00', end: '04:00' }],
      },
    })
    const nowUtc = new Date('2026-03-08T00:00:00Z')
    const slots = computeAvailableSlots({
      rules: r,
      recruiterTimezone: NY,
      busyIntervals: [],
      nowUtc,
    })
    // Wall clock jumps 02:00 EST → 03:00 EDT. The 02:00, 02:30 wall slots
    // do not exist; the 01:00-01:30 slots are EST (-05) and the 03:00-03:30
    // slots are EDT (-04). After 03:00 wall, the range ends at 04:00 wall.
    // Result: only 01:00, 01:30, 03:00, 03:30 are valid wall-clock starts.
    const wallClock = slots.map((s) => zonedFromUtc(s.startUtc, NY))
    const hourMins = wallClock.map((w) => `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`)
    expect(hourMins).toEqual(['01:00', '01:30', '03:00', '03:30'])
  })
})

describe('computeAvailableSlots — multi-day', () => {
  it('returns slots across multiple weekdays, skipping weekends', () => {
    // Now: Fri 2026-01-09 14:00 UTC = 9:00 EST.
    const nowUtc = new Date('2026-01-09T14:00:00Z')
    const slots = computeAvailableSlots({
      rules: rules({ minNoticeHours: 0, maxDaysOut: 7, bufferAfterMinutes: 0 }),
      recruiterTimezone: NY,
      busyIntervals: [],
      nowUtc,
      maxSlots: 1000,
    })
    // Fri 1/9 (16 slots) + Mon 1/12 + Tue 1/13 + Wed 1/14 + Thu 1/15 (16 each).
    // Fri 1/16 starts but 7d window may not include all of it depending on start time.
    // Easiest assertion: weekend dates are absent.
    const dayKeys = new Set(slots.map((s) => zonedFromUtc(s.startUtc, NY).day))
    expect(dayKeys.has(10)).toBe(false) // Sat
    expect(dayKeys.has(11)).toBe(false) // Sun
    expect(dayKeys.has(9)).toBe(true)
    expect(dayKeys.has(12)).toBe(true)
  })
})

describe('computeAvailableSlots — caps', () => {
  it('honours maxSlots', () => {
    const nowUtc = new Date('2026-01-12T05:00:00Z')
    const slots = computeAvailableSlots({
      rules: rules({ minNoticeHours: 0, maxDaysOut: 14, bufferAfterMinutes: 0 }),
      recruiterTimezone: NY,
      busyIntervals: [],
      nowUtc,
      maxSlots: 5,
    })
    expect(slots).toHaveLength(5)
  })
})

describe('computeAvailableSlots — maxPerDay', () => {
  it('drops entire day when booked count meets maxPerDay', () => {
    // Now: Mon 2026-01-12 05:00 UTC = 0:00 EST. Mon+Tue in window.
    const nowUtc = new Date('2026-01-12T05:00:00Z')
    const slots = computeAvailableSlots({
      rules: rules({
        minNoticeHours: 0,
        maxDaysOut: 2,
        bufferAfterMinutes: 0,
        maxPerDay: 2,
      }),
      recruiterTimezone: NY,
      busyIntervals: [],
      nowUtc,
      bookedCountsByDay: {
        '2026-01-12': 2, // Mon at cap
        '2026-01-13': 1, // Tue below cap
      },
      maxSlots: 1000,
    })
    const dayKeys = new Set(slots.map((s) => zonedFromUtc(s.startUtc, NY).day))
    expect(dayKeys.has(12)).toBe(false) // Mon dropped
    expect(dayKeys.has(13)).toBe(true)  // Tue kept
  })

  it('is a no-op when maxPerDay is null', () => {
    const nowUtc = new Date('2026-01-12T05:00:00Z')
    const withCap = computeAvailableSlots({
      rules: rules({ minNoticeHours: 0, maxDaysOut: 1, bufferAfterMinutes: 0, maxPerDay: null }),
      recruiterTimezone: NY,
      busyIntervals: [],
      nowUtc,
      bookedCountsByDay: { '2026-01-12': 99 }, // ignored
    })
    expect(withCap.length).toBe(16) // full Mon working day
  })

  it('treats booked count 0 as uncapped for that day', () => {
    const nowUtc = new Date('2026-01-12T05:00:00Z')
    const slots = computeAvailableSlots({
      rules: rules({ minNoticeHours: 0, maxDaysOut: 1, bufferAfterMinutes: 0, maxPerDay: 3 }),
      recruiterTimezone: NY,
      busyIntervals: [],
      nowUtc,
      bookedCountsByDay: {}, // no rows for Mon
    })
    expect(slots.length).toBe(16)
  })

  it('bucket key uses recruiter timezone, not UTC', () => {
    // A 22:00 EST slot on Mon 1/12 (03:00 UTC Tue 1/13) must count against
    // Mon in EST, not Tue in UTC. Force late-night working hours.
    const nowUtc = new Date('2026-01-12T05:00:00Z')
    const r = rules({
      minNoticeHours: 0,
      maxDaysOut: 1,
      bufferAfterMinutes: 0,
      maxPerDay: 1,
      workingHours: {
        ...defaultBookingRules().workingHours,
        mon: [{ start: '22:00', end: '23:30' }],
      },
    })
    const slots = computeAvailableSlots({
      rules: r,
      recruiterTimezone: NY,
      busyIntervals: [],
      nowUtc,
      bookedCountsByDay: { '2026-01-12': 1 }, // Mon EST — should drop even though the slot UTC is Tue
    })
    expect(slots).toHaveLength(0)
  })
})
