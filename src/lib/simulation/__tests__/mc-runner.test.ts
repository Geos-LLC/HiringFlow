import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock @prisma/client's Prisma.PrismaClientKnownRequestError so the
// runner's `err instanceof Prisma.PrismaClientKnownRequestError`
// matches what our fake throws on P2002. Kept in vi.hoisted so the
// class is available to both the vi.mock factory (hoisted to top)
// and the makePrisma fake below.
const { MockPrismaKnownError } = vi.hoisted(() => {
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
  return { MockPrismaKnownError }
})

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

// eslint-disable-next-line import/first
import { McSimulationRunner } from '../mc-runner'
// eslint-disable-next-line import/first
import { SimulationLaunchError } from '../runner'
// eslint-disable-next-line import/first
import { encryptMcSecret } from '@/lib/mockcustomer/encryption'

// AES-256-GCM helpers derive their key from NEXTAUTH_SECRET (fallback).
// Set it before importing modules that call encrypt at module init — we
// don't have any such callers here, but keep it deterministic.
process.env.NEXTAUTH_SECRET = 'test-secret-for-pr1b-runner'

const WORKSPACE = 'ws-1'
const CANDIDATE = 'cand-1'
const USER = 'user-1'
const WEBHOOK_URL = 'https://hf.example/api/webhooks/mockcustomer'

interface McMappingRow {
  workspaceId: string
  mcOrganizationId: string
  mcOrganizationSlug: string
  mcApiKeyEncrypted: string
  mcWebhookSecretEncrypted: string
  mcEnvironment: string
  canaryEnabled: boolean
}

interface CandidateRow {
  id: string
  candidateName: string | null
  candidateEmail: string | null
  candidatePhone: string | null
  workspaceId: string
}

interface McSimulationRow {
  id: string
  status: string
  mcCallId: string | null
  failedAt: Date | null
  failureReason: string | null
  workspaceId: string
  candidateId: string
  launchedByUserId: string
  mcOrganizationId: string
  queuedAt: Date
  launchRequestId?: string | null
}

function makePrisma(opts: {
  mapping?: McMappingRow | null
  candidate?: CandidateRow | null
}) {
  const mappings = new Map<string, McMappingRow>()
  if (opts.mapping) mappings.set(opts.mapping.workspaceId, opts.mapping)
  const candidates = new Map<string, CandidateRow>()
  if (opts.candidate) candidates.set(opts.candidate.id, opts.candidate)
  const sims = new Map<string, McSimulationRow>()
  return {
    mcWorkspaceMapping: {
      findUnique: vi.fn(async (args: { where: { workspaceId: string } }) => {
        return mappings.get(args.where.workspaceId) ?? null
      }),
    },
    session: {
      findFirst: vi.fn(
        async (args: { where: { id: string; workspaceId: string } }) => {
          const c = candidates.get(args.where.id)
          if (!c || c.workspaceId !== args.where.workspaceId) return null
          return c
        },
      ),
    },
    mcSimulation: {
      create: vi.fn(async (args: { data: McSimulationRow }) => {
        // Enforce @@unique([workspaceId, launchRequestId]) — mirrors
        // the DB constraint. Concurrent-launch tests exercise this
        // path directly.
        if (args.data.launchRequestId != null) {
          for (const existing of Array.from(sims.values())) {
            if (
              existing.workspaceId === args.data.workspaceId &&
              existing.launchRequestId === args.data.launchRequestId
            ) {
              throw new MockPrismaKnownError('unique constraint failed', {
                code: 'P2002',
                meta: { target: ['workspace_id', 'launch_request_id'] },
              })
            }
          }
        }
        sims.set(args.data.id, {
          ...args.data,
          status: args.data.status ?? 'queued',
          mcCallId: null,
          failedAt: null,
          failureReason: null,
        })
        return sims.get(args.data.id)!
      }),
      findFirst: vi.fn(
        async (args: {
          where: { workspaceId: string; launchRequestId: string }
        }) => {
          for (const existing of Array.from(sims.values())) {
            if (
              existing.workspaceId === args.where.workspaceId &&
              existing.launchRequestId === args.where.launchRequestId
            ) {
              return existing
            }
          }
          return null
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string }
          data: Partial<McSimulationRow>
        }) => {
          const row = sims.get(args.where.id)
          if (!row) throw new Error('row not found: ' + args.where.id)
          Object.assign(row, args.data)
          return row
        },
      ),
      updateMany: vi.fn(
        async (args: {
          where: {
            id?: string
            mcCallId?: null
            status?: { in: string[] }
          }
          data: Partial<McSimulationRow>
        }) => {
          if (!args.where.id) return { count: 0 }
          const row = sims.get(args.where.id)
          if (!row) return { count: 0 }
          if (args.where.mcCallId === null && row.mcCallId !== null) return { count: 0 }
          if (args.where.status?.in && !args.where.status.in.includes(row.status)) {
            return { count: 0 }
          }
          Object.assign(row, args.data)
          return { count: 1 }
        },
      ),
    },
    _state: { sims },
  }
}

