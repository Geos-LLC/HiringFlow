import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  applyMcSimulationState,
  applyMcWireStatus,
} from '../apply-simulation-state'
import type { McSimulationStatus } from '../status-ladder'

type Row = {
  id: string
  status: McSimulationStatus
  mcCallId: string | null
  ringingAt: Date | null
  answeredAt: Date | null
  completedAt: Date | null
  failedAt: Date | null
  failureReason: string | null
  resultProjection: unknown | null
}

const SIM_ID = 'sim-1'

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: SIM_ID,
    status: 'queued',
    mcCallId: null,
    ringingAt: null,
    answeredAt: null,
    completedAt: null,
    failedAt: null,
    failureReason: null,
    resultProjection: null,
    ...overrides,
  }
}

function makePrisma(row: Row | null) {
  const state = { row }
  return {
    state,
    mcSimulation: {
      findUnique: vi.fn(async () => (state.row ? { ...state.row } : null)),
      updateMany: vi.fn(async (args: {
        where: { id: string; status?: { in: string[] }; mcCallId?: null }
        data: Partial<Row>
      }) => {
        if (!state.row) return { count: 0 }
        if (args.where.id !== state.row.id) return { count: 0 }
        if (args.where.status?.in) {
          const allowed = new Set(args.where.status.in)
          if (!allowed.has(state.row.status)) return { count: 0 }
        }
        if (args.where.mcCallId === null && state.row.mcCallId !== null) return { count: 0 }
        state.row = { ...state.row, ...args.data } as Row
        return { count: 1 }
      }),
    },
  }
}

describe('applyMcSimulationState — forward transitions', () => {
  it('advances queued → ringing on the happy path', async () => {
    const p = makePrisma(makeRow({ status: 'queued' }))
    const result = await applyMcSimulationState(p as never, {
      simulationId: SIM_ID,
      toStatus: 'ringing',
      ringingAt: new Date('2026-09-10T00:00:01Z'),
    })
    expect(result).toEqual({ applied: true, newStatus: 'ringing' })
    expect(p.state.row!.status).toBe('ringing')
    expect(p.state.row!.ringingAt).toEqual(new Date('2026-09-10T00:00:01Z'))
  })

  it('acceptance criterion: idempotent on no-change (already at target)', async () => {
    const p = makePrisma(makeRow({ status: 'ringing' }))
    const result = await applyMcSimulationState(p as never, {
      simulationId: SIM_ID,
      toStatus: 'ringing',
    })
    expect(result).toEqual({ applied: false, reason: 'no_change' })
  })

  it('acceptance criterion: out-of-order / regressive event is absorbed', async () => {
    const p = makePrisma(makeRow({ status: 'in_progress' }))
    const result = await applyMcSimulationState(p as never, {
      simulationId: SIM_ID,
      toStatus: 'ringing',
    })
    expect(result).toEqual({ applied: false, reason: 'regressive' })
    expect(p.state.row!.status).toBe('in_progress')
  })

  it('acceptance criterion: terminal state absorbs a later event', async () => {
    const p = makePrisma(makeRow({ status: 'completed', completedAt: new Date() }))
    const result = await applyMcSimulationState(p as never, {
      simulationId: SIM_ID,
      toStatus: 'failed',
    })
    expect(result).toEqual({ applied: false, reason: 'terminal' })
    expect(p.state.row!.status).toBe('completed')
  })

  it('acceptance criterion: partial terminal result is passed through unchanged (no fabrication)', async () => {
    const p = makePrisma(makeRow({ status: 'in_progress' }))
    const partial = {
      overallScore: null,
      passed: null,
      summary: null,
      sessionId: null,
      deepLinkUrl: 'https://mockcustomer.example/x',
    }
    const result = await applyMcSimulationState(p as never, {
      simulationId: SIM_ID,
      toStatus: 'completed',
      completedAt: new Date(),
      result: partial,
    })
    expect(result).toEqual({ applied: true, newStatus: 'completed' })
    expect(p.state.row!.resultProjection).toEqual(partial)
  })

  it('acceptance criterion: race — concurrent transition sees count=0 and reports no_change', async () => {
    // Simulate a race by making updateMany return count=0 on the first
    // call (as if a concurrent writer beat us to the advance).
    const p = makePrisma(makeRow({ status: 'queued' }))
    p.mcSimulation.updateMany.mockImplementationOnce(async () => ({ count: 0 }))
    const result = await applyMcSimulationState(p as never, {
      simulationId: SIM_ID,
      toStatus: 'ringing',
    })
    expect(result).toEqual({ applied: false, reason: 'no_change' })
  })

  it('reports row_not_found when the simulation does not exist', async () => {
    const p = makePrisma(null)
    const result = await applyMcSimulationState(p as never, {
      simulationId: 'nonexistent',
      toStatus: 'ringing',
    })
    expect(result).toEqual({ applied: false, reason: 'row_not_found' })
  })

  it('back-fills mcCallId on same-status update (webhook-before-response race)', async () => {
    // Simulate the race: HF row is at 'queued' with mcCallId=null (dial
    // response hasn't returned yet). A queued webhook arrives and we
    // "no-op" on status but MUST record the mcCallId for future
    // reconciliation.
    const p = makePrisma(makeRow({ status: 'queued', mcCallId: null }))
    const result = await applyMcSimulationState(p as never, {
      simulationId: SIM_ID,
      toStatus: 'queued',
      mcCallId: 'call-abc',
    })
    expect(result).toEqual({ applied: false, reason: 'no_change' })
    expect(p.state.row!.mcCallId).toBe('call-abc')
  })
})

describe('applyMcWireStatus — wire-to-local normalization', () => {
  it('maps in-progress (kebab) to in_progress (snake) and advances', async () => {
    const p = makePrisma(makeRow({ status: 'ringing' }))
    const result = await applyMcWireStatus(p as never, {
      simulationId: SIM_ID,
      wireStatus: 'in-progress',
    })
    expect(result).toEqual({ applied: true, newStatus: 'in_progress' })
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })
})
