import { describe, expect, it } from 'vitest'
import {
  isForwardMcTransition,
  isTerminalMcStatus,
  MC_STATUS_RANK,
  normalizeWireStatus,
  type McSimulationStatus,
} from '../status-ladder'

const ALL: McSimulationStatus[] = [
  'queued',
  'ringing',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
]

describe('status-ladder — normalizeWireStatus', () => {
  it('accepts every canonical MC wire status', () => {
    expect(normalizeWireStatus('queued')).toBe('queued')
    expect(normalizeWireStatus('ringing')).toBe('ringing')
    expect(normalizeWireStatus('in-progress')).toBe('in_progress')
    expect(normalizeWireStatus('completed')).toBe('completed')
    expect(normalizeWireStatus('failed')).toBe('failed')
    expect(normalizeWireStatus('cancelled')).toBe('cancelled')
  })
  it('returns null for unknown wire forms', () => {
    expect(normalizeWireStatus('')).toBeNull()
    expect(normalizeWireStatus('unknown')).toBeNull()
    expect(normalizeWireStatus('IN_PROGRESS')).toBeNull() // strict casing
  })
})

describe('status-ladder — isTerminalMcStatus', () => {
  it('true for completed / failed / cancelled', () => {
    expect(isTerminalMcStatus('completed')).toBe(true)
    expect(isTerminalMcStatus('failed')).toBe(true)
    expect(isTerminalMcStatus('cancelled')).toBe(true)
  })
  it('false for pre-terminal statuses', () => {
    expect(isTerminalMcStatus('queued')).toBe(false)
    expect(isTerminalMcStatus('ringing')).toBe(false)
    expect(isTerminalMcStatus('in_progress')).toBe(false)
  })
  it('false for unknown strings (defensive against MC contract drift)', () => {
    expect(isTerminalMcStatus('anything-else')).toBe(false)
  })
})

describe('status-ladder — isForwardMcTransition', () => {
  it('accepts strictly-forward transitions along the happy path', () => {
    expect(isForwardMcTransition('queued', 'ringing')).toBe(true)
    expect(isForwardMcTransition('ringing', 'in_progress')).toBe(true)
    expect(isForwardMcTransition('in_progress', 'completed')).toBe(true)
  })
  it('accepts skip-ahead transitions (queued → completed / failed)', () => {
    expect(isForwardMcTransition('queued', 'completed')).toBe(true)
    expect(isForwardMcTransition('queued', 'failed')).toBe(true)
    expect(isForwardMcTransition('ringing', 'failed')).toBe(true)
  })
  it('rejects no-op transitions', () => {
    for (const s of ALL) expect(isForwardMcTransition(s, s)).toBe(false)
  })
  it('rejects regressive transitions', () => {
    expect(isForwardMcTransition('ringing', 'queued')).toBe(false)
    expect(isForwardMcTransition('in_progress', 'ringing')).toBe(false)
  })
  it('rejects transitions FROM any terminal (absorbing)', () => {
    for (const from of ['completed', 'failed', 'cancelled'] as const) {
      for (const to of ALL) {
        expect(isForwardMcTransition(from, to)).toBe(false)
      }
    }
  })
  it('rejects transitions between different terminals (completed ↛ failed)', () => {
    expect(isForwardMcTransition('completed', 'failed')).toBe(false)
    expect(isForwardMcTransition('failed', 'completed')).toBe(false)
    expect(isForwardMcTransition('completed', 'cancelled')).toBe(false)
  })
})

describe('status-ladder — MC_STATUS_RANK invariants', () => {
  it('ranks pre-terminal statuses strictly ascending', () => {
    expect(MC_STATUS_RANK.queued).toBeLessThan(MC_STATUS_RANK.ringing)
    expect(MC_STATUS_RANK.ringing).toBeLessThan(MC_STATUS_RANK.in_progress)
    expect(MC_STATUS_RANK.in_progress).toBeLessThan(MC_STATUS_RANK.completed)
  })
  it('places all terminals at the same rank', () => {
    expect(MC_STATUS_RANK.completed).toBe(MC_STATUS_RANK.failed)
    expect(MC_STATUS_RANK.completed).toBe(MC_STATUS_RANK.cancelled)
  })
})