const validMapping: McMappingRow = {
  workspaceId: WORKSPACE,
  mcOrganizationId: 'mc-org-1',
  mcOrganizationSlug: 'hf-canary',
  mcApiKeyEncrypted: encryptMcSecret('mc_test_abc'),
  mcWebhookSecretEncrypted: encryptMcSecret('whsec_abc'),
  mcEnvironment: 'test',
  canaryEnabled: true,
}

const validCandidate: CandidateRow = {
  id: CANDIDATE,
  workspaceId: WORKSPACE,
  candidateName: 'Test Candidate',
  candidateEmail: 'test@example.com',
  candidatePhone: '+15551234567',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('McSimulationRunner.launch — happy path', () => {
  it('creates McSimulation before dial, uses row id as clientReferenceId + idempotency-key', async () => {
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    let observedIdempotency: string | undefined
    let observedClientRef: unknown
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      observedIdempotency = (init.headers as Record<string, string>)['Idempotency-Key']
      observedClientRef = JSON.parse(init.body as string).clientReferenceId
      return new Response(
        JSON.stringify({
          callId: 'mc-call-abc',
          status: 'ringing',
          estimatedRingSeconds: 3,
        }),
        { status: 202 },
      )
    })
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
      fetchImpl: fetchImpl as never,
    })
    const result = await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
    })
    expect(p.mcSimulation.create).toHaveBeenCalledOnce()
    // Row-first-then-dial invariant: capture invocation order via
    // vi's `mock.invocationCallOrder` (a monotonically-increasing
    // counter across all vi.fn instances in the process).
    const createOrder = p.mcSimulation.create.mock.invocationCallOrder[0]
    const fetchOrder = fetchImpl.mock.invocationCallOrder[0]
    expect(createOrder).toBeDefined()
    expect(fetchOrder).toBeDefined()
    expect(createOrder).toBeLessThan(fetchOrder!)
    expect(observedIdempotency).toBe(result.simulationId)
    expect(observedClientRef).toBe(result.simulationId)
    expect(result.mcCallId).toBe('mc-call-abc')
  })
})

describe('McSimulationRunner.launch — auth/scoping boundaries', () => {
  it('acceptance criterion: 404s a cross-workspace candidateId (no leak)', async () => {
    const p = makePrisma({
      mapping: validMapping,
      candidate: { ...validCandidate, workspaceId: 'other-ws' },
    })
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
    })
    await expect(
      runner.launch({
        workspaceId: WORKSPACE,
        candidateId: CANDIDATE,
        launchedByUserId: USER,
      }),
    ).rejects.toMatchObject({ reason: 'candidate_not_found' })
    expect(p.mcSimulation.create).not.toHaveBeenCalled()
  })

  it('acceptance criterion: 403s when canaryEnabled=false', async () => {
    const p = makePrisma({
      mapping: { ...validMapping, canaryEnabled: false },
      candidate: validCandidate,
    })
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
    })
    await expect(
      runner.launch({
        workspaceId: WORKSPACE,
        candidateId: CANDIDATE,
        launchedByUserId: USER,
      }),
    ).rejects.toMatchObject({ reason: 'canary_disabled' })
    expect(p.mcSimulation.create).not.toHaveBeenCalled()
  })

  it('403s when McWorkspaceMapping is absent', async () => {
    const p = makePrisma({ mapping: null, candidate: validCandidate })
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
    })
    await expect(
      runner.launch({
        workspaceId: WORKSPACE,
        candidateId: CANDIDATE,
        launchedByUserId: USER,
      }),
    ).rejects.toMatchObject({ reason: 'mc_not_configured' })
  })

  it('422s when candidate has no recorded phone number', async () => {
    const p = makePrisma({
      mapping: validMapping,
      candidate: { ...validCandidate, candidatePhone: null },
    })
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
    })
    await expect(
      runner.launch({
        workspaceId: WORKSPACE,
        candidateId: CANDIDATE,
        launchedByUserId: USER,
      }),
    ).rejects.toMatchObject({ reason: 'candidate_missing_phone' })
    expect(p.mcSimulation.create).not.toHaveBeenCalled()
  })
})

