/**
 * Comprehensive webhook receiver test suite covering the PR1B acceptance
 * criteria that are receiver-side: duplicate event, race between
 * webhook and dial response, invalid signature, stale timestamp, wrong
 * secret, out-of-order/regressive events, terminal absorption, partial
 * terminal result.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createHmac } from 'crypto'

process.env.NEXTAUTH_SECRET = 'test-secret-for-pr1b-webhook'
const SECRET = 'whsec_test_' + 'x'.repeat(48)

interface McSim {
  id: string
  workspaceId: string
  status: string
  mcCallId: string | null
  ringingAt: Date | null
  answeredAt: Date | null
  completedAt: Date | null
  failedAt: Date | null
  failureReason: string | null
  resultProjection: unknown | null
}
interface McMapping {
  workspaceId: string
  mcWebhookSecretEncrypted: string
}
interface McEvent {
  id: string
  mcEventId: string
  mcSimulationId: string
  mcCallId: string | null
  eventType: string
  payload: unknown
  receivedAt: Date
}

// encryption.ts has no prisma dependency, so a static import here is
// safe — vitest hoists vi.mock() calls above ALL imports.
// eslint-disable-next-line import/first
import { encryptMcSecret } from '@/lib/mockcustomer/encryption'

const { sims, mappings, events, prismaMock, MockPrismaKnownError } = vi.hoisted(() => {
  const sims = new Map<string, unknown>()
  const mappings = new Map<string, unknown>()
  const events = new Map<string, unknown>()

  // Shared error class — same reference used inside the hoisted mock
  // AND surfaced through the mocked @prisma/client so `err instanceof
  // Prisma.PrismaClientKnownRequestError` inside the receiver matches.
  class MockPrismaKnownError extends Error {
    code: string
    meta: unknown
    constructor(message: string, args: { code: string; meta?: unknown }) {
      super(message)
      this.name = 'PrismaClientKnownRequestError'
      this.code = args.code
      this.meta = args.meta
    }
  }

  function ladderAllowed(current: string, target: string): boolean {
    if (current === target) return false
    const rank: Record<string, number> = {
      queued: 0,
      ringing: 1,
      in_progress: 2,
      completed: 3,
      failed: 3,
      cancelled: 3,
    }
    const terminals = new Set(['completed', 'failed', 'cancelled'])
    if (terminals.has(current)) return false
    return (rank[target] ?? -1) > (rank[current] ?? -1)
  }

  // Declared with explicit `any` typing (rather than inferred) so it
  // can reference itself inside $transaction — otherwise TS would
  // infer an implicit-any circular type.
  const prismaMock: any = {
    mcSimulation: {
      findUnique: vi.fn(async ({ where }: any) => sims.get(where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: any): Promise<{ count: number }> => {
        const row = sims.get(where.id) as any
        if (!row) return { count: 0 }
        if (where.status?.in) {
          if (!(where.status.in as string[]).includes(row.status)) return { count: 0 }
        }
        if (data.status && !ladderAllowed(row.status, data.status)) {
          // metadata-only path — allow the mcCallId back-fill on same-status
          if (row.status === data.status && !row.mcCallId && data.mcCallId) {
            Object.assign(row, { mcCallId: data.mcCallId })
          }
          return { count: 0 }
        }
        Object.assign(row, data)
        return { count: 1 }
      }),
    },
    mcWorkspaceMapping: {
      findUnique: vi.fn(async ({ where }: any) => mappings.get(where.workspaceId) ?? null),
    },
    mcWebhookEvent: {
      create: vi.fn(async ({ data }: any): Promise<{ id: string }> => {
        if (events.has(data.mcEventId)) {
          throw new MockPrismaKnownError('unique constraint failed', {
            code: 'P2002',
            meta: { target: ['mcEventId'] },
          })
        }
        events.set(data.mcEventId, { ...data, id: 'ev-' + data.mcEventId })
        return { id: 'ev-' + data.mcEventId, ...data }
      }),
    },
    $transaction: vi.fn(async (fn: (tx: any) => any) => fn(prismaMock)),
  }
  return { sims, mappings, events, prismaMock, MockPrismaKnownError }
})

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

// Replace @prisma/client's `Prisma.PrismaClientKnownRequestError` with
// the SAME class instance our hoisted mock throws, so the receiver's
// `err instanceof Prisma.PrismaClientKnownRequestError` matches.
vi.mock('@prisma/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    Prisma: {
      ...(actual as any).Prisma,
      PrismaClientKnownRequestError: MockPrismaKnownError,
    },
  }
})

// Import AFTER mocks. vi.mock() is hoisted, so a static import here
// picks up the mocked prisma / @prisma/client — no top-level await
// needed. Kept below all vi.mock() calls for readability.
// eslint-disable-next-line import/first
import { POST } from '../route'

function makeSignedRequest(body: unknown, secret = SECRET, tOffsetSec = 0) {
  const raw = JSON.stringify(body)
  const t = Math.floor(Date.now() / 1000) + tOffsetSec
  const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')
  const req = new Request('https://hf.example/api/webhooks/mockcustomer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MC-Signature': `t=${t},v1=${v1}`,
    },
    body: raw,
  })
  return req as unknown as import('next/server').NextRequest
}

function seedSim(id: string, overrides: Partial<McSim> = {}) {
  sims.set(id, {
    id,
    workspaceId: 'ws-1',
    status: 'queued',
    mcCallId: null,
    ringingAt: null,
    answeredAt: null,
    completedAt: null,
    failedAt: null,
    failureReason: null,
    resultProjection: null,
    ...overrides,
  })
}

function seedMapping(workspaceId = 'ws-1') {
  mappings.set(workspaceId, {
    workspaceId,
    mcWebhookSecretEncrypted: encryptMcSecret(SECRET),
  })
}

function makeEvent(overrides: Partial<{ eventId: string; type: string; status: string; clientRef: string | null; callId: string | null; result: unknown }> = {}) {
  return {
    eventId: overrides.eventId ?? '11111111-1111-1111-1111-111111111111',
    type: overrides.type ?? 'external_call.queued',
    createdAt: new Date().toISOString(),
    apiVersion: '2026-09-09',
    data: {
      callId: overrides.callId === undefined ? 'mc-call-1' : overrides.callId,
      clientReferenceId: overrides.clientRef === undefined ? 'sim-1' : overrides.clientRef,
      organizationId: 'mc-org-1',
      organizationSlug: 'hf-canary',
      status: overrides.status ?? 'queued',
      queuedAt: '2026-09-10T00:00:00.000Z',
      ringingAt: null,
      answeredAt: null,
      completedAt: null,
      failedAt: null,
      durationSec: null,
      failureReason: null,
      ...(overrides.result !== undefined ? { result: overrides.result } : {}),
    },
  }
}

beforeEach(() => {
  sims.clear()
  mappings.clear()
  events.clear()
  vi.clearAllMocks()
  seedMapping('ws-1')
})

describe('mc-webhook receiver — authentication', () => {
  it('acceptance criterion: rejects invalid signature (401)', async () => {
    seedSim('sim-1')
    const body = makeEvent()
    const raw = JSON.stringify(body)
    const t = Math.floor(Date.now() / 1000)
    const req = new Request('https://hf.example/api/webhooks/mockcustomer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MC-Signature': `t=${t},v1=${'0'.repeat(64)}`,
      },
      body: raw,
    }) as any
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('acceptance criterion: rejects stale timestamp (> 300s)', async () => {
    seedSim('sim-1')
    const req = makeSignedRequest(makeEvent(), SECRET, -400)
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.reason).toBe('timestamp_skew')
  })

  it('acceptance criterion: rejects wrong secret', async () => {
    seedSim('sim-1')
    const req = makeSignedRequest(makeEvent(), 'whsec_wrong_secret')
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('rejects missing signature header', async () => {
    seedSim('sim-1')
    const raw = JSON.stringify(makeEvent())
    const req = new Request('https://hf.example/api/webhooks/mockcustomer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw,
    }) as any
    // Note: no signature → we still need to load the mapping first, so
    // the receiver reaches the verifier which returns missing_header.
    const res = await POST(req)
    // 400 (malformed/missing) — either code is a valid rejection.
    expect([400, 401]).toContain(res.status)
  })
})

describe('mc-webhook receiver — correlation', () => {
  it('rejects a body missing clientReferenceId (contract violation)', async () => {
    seedSim('sim-1')
    const req = makeSignedRequest(makeEvent({ clientRef: null }))
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('missing_client_reference_id')
  })

  it('returns 404 when clientReferenceId does not correspond to any McSimulation', async () => {
    // No seed — the receiver looks up 'sim-1' and finds nothing.
    const req = makeSignedRequest(makeEvent({ clientRef: 'sim-does-not-exist' }))
    const res = await POST(req)
    expect(res.status).toBe(404)
  })
})

describe('mc-webhook receiver — exactly-once + idempotency', () => {
  it('acceptance criterion: duplicate event (same eventId) is a 200 no-op', async () => {
    seedSim('sim-1')
    const evt = makeEvent()
    const req1 = makeSignedRequest(evt)
    const res1 = await POST(req1)
    expect(res1.status).toBe(200)
    const req2 = makeSignedRequest(evt)
    const res2 = await POST(req2)
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.duplicate).toBe(true)
    // Only ONE McWebhookEvent row.
    expect(events.size).toBe(1)
  })
})

describe('mc-webhook receiver — forward-only state application', () => {
  it('advances McSimulation queued → ringing on the .ringing event', async () => {
    seedSim('sim-1', { status: 'queued' })
    const req = makeSignedRequest(
      makeEvent({ eventId: 'ev-r-1', type: 'external_call.ringing', status: 'ringing' }),
    )
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect((sims.get('sim-1') as any).status).toBe('ringing')
  })

  it('acceptance criterion: out-of-order / regressive event is absorbed (200, no state change)', async () => {
    seedSim('sim-1', { status: 'in_progress' })
    const req = makeSignedRequest(
      makeEvent({ eventId: 'ev-r-2', type: 'external_call.ringing', status: 'ringing' }),
    )
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect((sims.get('sim-1') as any).status).toBe('in_progress')
  })

  it('acceptance criterion: terminal state absorbs a later regressive event', async () => {
    seedSim('sim-1', { status: 'completed', completedAt: new Date() })
    const req = makeSignedRequest(
      makeEvent({ eventId: 'ev-r-3', type: 'external_call.failed', status: 'failed' }),
    )
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect((sims.get('sim-1') as any).status).toBe('completed')
  })

  it('acceptance criterion: partial terminal result is stored verbatim, nulls preserved', async () => {
    seedSim('sim-1', { status: 'in_progress' })
    const partial = {
      overallScore: null,
      passed: null,
      summary: null,
      sessionId: null,
      deepLinkUrl: 'https://mockcustomer.example/x',
    }
    const req = makeSignedRequest(
      makeEvent({
        eventId: 'ev-c-1',
        type: 'external_call.completed',
        status: 'completed',
        result: partial,
      }),
    )
    const res = await POST(req)
    expect(res.status).toBe(200)
    const row = sims.get('sim-1') as any
    expect(row.status).toBe('completed')
    expect(row.resultProjection).toEqual(partial)
  })

  it('acceptance criterion: webhook-before-dial-response race — clientReferenceId lookup succeeds even when mcCallId is null', async () => {
    // McSimulation exists (dial has run row.create) but the dial's
    // HTTP response hasn't returned to HF yet, so mcCallId is still
    // null. The first .queued webhook arrives with clientReferenceId
    // = McSimulation.id. It MUST be applied without requiring
    // mcCallId on the row.
    seedSim('sim-1', { status: 'queued', mcCallId: null })
    const req = makeSignedRequest(
      makeEvent({ eventId: 'ev-q-1', type: 'external_call.queued', status: 'queued' }),
    )
    const res = await POST(req)
    expect(res.status).toBe(200)
    // The receiver back-fills mcCallId on same-status via the
    // updateMany metadata path.
    expect((sims.get('sim-1') as any).mcCallId).toBe('mc-call-1')
  })
})

describe('mc-webhook receiver — no candidate/pipeline side effects', () => {
  it('touches ONLY mcSimulation + mcWebhookEvent + mcWorkspaceMapping', async () => {
    // The prismaMock only exposes those three tables; if the receiver
    // touched anything else (session, pipeline, aICallCandidate, etc.)
    // the mock would throw. This test succeeds by NOT throwing.
    seedSim('sim-1')
    const req = makeSignedRequest(makeEvent())
    const res = await POST(req)
    expect(res.status).toBe(200)
  })
})
