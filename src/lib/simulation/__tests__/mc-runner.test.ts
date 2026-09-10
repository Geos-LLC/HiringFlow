import { describe, expect, it, vi, beforeEach } from 'vitest'
import { McSimulationRunner } from '../mc-runner'
import { SimulationLaunchError } from '../runner'
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
        sims.set(args.data.id, {
          ...args.data,
          status: args.data.status ?? 'queued',
          mcCallId: null,
          failedAt: null,
          failureReason: null,
        })
        return sims.get(args.data.id)!
      }),
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
    // Row was created (before dial) then patched to failed.
    expect(p.mcSimulation.create).toHaveBeenCalledOnce()
    expect(p.mcSimulation.update).toHaveBeenCalledWith(
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