describe('McSimulationRunner.launch — MC failure paths', () => {
  it('acceptance criterion: marks row failed + throws mc_dial_rejected on MC 4xx', async () => {
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'bad request' }), { status: 400 }),
    )
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
      fetchImpl: fetchImpl as never,
    })
    await expect(
      runner.launch({
        workspaceId: WORKSPACE,
        candidateId: CANDIDATE,
        launchedByUserId: USER,
      }),
    ).rejects.toMatchObject({ reason: 'mc_dial_rejected' })
    // Row was created (before dial) then marked failed via updateMany
    // — pre-terminal-status guard prevents clobbering a webhook that
    // may have advanced the row concurrently.
    expect(p.mcSimulation.create).toHaveBeenCalledOnce()
    expect(p.mcSimulation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    )
  })

  it('acceptance criterion: marks row failed + throws mc_timeout on abort', async () => {
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    const fetchImpl = vi.fn(async () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    })
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
      fetchImpl: fetchImpl as never,
    })
    await expect(
      runner.launch({
        workspaceId: WORKSPACE,
        candidateId: CANDIDATE,
        launchedByUserId: USER,
      }),
    ).rejects.toMatchObject({ reason: 'mc_timeout' })
  })
})

describe('McSimulationRunner.launch — zero candidate side effects on failure', () => {
  it('does NOT touch AICallCandidate / pipeline / interview tables on any failure', async () => {
    // The Prisma fake only exposes mcWorkspaceMapping / session /
    // mcSimulation. If the runner ever tried to touch anything else it
    // would throw a "not a function" here and this test would fail.
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'bad' }), { status: 400 }),
    )
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
      fetchImpl: fetchImpl as never,
    })
    await expect(
      runner.launch({
        workspaceId: WORKSPACE,
        candidateId: CANDIDATE,
        launchedByUserId: USER,
      }),
    ).rejects.toBeInstanceOf(SimulationLaunchError)
    // Fake threw no unexpected access → the runner stayed in its lane.
  })
})

// ---------------------------------------------------------------------------
// Launch-level idempotency — client-generated launchRequestId
// ---------------------------------------------------------------------------
//
// Guards the "double-click / retried POST / two-parallel-requests"
// race that MC's per-callId idempotency alone cannot cover. The
// UI mints a UUID per opening of the confirm dialog and reuses it
// across any retry-with-same-intent; the runner dedups on
// (workspaceId, launchRequestId) via the @@unique constraint.
// ---------------------------------------------------------------------------

const LAUNCH_REQ_ID = '11111111-2222-3333-4444-555555555555'

function newRunnerWithSingleDialSuccess(
  p: ReturnType<typeof makePrisma>,
  fetchImpl?: ReturnType<typeof vi.fn>,
) {
  const impl =
    fetchImpl ??
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          callId: 'mc-call-abc',
          status: 'ringing',
          estimatedRingSeconds: 3,
        }),
        { status: 202 },
      ),
    )
  const runner = new McSimulationRunner({
    prisma: p as never,
    webhookCallbackUrl: WEBHOOK_URL,
    fetchImpl: impl as never,
  })
  return { runner, fetchImpl: impl }
}

