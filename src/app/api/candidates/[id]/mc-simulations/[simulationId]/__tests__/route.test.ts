/**
 * Polling route: /api/candidates/[id]/mc-simulations/[simulationId]
 *
 * Acceptance coverage — polling reconciliation:
 *   - Non-terminal row WITH mcCallId → calls MC's status endpoint and
 *     applies the returned status through the same forward-only helper.
 *   - Non-terminal row WITHOUT mcCallId → no MC round-trip (dial hasn't
 *     landed yet).
 *   - Terminal row → no MC round-trip.
 *   - Cross-workspace access → 404.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'

process.env.NEXTAUTH_SECRET = 'test-secret-for-pr1b-poll-route'
const MOCK_SECRET = 'whsec_test_' + 'x'.repeat(48)

const { sessions, sims, mappings, prismaMock, sessionsSpy, fetchSpy } = vi.hoisted(() => {
  const sessions = new Map<string, { id: string; workspaceId: string }>()
  const sims = new Map<string, unknown>()
  const mappings = new Map<string, unknown>()
  const sessionsSpy = { session: null as { workspaceId: string; userId: string } | null }
  const fetchSpy = { impl: vi.fn() as ReturnType<typeof vi.fn> }
  const prismaMock = {
    session: {
      findFirst: vi.fn(async ({ where }: any) => {
        const c = sessions.get(where.id)
        if (!c || c.workspaceId !== where.workspaceId) return null
        return c
      }),
    },
    mcSimulation: {
      findFirst: vi.fn(async ({ where }: any) => {
        const row = sims.get(where.id) as any
        if (!row) return null
        if (
          row.workspaceId !== where.workspaceId ||
          row.candidateId !== where.candidateId
        ) {
          return null
        }
        return { ...row }
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const row = sims.get(where.id) as any
        return row ? { ...row } : null
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = sims.get(where.id) as any
        if (!row) return { count: 0 }
        if (where.status?.in) {
          if (!(where.status.in as string[]).includes(row.status)) return { count: 0 }
        }
        Object.assign(row, data)
        return { count: 1 }
      }),
    },
    mcWorkspaceMapping: {
      findUnique: vi.fn(async ({ where }: any) => mappings.get(where.workspaceId) ?? null),
    },
  }
  return { sessions, sims, mappings, prismaMock, sessionsSpy, fetchSpy }
})

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/auth', () => ({
  getWorkspaceSession: vi.fn(async () => sessionsSpy.session),
  unauthorized: () =>
    new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}))

// eslint-disable-next-line import/first
import { GET } from '../route'
// eslint-disable-next-line import/first
import { encryptMcSecret } from '@/lib/mockcustomer/encryption'

function seedSim(overrides: Partial<{ id: string; status: string; mcCallId: string | null }> = {}) {
  const id = overrides.id ?? 'sim-1'
  sims.set(id, {
    id,
    workspaceId: 'ws-1',
    candidateId: 'cand-1',
    status: overrides.status ?? 'ringing',
    mcCallId: overrides.mcCallId === undefined ? 'mc-call-1' : overrides.mcCallId,
    ringingAt: null,
    answeredAt: null,
    completedAt: null,
    failedAt: null,
    failureReason: null,
    resultProjection: null,
  })
}

function seedMapping() {
  mappings.set('ws-1', {
    workspaceId: 'ws-1',
    mcOrganizationId: 'mc-org-1',
    mcOrganizationSlug: 'hf-canary',
    mcApiKeyEncrypted: encryptMcSecret('mc_test_abc'),
    mcWebhookSecretEncrypted: encryptMcSecret(MOCK_SECRET),
    mcEnvironment: 'test',
    canaryEnabled: true,
  })
}

function req(): import('next/server').NextRequest {
  return new Request(
    'https://hf.example/api/candidates/cand-1/mc-simulations/sim-1',
    { method: 'GET' },
  ) as unknown as import('next/server').NextRequest
}

beforeEach(() => {
  sessions.clear()
  sims.clear()
  mappings.clear()
  sessionsSpy.session = { workspaceId: 'ws-1', userId: 'u-1' }
  sessions.set('cand-1', { id: 'cand-1', workspaceId: 'ws-1' })
  seedMapping()
  vi.clearAllMocks()
  fetchSpy.impl = vi.fn()
  globalThis.fetch = fetchSpy.impl as unknown as typeof fetch
})

describe('GET /api/candidates/[id]/mc-simulations/[simulationId] — auth', () => {
  it('acceptance criterion: 404 on cross-workspace access', async () => {
    sessions.set('cand-1', { id: 'cand-1', workspaceId: 'other-ws' })
    const res = await GET(req(), {
      params: { id: 'cand-1', simulationId: 'sim-1' },
    })
    expect(res.status).toBe(404)
  })

  it('401 when unauthenticated', async () => {
    sessionsSpy.session = null
    const res = await GET(req(), {
      params: { id: 'cand-1', simulationId: 'sim-1' },
    })
    expect(res.status).toBe(401)
  })

  it('404 when the simulation is under a different candidate', async () => {
    seedSim()
    // Sim's candidateId is cand-1 (from seed). Query for another id.
    const other = new Request(
      'https://hf.example/api/candidates/other-cand/mc-simulations/sim-1',
      { method: 'GET' },
    ) as unknown as import('next/server').NextRequest
    sessions.set('other-cand', { id: 'other-cand', workspaceId: 'ws-1' })
    const res = await GET(other, {
      params: { id: 'other-cand', simulationId: 'sim-1' },
    })
    expect(res.status).toBe(404)
  })
})

describe('GET — polling reconciliation', () => {
  it('acceptance criterion: reconciles non-terminal row via MC status endpoint when webhook is absent', async () => {
    seedSim({ status: 'ringing', mcCallId: 'mc-call-abc' })
    fetchSpy.impl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          callId: 'mc-call-abc',
          status: 'completed',
          durationSec: 42,
          queuedAt: '2026-09-10T00:00:00.000Z',
          ringingAt: '2026-09-10T00:00:01.000Z',
          answeredAt: '2026-09-10T00:00:05.000Z',
          completedAt: '2026-09-10T00:01:12.000Z',
          failedAt: null,
          failureReason: null,
          summary: null,
          recordingUrl: null,
        }),
        { status: 200 },
      ),
    )
    const res = await GET(req(), {
      params: { id: 'cand-1', simulationId: 'sim-1' },
    })
    expect(res.status).toBe(200)
    expect(fetchSpy.impl).toHaveBeenCalledOnce()
    const url = fetchSpy.impl.mock.calls[0]![0] as string
    expect(url).toContain('/v1/external-simulations/call/mc-call-abc')
    // Row got advanced to completed via the shared forward-only helper.
    expect((sims.get('sim-1') as any).status).toBe('completed')
  })

  it('does NOT round-trip to MC when the row is already terminal', async () => {
    seedSim({ status: 'completed', mcCallId: 'mc-call-abc' })
    const res = await GET(req(), {
      params: { id: 'cand-1', simulationId: 'sim-1' },
    })
    expect(res.status).toBe(200)
    expect(fetchSpy.impl).not.toHaveBeenCalled()
  })

  it('does NOT round-trip to MC when mcCallId is not yet set (dial in flight)', async () => {
    seedSim({ status: 'queued', mcCallId: null })
    const res = await GET(req(), {
      params: { id: 'cand-1', simulationId: 'sim-1' },
    })
    expect(res.status).toBe(200)
    expect(fetchSpy.impl).not.toHaveBeenCalled()
  })

  it('degrades gracefully — MC 500 does not fail the poll (returns shadow row)', async () => {
    seedSim({ status: 'ringing', mcCallId: 'mc-call-abc' })
    fetchSpy.impl.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const res = await GET(req(), {
      params: { id: 'cand-1', simulationId: 'sim-1' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { simulation: { status: string } }
    // Row unchanged.
    expect(body.simulation.status).toBe('ringing')
  })
})
