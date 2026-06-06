/**
 * Sigcore inbound SMS webhook — signature/timestamp verification tests.
 *
 * Pins the post-2026-05-07 contract:
 *   sig = hex(HMAC-SHA256(secret, `${ts}.${rawBody}`))
 *   ts  = epoch seconds (header `X-Callio-Timestamp`)
 *   ±5 minute skew window on ts.
 *
 * The "REGRESSION GUARD" test pins the old `hex(HMAC-SHA256(secret, body))`
 * contract as REJECTED — if that test ever passes again we've silently
 * rolled the verifier back and missed inbound replies (as we did between
 * 2026-05-07 and 2026-06-05).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'crypto'

const SECRET = 'test-sigcore-secret-aaaaaaaaaaaaaa'

// Mock prisma + every downstream side-effect helper before importing the
// route. The verification tests don't need any of these to fire, but the
// route imports them at the top so we have to satisfy the module graph.
const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    session: { findMany: vi.fn(async () => []) },
    interviewMeeting: { update: vi.fn(async () => ({})) },
    schedulingEvent: { findFirst: vi.fn(async () => null) },
    workspace: { findUnique: vi.fn(async () => null) },
    automationExecution: {
      findUnique: vi.fn(async () => null) as any,
      findFirst: vi.fn(async () => null) as any,
      update: vi.fn(async () => ({})) as any,
    },
  }
  return { prismaMock }
})

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/scheduling', () => ({ logSchedulingEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/funnel-stage-runtime', () => ({ applyStageTrigger: vi.fn(async () => undefined) }))
vi.mock('@/lib/automation', () => ({
  cancelBeforeMeetingReminders: vi.fn(async () => undefined),
  cancelMeetingDependentFollowups: vi.fn(async () => undefined),
}))
vi.mock('@/lib/google', () => ({
  deleteCalendarEvent: vi.fn(async () => ({ deleted: true, alreadyGone: false })),
}))
vi.mock('@/lib/sms', () => ({
  sendSms: vi.fn(async () => ({ ok: true })),
  normalizeToE164: (v: string) => (v.startsWith('+') ? v : null),
}))
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(async () => undefined) }))

// Import AFTER mocks.
import { POST } from '@/app/api/webhooks/sigcore/sms-inbound/route'

function sign(ts: string, body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
}

function signLegacy(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function buildRequest(opts: {
  body: string
  ts?: string | null
  sig?: string | null
  event?: string | null
}): Request {
  const headers = new Headers()
  if (opts.ts !== null && opts.ts !== undefined) headers.set('x-callio-timestamp', opts.ts)
  if (opts.sig !== null && opts.sig !== undefined) headers.set('x-callio-signature', opts.sig)
  if (opts.event !== null && opts.event !== undefined) headers.set('x-callio-event', opts.event)
  headers.set('content-type', 'application/json')
  return new Request('https://www.hirefunnel.app/api/webhooks/sigcore/sms-inbound', {
    method: 'POST',
    headers,
    body: opts.body,
  })
}

function nowSec(): string {
  return String(Math.floor(Date.now() / 1000))
}

const NON_INBOUND_BODY = JSON.stringify({
  event: 'message.delivered',
  timestamp: '2026-06-05T00:00:00.000Z',
  data: { messageId: 'x' },
})

describe('Sigcore inbound webhook signature verification', () => {
  beforeEach(() => {
    process.env.SIGCORE_WEBHOOK_KEY = SECRET
    vi.clearAllMocks()
  })

  it('accepts a valid `${ts}.${body}` signature (200, non-inbound event ignored)', async () => {
    const ts = nowSec()
    const req = buildRequest({ body: NON_INBOUND_BODY, ts, sig: sign(ts, NON_INBOUND_BODY) })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
  })

  it('rejects a tampered body with 401 signature_mismatch', async () => {
    const ts = nowSec()
    // Sign one body, send a different one.
    const signedBody = NON_INBOUND_BODY
    const tamperedBody = signedBody.replace('message.delivered', 'message.inbound')
    const req = buildRequest({ body: tamperedBody, ts, sig: sign(ts, signedBody) })
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('signature_mismatch')
  })

  it('rejects a tampered timestamp (sig was bound to original ts) with 401 signature_mismatch', async () => {
    const ts = nowSec()
    const sig = sign(ts, NON_INBOUND_BODY)
    // Attacker shifts ts by 1s but reuses old signature; ts is still within
    // the freshness window so the skew check passes, but HMAC differs.
    const shiftedTs = String(parseInt(ts, 10) + 1)
    const req = buildRequest({ body: NON_INBOUND_BODY, ts: shiftedTs, sig })
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('signature_mismatch')
  })

  it('rejects a stale timestamp (6 minutes old) with 401 stale_timestamp', async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 6 * 60)
    const req = buildRequest({ body: NON_INBOUND_BODY, ts, sig: sign(ts, NON_INBOUND_BODY) })
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('stale_timestamp')
  })

  it('rejects a future-dated timestamp (6 minutes ahead) with 401 stale_timestamp', async () => {
    const ts = String(Math.floor(Date.now() / 1000) + 6 * 60)
    const req = buildRequest({ body: NON_INBOUND_BODY, ts, sig: sign(ts, NON_INBOUND_BODY) })
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('stale_timestamp')
  })

  it('rejects a request missing the X-Callio-Timestamp header with 401 stale_timestamp', async () => {
    // No ts → fail-closed on the freshness gate. We label this stale_timestamp
    // (not signature_mismatch) to make observability point at the missing
    // header rather than at the HMAC.
    const ts = nowSec()
    const req = buildRequest({ body: NON_INBOUND_BODY, ts: null, sig: sign(ts, NON_INBOUND_BODY) })
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('stale_timestamp')
  })

  it('rejects a request missing the X-Callio-Signature header with 401 signature_mismatch', async () => {
    const ts = nowSec()
    const req = buildRequest({ body: NON_INBOUND_BODY, ts, sig: null })
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('signature_mismatch')
  })

  it('refuses all webhooks with 503 when SIGCORE_WEBHOOK_KEY is unset', async () => {
    delete process.env.SIGCORE_WEBHOOK_KEY
    const ts = nowSec()
    const req = buildRequest({ body: NON_INBOUND_BODY, ts, sig: sign(ts, NON_INBOUND_BODY) })
    const res = await POST(req)
    expect(res.status).toBe(503)
  })

  // REGRESSION GUARD — pin the contract migration. If this test ever fails,
  // the verifier has been silently reverted to the pre-2026-05-07 contract
  // and we are about to drop inbound replies again.
  it('REGRESSION GUARD: rejects an OLD-style raw-body signature (no ts prefix)', async () => {
    const ts = nowSec()
    const oldStyleSig = signLegacy(NON_INBOUND_BODY)
    const req = buildRequest({ body: NON_INBOUND_BODY, ts, sig: oldStyleSig })
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('signature_mismatch')
  })
})

describe('Sigcore delivery status events', () => {
  beforeEach(() => {
    process.env.SIGCORE_WEBHOOK_KEY = SECRET
    vi.clearAllMocks()
  })

  function deliveryBody(event: 'message.delivered' | 'message.failed' | 'message.sent', data: Record<string, unknown>): string {
    return JSON.stringify({ event, timestamp: new Date().toISOString(), data })
  }

  async function postEvent(body: string) {
    const ts = nowSec()
    return POST(buildRequest({ body, ts, sig: sign(ts, body) }))
  }

  it('message.delivered updates AutomationExecution.deliveryStatus when matched by automationExecutionId', async () => {
    prismaMock.automationExecution.findUnique.mockResolvedValueOnce({
      id: 'exec-1', deliveryStatus: 'sent', automationRule: { workspaceId: 'ws-1' },
    })
    const body = deliveryBody('message.delivered', {
      providerMessageId: 'SMabc',
      automationExecutionId: 'exec-1',
      workspaceId: 'ws-1',
      status: 'delivered',
    })
    const res = await postEvent(body)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ action: 'delivery_status_updated', executionId: 'exec-1', status: 'delivered' })
    expect(prismaMock.automationExecution.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'exec-1' },
      data: expect.objectContaining({ deliveryStatus: 'delivered' }),
    }))
  })

  it('message.failed records errorCode + errorMessage', async () => {
    prismaMock.automationExecution.findUnique.mockResolvedValueOnce({
      id: 'exec-2', deliveryStatus: 'sent', automationRule: { workspaceId: 'ws-1' },
    })
    const res = await postEvent(deliveryBody('message.failed', {
      providerMessageId: 'SMfail',
      automationExecutionId: 'exec-2',
      errorCode: '30007',
      errorMessage: 'Carrier rejected',
    }))
    expect(res.status).toBe(200)
    expect(prismaMock.automationExecution.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deliveryStatus: 'failed',
        deliveryErrorMessage: '30007: Carrier rejected',
      }),
    }))
  })

  it('falls back to providerMessageId lookup when automationExecutionId is absent', async () => {
    prismaMock.automationExecution.findFirst.mockResolvedValueOnce({
      id: 'exec-3', deliveryStatus: null, automationRule: { workspaceId: 'ws-1' },
    })
    const res = await postEvent(deliveryBody('message.delivered', { providerMessageId: 'SMlookup' }))
    expect(res.status).toBe(200)
    expect(prismaMock.automationExecution.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { providerMessageId: 'SMlookup', provider: 'sigcore' },
    }))
  })

  it('no_execution returns 200 ignored when neither lookup matches', async () => {
    const res = await postEvent(deliveryBody('message.delivered', { providerMessageId: 'SMmissing' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ignored: 'no_execution' })
    expect(prismaMock.automationExecution.update).not.toHaveBeenCalled()
  })

  it('cross_workspace mismatch drops the update silently', async () => {
    prismaMock.automationExecution.findUnique.mockResolvedValueOnce({
      id: 'exec-4', deliveryStatus: 'sent', automationRule: { workspaceId: 'ws-A' },
    })
    const res = await postEvent(deliveryBody('message.delivered', {
      automationExecutionId: 'exec-4',
      workspaceId: 'ws-B',
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ignored: 'cross_workspace' })
    expect(prismaMock.automationExecution.update).not.toHaveBeenCalled()
  })

  it('terminal status (delivered/failed) is not downgraded by a later message.sent', async () => {
    prismaMock.automationExecution.findUnique.mockResolvedValueOnce({
      id: 'exec-5', deliveryStatus: 'delivered', automationRule: { workspaceId: 'ws-1' },
    })
    const res = await postEvent(deliveryBody('message.sent', { automationExecutionId: 'exec-5' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ignored: 'status_no_change', current: 'delivered', attempted: 'sent' })
    expect(prismaMock.automationExecution.update).not.toHaveBeenCalled()
  })

  it('reads nested metadata.automationExecutionId when present (forward-compat with versioning PR)', async () => {
    prismaMock.automationExecution.findUnique.mockResolvedValueOnce({
      id: 'exec-6', deliveryStatus: null, automationRule: { workspaceId: 'ws-1' },
    })
    const res = await postEvent(deliveryBody('message.delivered', {
      providerMessageId: 'SMxyz',
      metadata: { automationExecutionId: 'exec-6', workspaceId: 'ws-1' },
    }))
    expect(res.status).toBe(200)
    expect(prismaMock.automationExecution.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'exec-6' },
    }))
  })
})