describe('McSimulationRunner.launch — launchRequestId idempotency', () => {
  it('acceptance: sequential duplicate POST with same launchRequestId → same McSimulation, one MC dial', async () => {
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    const { runner, fetchImpl } = newRunnerWithSingleDialSuccess(p)
    const first = await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
      launchRequestId: LAUNCH_REQ_ID,
    })
    const second = await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
      launchRequestId: LAUNCH_REQ_ID,
    })
    expect(first.simulationId).toBe(second.simulationId)
    expect(first.reusedExisting).toBe(false)
    expect(second.reusedExisting).toBe(true)
    // MC dial fired ONCE across both launches — this is the whole
    // point: MC's per-callId idempotency can't help here because the
    // second launch would generate a fresh callId without our own
    // dedup at the launch level.
    expect(fetchImpl).toHaveBeenCalledOnce()
    // Only ONE McSimulation row exists in the DB (the second .create
    // ATTEMPT threw P2002 and did not persist).
    expect(p._state.sims.size).toBe(1)
    // The second launch's response echoes the original mcCallId.
    expect(second.mcCallId).toBe('mc-call-abc')
  })

  it('acceptance: concurrent duplicate POST → same McSimulation, one MC dial (P2002 race resolved by re-fetch)', async () => {
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    const { runner, fetchImpl } = newRunnerWithSingleDialSuccess(p)
    // Fire both launches "concurrently" via Promise.all — one wins
    // the DB race, the other catches P2002 and reuses.
    const [a, b] = await Promise.all([
      runner.launch({
        workspaceId: WORKSPACE,
        candidateId: CANDIDATE,
        launchedByUserId: USER,
        launchRequestId: LAUNCH_REQ_ID,
      }),
      runner.launch({
        workspaceId: WORKSPACE,
        candidateId: CANDIDATE,
        launchedByUserId: USER,
        launchRequestId: LAUNCH_REQ_ID,
      }),
    ])
    expect(a.simulationId).toBe(b.simulationId)
    // Exactly one of the two must have reused; the other created.
    const reusedCount = [a.reusedExisting, b.reusedExisting].filter(Boolean).length
    expect(reusedCount).toBe(1)
    // fetchImpl may be called 1x or 2x here — race-dependent:
    //   - Loser's findFirst runs BEFORE winner's mcCallId patch
    //     completes → loser sees mcCallId=null → also dials → 2x.
    //   - Loser's findFirst runs AFTER winner's patch → loser sees
    //     mcCallId set → skips dial → 1x.
    // BOTH outcomes are safe: MC's Idempotency-Key on the retry is
    // the SAME McSimulation.id → MC's ExternalRequestIdempotency
    // returns the cached ExternalCall on the second HTTP call.
    // Physical PSTN dial fires ONCE regardless.
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(2)
    // Both racers observed the same MC callId (either because loser
    // skipped, or because MC's idempotency returned the same body on
    // the second fetch — our mock returns the same fixture).
    expect(a.mcCallId).toBe(b.mcCallId)
    // Only one McSimulation row exists in HF regardless of the race.
    expect(p._state.sims.size).toBe(1)
  })

  it('acceptance: retry after HF response loss (same launchRequestId) → same simulation, no re-dial', async () => {
    // Reproduces: recruiter clicks Launch, server processes the dial
    // and MC returns success, but the network drops the HF→browser
    // response. The browser retries with the SAME launchRequestId.
    // The second POST must return the existing McSimulation without
    // firing a second MC dial.
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    const { runner, fetchImpl } = newRunnerWithSingleDialSuccess(p)
    const first = await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
      launchRequestId: LAUNCH_REQ_ID,
    })
    // Simulate the browser retry ~500ms later.
    await new Promise((r) => setTimeout(r, 10))
    const retry = await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
      launchRequestId: LAUNCH_REQ_ID,
    })
    expect(retry.simulationId).toBe(first.simulationId)
    expect(retry.reusedExisting).toBe(true)
    expect(fetchImpl).toHaveBeenCalledOnce()
    // MC's client-side idempotency-key was set to the (unchanged)
    // McSimulation.id, so even if the second launch HAD reached MC
    // it would have been deduped there — but the launch-level guard
    // prevents the second request entirely.
  })

  it('acceptance: two genuinely separate launches with different launchRequestIds → two McSimulations, two dials', async () => {
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ callId: 'mc-call-1', status: 'ringing', estimatedRingSeconds: 3 }),
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ callId: 'mc-call-2', status: 'ringing', estimatedRingSeconds: 3 }),
          { status: 202 },
        ),
      )
    const { runner } = newRunnerWithSingleDialSuccess(p, fetchImpl)
    const a = await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
      launchRequestId: '11111111-1111-1111-1111-111111111111',
    })
    const b = await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
      launchRequestId: '22222222-2222-2222-2222-222222222222',
    })
    expect(a.simulationId).not.toBe(b.simulationId)
    expect(a.reusedExisting).toBe(false)
    expect(b.reusedExisting).toBe(false)
    // Distinct MC calls returned.
    expect(a.mcCallId).toBe('mc-call-1')
    expect(b.mcCallId).toBe('mc-call-2')
    // Two distinct MC dials happened.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(p._state.sims.size).toBe(2)
  })

  it('acceptance: launchRequestId reused across a DIFFERENT candidate (same workspace) → 409 conflict, no reuse leak', async () => {
    // A client bug (or malicious probe) sends the same launchRequestId
    // for two different candidates. The unique constraint fires, but
    // returning the OTHER candidate's simulation would leak its
    // existence. Runner throws launch_request_id_conflict; API maps
    // to 409.
    const otherCandidate = {
      id: 'cand-other',
      workspaceId: WORKSPACE,
      candidateName: 'Other',
      candidateEmail: null,
      candidatePhone: '+15559999999',
    }
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    // Also register the "other" candidate under the same workspace.
    ;(p.session.findFirst as any).mockImplementation(
      async (args: { where: { id: string; workspaceId: string } }) => {
        if (args.where.id === CANDIDATE && args.where.workspaceId === WORKSPACE) {
          return validCandidate
        }
        if (args.where.id === otherCandidate.id && args.where.workspaceId === WORKSPACE) {
          return otherCandidate
        }
        return null
      },
    )
    const { runner } = newRunnerWithSingleDialSuccess(p)
    // First launch — succeeds, binds LAUNCH_REQ_ID to CANDIDATE.
    await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
      launchRequestId: LAUNCH_REQ_ID,
    })
    // Second launch — same launchRequestId, different candidate.
    await expect(
      runner.launch({
        workspaceId: WORKSPACE,
        candidateId: otherCandidate.id,
        launchedByUserId: USER,
        launchRequestId: LAUNCH_REQ_ID,
      }),
    ).rejects.toMatchObject({ reason: 'launch_request_id_conflict' })
    // The other candidate has ZERO simulations — the first candidate's
    // simulation was NOT reused for it.
    const otherSims = Array.from(p._state.sims.values()).filter(
      (r) => r.candidateId === otherCandidate.id,
    )
    expect(otherSims).toHaveLength(0)
  })

  it('sanity: same launchRequestId across DIFFERENT workspaces is isolated (no cross-workspace conflict)', async () => {
    // Uniqueness scope is (workspaceId, launchRequestId) — the same
    // UUID can legitimately appear under two workspaces because
    // clients don't share UUIDs across tenants deliberately. This
    // test confirms the constraint doesn't fire across workspaces.
    const otherWorkspaceMapping = {
      ...validMapping,
      workspaceId: 'ws-2',
    }
    const otherWorkspaceCandidate = {
      id: 'cand-in-ws2',
      workspaceId: 'ws-2',
      candidateName: 'WS2 Candidate',
      candidateEmail: null,
      candidatePhone: '+15558888888',
    }
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    ;(p.mcWorkspaceMapping.findUnique as any).mockImplementation(async (args: any) => {
      if (args.where.workspaceId === WORKSPACE) return validMapping
      if (args.where.workspaceId === 'ws-2') return otherWorkspaceMapping
      return null
    })
    ;(p.session.findFirst as any).mockImplementation(async (args: any) => {
      if (args.where.id === CANDIDATE && args.where.workspaceId === WORKSPACE) {
        return validCandidate
      }
      if (
        args.where.id === otherWorkspaceCandidate.id &&
        args.where.workspaceId === 'ws-2'
      ) {
        return otherWorkspaceCandidate
      }
      return null
    })
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ callId: 'mc-call-ws1', status: 'ringing', estimatedRingSeconds: 3 }),
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ callId: 'mc-call-ws2', status: 'ringing', estimatedRingSeconds: 3 }),
          { status: 202 },
        ),
      )
    const { runner } = newRunnerWithSingleDialSuccess(p, fetchImpl)
    const a = await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
      launchRequestId: LAUNCH_REQ_ID,
    })
    const b = await runner.launch({
      workspaceId: 'ws-2',
      candidateId: otherWorkspaceCandidate.id,
      launchedByUserId: USER,
      launchRequestId: LAUNCH_REQ_ID, // deliberately reused across ws
    })
    expect(a.simulationId).not.toBe(b.simulationId)
    expect(b.reusedExisting).toBe(false)
    expect(p._state.sims.size).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Stranded-launch resume — the winning launch created the row but died
