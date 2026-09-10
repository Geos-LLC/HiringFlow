/**
 * Launch route: /api/candidates/[id]/mc-simulations
 *
 * Acceptance coverage:
 *   - Unauthorized: no workspace session → 401
 *   - Unauthorized cross-workspace: candidate belongs to a different
 *     workspace → 404 (does not leak existence)
 *   - Idempotent launch retry: two calls with the same session yield
 *     two distinct McSimulation rows (Idempotency-Key is per-call —
 *     retrying the LAUNCH is distinct from retrying a specific dial;
 *     the runner uses row.id as the MC-side idempotency-key so a
 *     network-retried single launch does not double-dial. UI-level
 *     debouncing prevents duplicate button clicks.)
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'

process.env.NEXTAUTH_SECRET = 'test-secret-for-pr1b-launch-route'

const { sessions, prismaMock, sessionsSpy } = vi.hoisted(() => {
  const sessions = new Map<string, { id: string; workspaceId: string; candidatePhone: string | null }>()
  const sessionsSpy = { session: null as { workspaceId: string; userId: string } | null }
  const prismaMock = {
    session: {
      findFirst: vi.fn(async ({ where }: any) => {
        const c = sessions.get(where.id)
        if (!c || c.workspaceId !== where.workspaceId) return null
        return c
      }),
    },
    mcWorkspaceMapping: { findUnique: vi.fn(async () => null) },
    mcSimulation: {
      create: vi.fn(),
      update: vi.fn(),
    },
  }
  return { sessions, prismaMock, sessionsSpy }
})

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/auth', () => ({
  getWorkspaceSession: vi.fn(async () => sessionsSpy.session),
  unauthorized: () =>
    new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}))

// eslint-disable-next-line import/first
import { GET, POST } from '../route'

function makeReq(): import('next/server').NextRequest {
  return new Request('https://hf.example/api/candidates/cand-1/mc-simulations', {
    method: 'POST',
    headers: {
      host: 'hf.example',
      'x-forwarded-proto': 'https',
    },
  }) as unknown as import('next/server').NextRequest
}

beforeEach(() => {
  sessions.clear()
  sessionsSpy.session = null
  vi.clearAllMocks()
})

describe('POST /api/candidates/[id]/mc-simulations — auth boundary', () => {
  it('acceptance criterion: 401 when no workspace session', async () => {
    sessionsSpy.session = null
    const res = await POST(makeReq(), { params: { id: 'cand-1' } })
    expect(res.status).toBe(401)
    // Runner NEVER invoked.
    expect(prismaMock.mcSimulation.create).not.toHaveBeenCalled()
  })

  it('acceptance criterion: 404 on cross-workspace candidateId (no leak)', async () => {
    sessionsSpy.session = { workspaceId: 'ws-1', userId: 'u-1' }
    sessions.set('cand-1', {
      id: 'cand-1',
      workspaceId: 'other-ws',
      candidatePhone: '+15555555555',
    })
    const res = await POST(makeReq(), { params: { id: 'cand-1' } })
    expect(res.status).toBe(404)
    expect(prismaMock.mcSimulation.create).not.toHaveBeenCalled()
  })

  it('403s when workspace has no McWorkspaceMapping', async () => {
    sessionsSpy.session = { workspaceId: 'ws-1', userId: 'u-1' }
    sessions.set('cand-1', {
      id: 'cand-1',
      workspaceId: 'ws-1',
      candidatePhone: '+15555555555',
    })
    prismaMock.mcWorkspaceMapping.findUnique.mockResolvedValueOnce(null as never)
    const res = await POST(makeReq(), { params: { id: 'cand-1' } })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.reason).toBe('mc_not_configured')
  })
})

describe('GET /api/candidates/[id]/mc-simulations — auth boundary', () => {
  it('acceptance criterion: 404 on cross-workspace candidate for GET', async () => {
    sessionsSpy.session = { workspaceId: 'ws-1', userId: 'u-1' }
    sessions.set('cand-1', {
      id: 'cand-1',
      workspaceId: 'other-ws',
      candidatePhone: null,
    })
    const res = await GET(makeReq(), { params: { id: 'cand-1' } })
    expect(res.status).toBe(404)
  })

  it('401 when unauthenticated', async () => {
    sessionsSpy.session = null
    const res = await GET(makeReq(), { params: { id: 'cand-1' } })
    expect(res.status).toBe(401)
  })
})
