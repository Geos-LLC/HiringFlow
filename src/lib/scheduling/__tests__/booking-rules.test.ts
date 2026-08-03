import { describe, expect, it } from 'vitest'
import { defaultBookingRules, parseBookingRules, parseBookingRulesOrDefault } from '../booking-rules'

describe('defaultBookingRules', () => {
  it('returns a valid shape that re-parses', () => {
    const def = defaultBookingRules()
    const round = parseBookingRules(def)
    expect(round).toEqual(def)
  })

  it('defaults maxPerDay to null (no cap)', () => {
    expect(defaultBookingRules().maxPerDay).toBeNull()
  })
})

describe('parseBookingRules — maxPerDay', () => {
  const base = defaultBookingRules()

  it('treats missing maxPerDay as null (back-compat with pre-cap rows)', () => {
    const { maxPerDay: _, ...withoutCap } = base
    const parsed = parseBookingRules(withoutCap)
    expect(parsed.maxPerDay).toBeNull()
  })

  it('treats maxPerDay=0 as null', () => {
    const parsed = parseBookingRules({ ...base, maxPerDay: 0 })
    expect(parsed.maxPerDay).toBeNull()
  })

  it('accepts a positive integer within range', () => {
    const parsed = parseBookingRules({ ...base, maxPerDay: 5 })
    expect(parsed.maxPerDay).toBe(5)
  })

  it('rejects maxPerDay > 100', () => {
    expect(() => parseBookingRules({ ...base, maxPerDay: 101 })).toThrow(/maxPerDay/)
  })

  it('rejects non-integer maxPerDay', () => {
    expect(() => parseBookingRules({ ...base, maxPerDay: 3.5 })).toThrow(/maxPerDay/)
  })
})

describe('defaultBookingRules — working hours', () => {
  it('mon-fri populated, sat-sun empty', () => {
    const def = defaultBookingRules()
    expect(def.workingHours.mon.length).toBe(1)
    expect(def.workingHours.fri.length).toBe(1)
    expect(def.workingHours.sat).toEqual([])
    expect(def.workingHours.sun).toEqual([])
  })
})

describe('parseBookingRules — happy path', () => {
  it('accepts a minimal valid blob', () => {
    const rules = parseBookingRules({
      durationMinutes: 30,
      slotIntervalMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeHours: 0,
      maxDaysOut: 7,
      workingHours: {
        mon: [{ start: '09:00', end: '17:00' }],
        tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
      },
    })
    expect(rules.durationMinutes).toBe(30)
    expect(rules.workingHours.mon[0].start).toBe('09:00')
    expect(rules.workingHours.tue).toEqual([])
  })

  it('accepts multiple non-overlapping ranges per day', () => {
    const rules = parseBookingRules({
      ...defaultBookingRules(),
      workingHours: {
        mon: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }],
        tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
      },
    })
    expect(rules.workingHours.mon).toHaveLength(2)
  })

  it('treats omitted weekday key as empty', () => {
    const rules = parseBookingRules({
      durationMinutes: 30,
      slotIntervalMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeHours: 0,
      maxDaysOut: 7,
      workingHours: { mon: [{ start: '09:00', end: '17:00' }] },
    })
    expect(rules.workingHours.tue).toEqual([])
  })
})

describe('parseBookingRules — rejection cases', () => {
  it('rejects negative duration', () => {
    expect(() => parseBookingRules({ ...defaultBookingRules(), durationMinutes: -1 })).toThrow(/durationMinutes/)
  })

  it('rejects non-integer duration', () => {
    expect(() => parseBookingRules({ ...defaultBookingRules(), durationMinutes: 30.5 })).toThrow(/durationMinutes/)
  })

  it('rejects malformed HH:mm', () => {
    expect(() => parseBookingRules({
      ...defaultBookingRules(),
      workingHours: {
        ...defaultBookingRules().workingHours,
        mon: [{ start: '9:00', end: '17:00' }], // missing leading 0
      },
    })).toThrow(/start/)
  })

  it('rejects 24:00 (out of range)', () => {
    expect(() => parseBookingRules({
      ...defaultBookingRules(),
      workingHours: {
        ...defaultBookingRules().workingHours,
        mon: [{ start: '00:00', end: '24:00' }],
      },
    })).toThrow(/end/)
  })

  it('rejects end <= start', () => {
    expect(() => parseBookingRules({
      ...defaultBookingRules(),
      workingHours: {
        ...defaultBookingRules().workingHours,
        mon: [{ start: '17:00', end: '09:00' }],
      },
    })).toThrow(/end.*after start/)
  })

  it('rejects overlapping ranges within a day', () => {
    expect(() => parseBookingRules({
      ...defaultBookingRules(),
      workingHours: {
        ...defaultBookingRules().workingHours,
        mon: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }],
      },
    })).toThrow(/overlap/)
  })

  it('rejects unknown weekday key', () => {
    expect(() => parseBookingRules({
      ...defaultBookingRules(),
      workingHours: {
        ...defaultBookingRules().workingHours,
        monday: [{ start: '09:00', end: '17:00' }],
      },
    })).toThrow(/monday|unknown/)
  })

  it('rejects non-object input', () => {
    expect(() => parseBookingRules(null)).toThrow()
    expect(() => parseBookingRules('string')).toThrow()
    expect(() => parseBookingRules([])).toThrow()
  })
})

describe('parseBookingRulesOrDefault', () => {
  it('returns default for null', () => {
    expect(parseBookingRulesOrDefault(null)).toEqual(defaultBookingRules())
  })

  it('returns default for malformed', () => {
    expect(parseBookingRulesOrDefault({ garbage: 1 })).toEqual(defaultBookingRules())
  })

  it('returns parsed value for valid', () => {
    const valid = { ...defaultBookingRules(), durationMinutes: 60 }
    expect(parseBookingRulesOrDefault(valid).durationMinutes).toBe(60)
  })
})