// before persisting mcCallId. A duplicate POST with the same
// launchRequestId must retry the dial rather than return a permanently-
// unusable simulation. MC's Idempotency-Key = McSimulation.id keeps the
// physical PSTN call to exactly one.
// ---------------------------------------------------------------------------

/** Seed the fake with an existing McSimulation as if a prior crashed launch left it. */
function seedStrandedRow(
  p: ReturnType<typeof makePrisma>,
  overrides: {
    launchRequestId: string
    mcCallId?: string | null
    status?: string
    failureReason?: string | null
  },
) {
  const strandedId = 'stranded-sim-' + Math.random().toString(36).slice(2, 10)
  p._state.sims.set(strandedId, {
    id: strandedId,
    workspaceId: WORKSPACE,
    candidateId: CANDIDATE,
    launchedByUserId: USER,
    mcOrganizationId: 'mc-org-1',
    status: overrides.status ?? 'queued',
    mcCallId: overrides.mcCallId ?? null,
    failedAt: null,
    failureReason: overrides.failureReason ?? null,
    queuedAt: new Date(),
    launchRequestId: overrides.launchRequestId,
  })
  return strandedId
}

describe('McSimulationRunner.launch — stranded launch resume', () => {
  it('acceptance: reused row with mcCallId==null AND non-terminal → RETRIES provider.dial() with existing id', async () => {
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    const strandedId = seedStrandedRow(p, {
      launchRequestId: LAUNCH_REQ_ID,
      mcCallId: null,
      status: 'queued',
    })
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          callId: 'mc-call-recovered',
          status: 'ringing',
          estimatedRingSeconds: 3,
        }),
        { status: 202 },
      ),
    )
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
      fetchImpl: fetchImpl as never,
    })
    const result = await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
      launchRequestId: LAUNCH_REQ_ID,
    })
    // Runner detected the stranded row and RE-DIALED.
    expect(fetchImpl).toHaveBeenCalledOnce()
    // Dial uses the EXISTING McSimulation.id as MC's Idempotency-Key
    // + clientReferenceId — this is the load-bearing guarantee.
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }]
    const init = call[1]
    expect(init.headers['Idempotency-Key']).toBe(strandedId)
    const body = JSON.parse(init.body as string)
    expect(body.clientReferenceId).toBe(strandedId)
    // Result returns the existing row's id + mcCallId patched with
    // whatever MC returned (either the cached call from the original
    // attempt, or a fresh one if the crash was pre-MC).
    expect(result.simulationId).toBe(strandedId)
    expect(result.mcCallId).toBe('mc-call-recovered')
    expect(result.reusedExisting).toBe(true)
    // mcCallId was patched onto the existing row.
    expect(p._state.sims.get(strandedId)!.mcCallId).toBe('mc-call-recovered')
    // No new McSimulation row was created.
    expect(p._state.sims.size).toBe(1)
  })

  it('acceptance: reused row with mcCallId ALREADY SET → skips dial (idempotent duplicate)', async () => {
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    const existingId = seedStrandedRow(p, {
      launchRequestId: LAUNCH_REQ_ID,
      mcCallId: 'mc-call-original',
      status: 'ringing',
    })
    const fetchImpl = vi.fn()
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
      fetchImpl: fetchImpl as never,
    })
    const result = await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
      launchRequestId: LAUNCH_REQ_ID,
    })
    // Winning launch already recorded mcCallId — nothing to resume.
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.simulationId).toBe(existingId)
    expect(result.mcCallId).toBe('mc-call-original')
    expect(result.reusedExisting).toBe(true)
    expect(result.status).toBe('ringing')
  })

  it('acceptance: reused row is TERMINAL (completed/failed/cancelled) → skips dial regardless of mcCallId', async () => {
    for (const terminalStatus of ['completed', 'failed', 'cancelled'] as const) {
      const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
      // Deliberately terminal + mcCallId null — a stranded launch that
      // was later cancelled/failed by ops. Must still NOT re-dial.
      const existingId = seedStrandedRow(p, {
        launchRequestId: LAUNCH_REQ_ID,
        mcCallId: null,
        status: terminalStatus,
        failureReason: terminalStatus === 'failed' ? 'operator_cancel' : null,
      })
      const fetchImpl = vi.fn()
      const runner = new McSimulationRunner({
        prisma: p as never,
        webhookCallbackUrl: WEBHOOK_URL,
        fetchImpl: fetchImpl as never,
      })
      const result = await runner.launch({
        workspaceId: WORKSPACE,
        candidateId: CANDIDATE,
        launchedByUserId: USER,
        launchRequestId: LAUNCH_REQ_ID,
      })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(result.simulationId).toBe(existingId)
      expect(result.status).toBe(terminalStatus)
      expect(result.reusedExisting).toBe(true)
    }
  })

  it('acceptance: resume-dial failure marks the EXISTING row failed (no new McSimulation created)', async () => {
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    const strandedId = seedStrandedRow(p, {
      launchRequestId: LAUNCH_REQ_ID,
      mcCallId: null,
      status: 'queued',
    })
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'bad' }), { status: 400 }),
    )
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
      fetchImpl: fetchImpl as never,
    })
    await expect(
      runner.launch({
        workspaceId: WORKSPACE,
        candidateId: CANDIDATE,
        launchedByUserId: USER,
        launchRequestId: LAUNCH_REQ_ID,
      }),
    ).rejects.toMatchObject({ reason: 'mc_dial_rejected' })
    // No new McSimulation created.
    expect(p._state.sims.size).toBe(1)
    // The EXISTING row was marked failed (via the pre-terminal guard
    // in the runner's failure branch — matches applyMcSimulationState).
    const row = p._state.sims.get(strandedId)!
    expect(row.status).toBe('failed')
    expect(row.failureReason).toBe('mc_dial_rejected')
  })

  it('acceptance: resume-dial does NOT clobber a concurrently-backfilled mcCallId', async () => {
    // Scenario: the loser's resume-dial hits MC and gets a callId,
    // but between our findFirst and our updateMany a webhook receiver
    // back-filled mcCallId onto the row (from the winning launch's
    // .queued webhook). Our updateMany uses `mcCallId: null` as a
    // guard so the concurrent write is preserved.
    const p = makePrisma({ mapping: validMapping, candidate: validCandidate })
    const strandedId = seedStrandedRow(p, {
      launchRequestId: LAUNCH_REQ_ID,
      mcCallId: null,
      status: 'queued',
    })
    // Simulate concurrent webhook back-fill: right before the dial's
    // response comes back, the webhook receiver patches mcCallId.
    let fetchInvoked = false
    const fetchImpl = vi.fn(async () => {
      if (!fetchInvoked) {
        fetchInvoked = true
        // Concurrent webhook: back-fill mcCallId directly.
        p._state.sims.get(strandedId)!.mcCallId = 'mc-call-from-webhook'
      }
      return new Response(
        JSON.stringify({
          callId: 'mc-call-from-dial',
          status: 'ringing',
          estimatedRingSeconds: 3,
        }),
        { status: 202 },
      )
    })
    const runner = new McSimulationRunner({
      prisma: p as never,
      webhookCallbackUrl: WEBHOOK_URL,
      fetchImpl: fetchImpl as never,
    })
    const result = await runner.launch({
      workspaceId: WORKSPACE,
      candidateId: CANDIDATE,
      launchedByUserId: USER,
      launchRequestId: LAUNCH_REQ_ID,
    })
    // Row's mcCallId is the CONCURRENT value (webhook's), not our
    // dial response — the mcCallId:null guard on updateMany protected
    // the earlier write.
    expect(p._state.sims.get(strandedId)!.mcCallId).toBe('mc-call-from-webhook')
    // Runner's return still reflects what MC handed back on this
    // request — telemetry-only; the DB has the winning value.
    expect(result.simulationId).toBe(strandedId)
    expect(result.reusedExisting).toBe(true)
  })
})
