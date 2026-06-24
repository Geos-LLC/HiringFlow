/**
 * Sigcore telegram-placement webhook — verification + state-machine tests.
 *
 * Same HMAC contract as sms-inbound (sig = hex(HMAC-SHA256(secret, `${ts}.${body}`)))
 * + ±5 minute skew window. These tests pin both the contract and the
 * non-overwriting terminal status invariant (first terminal wins, even if
 * a later event would flip the outcome).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'crypto'

const SECRET = 'test-sigcore-telegram-secret-aaaaa'

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    telegramPlacement: {
      findUnique: vi.fn(async () => null) as any,
      findFirst: vi.fn(async () => null) as any,
      update: vi.fn(async () => ({})) as any,
    },
  }
  return { prismaMock }
})

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { POST } from '@/app/api/webhooks/sigcore/telegram-placement/route'

function sign(ts: string, body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
}

function buildRequest(opts: {
  body: string
  ts?: string | null
  sig?: string | null
}): Request {
  const headers = new Headers()
  if (opts.ts !== null && opts.ts !== undefined) headers.set('x-callio-timestamp', opts.ts)
  if (opts.sig !== null && opts.sig !== undefined) headers.set('x-callio-signature', opts.sig)
  headers.set('content-type', 'application/json')
  return new Request('https://www.hirefunnel.app/api/webhooks/sigcore/telegram-placement', {
    method: 'POST',
    headers,
    body: opts.body,
  })
}

function nowSec(): string {
  return String(Math.floor(Date.now() / 1000))
}

function makeSentEvent(externalRef = 'hf-placement-uuid', providerMessageId = 'tg_999'): string {
  return JSON.stringify({
    event: 'telegram.placement.sent',
    timestamp: '2026-06-19T12:00:00.000Z',
    data: {
      placementId: 'sigcore-placement-uuid',
      chatRef: '@cleaners_jax',
      externalRef,
      providerMessageId,
      teleporterMessageId: 'msg_abc123',
      status: 'sent',
      occurredAt: '2026-06-19T12:00:01.000Z',
    },
  })
}

function makeFailedEvent(externalRef = 'hf-placement-uuid'): string {
  return JSON.stringify({
    event: 'telegram.placement.failed',
    timestamp: '2026-06-19T12:00:00.000Z',
    data: {
      placementId: 'sigcore-placement-uuid',
      chatRef: '@cleaners_jax',
      externalRef,
      status: 'failed',
      errorCode: 'CHAT_NOT_FOUND',
      errorMessage: 'Bot is not a member of the chat',
      occurredAt: '2026-06-19T12:00:01.000Z',
    },
  })
}

describe('Sigcore telegram-placement webhook — auth', () => {
  beforeEach(() => {
    process.env.SIGCORE_WEBHOOK_KEY = SECRET
    vi.clearAllMocks()
  })

  it('503s when SIGCORE_WEBHOOK_KEY is unset', async () => {
    delete process.env.SIGCORE_WEBHOOK_KEY
    const ts = nowSec()
    const body = makeSentEvent()
    const res = await POST(buildRequest({ body, ts, sig: sign(ts, body) }))
    expect(res.status).toBe(503)
  })

  it('401s on stale timestamp', async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 10 * 60) // 10 min ago
    const body = makeSentEvent()
    const res = await POST(buildRequest({ body, ts, sig: sign(ts, body) }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('stale_timestamp')
  })

  it('401s on missing timestamp', async () => {
    const body = makeSentEvent()
    const res = await POST(buildRequest({ body, ts: null, sig: 'whatever' }))
    expect(res.status).toBe(401)
  })

  it('401s on tampered body', async () => {
    const ts = nowSec()
    const goodBody = makeSentEvent()
    const sig = sign(ts, goodBody)
    const tamperedBody = goodBody.replace('@cleaners_jax', '@evil_channel')
    const res = await POST(buildRequest({ body: tamperedBody, ts, sig }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('signature_mismatch')
  })

  it('401s on missing signature', async () => {
    const ts = nowSec()
    const res = await POST(buildRequest({ body: makeSentEvent(), ts, sig: null }))
    expect(res.status).toBe(401)
  })
})

describe('Sigcore telegram-placement webhook — event handling', () => {
  beforeEach(() => {
    process.env.SIGCORE_WEBHOOK_KEY = SECRET
    vi.clearAllMocks()
  })

  it('updates a queued placement to sent and copies providerMessageId', async () => {
    prismaMock.telegramPlacement.findUnique.mockResolvedValueOnce({
      id: 'hf-placement-uuid',
      status: 'queued',
      providerMessageId: null,
      sigcorePlacementId: null,
      errorCode: null,
      errorMessage: null,
      sentAt: null,
      failedAt: null,
    })
    const ts = nowSec()
    const body = makeSentEvent('hf-placement-uuid', 'tg_999')
    const res = await POST(buildRequest({ body, ts, sig: sign(ts, body) }))
    expect(res.status).toBe(200)
    expect(prismaMock.telegramPlacement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'hf-placement-uuid' },
        data: expect.objectContaining({
          status: 'sent',
          providerMessageId: 'tg_999',
          sigcorePlacementId: 'sigcore-placement-uuid',
        }),
      }),
    )
  })

  it('updates to failed and records errorCode/Message', async () => {
    prismaMock.telegramPlacement.findUnique.mockResolvedValueOnce({
      id: 'hf-placement-uuid',
      status: 'queued',
      providerMessageId: null,
      sigcorePlacementId: 'sigcore-placement-uuid',
      errorCode: null,
      errorMessage: null,
      sentAt: null,
      failedAt: null,
    })
    const ts = nowSec()
    const body = makeFailedEvent('hf-placement-uuid')
    const res = await POST(buildRequest({ body, ts, sig: sign(ts, body) }))
    expect(res.status).toBe(200)
    expect(prismaMock.telegramPlacement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'CHAT_NOT_FOUND',
          errorMessage: 'Bot is not a member of the chat',
        }),
      }),
    )
  })

  it('falls back to sigcorePlacementId lookup when externalRef missing', async () => {
    prismaMock.telegramPlacement.findFirst.mockResolvedValueOnce({
      id: 'hf-placement-uuid',
      status: 'queued',
      providerMessageId: null,
      sigcorePlacementId: 'sigcore-placement-uuid',
      errorCode: null,
      errorMessage: null,
      sentAt: null,
      failedAt: null,
    })
    const ts = nowSec()
    const body = JSON.stringify({
      event: 'telegram.placement.sent',
      data: { placementId: 'sigcore-placement-uuid', status: 'sent', providerMessageId: 'tg_42' },
    })
    const res = await POST(buildRequest({ body, ts, sig: sign(ts, body) }))
    expect(res.status).toBe(200)
    expect(prismaMock.telegramPlacement.findFirst).toHaveBeenCalledWith({
      where: { sigcorePlacementId: 'sigcore-placement-uuid' },
    })
    expect(prismaMock.telegramPlacement.update).toHaveBeenCalled()
  })

  it('no-ops when placement already terminal (first terminal wins)', async () => {
    prismaMock.telegramPlacement.findUnique.mockResolvedValueOnce({
      id: 'hf-placement-uuid',
      status: 'sent',
      providerMessageId: 'tg_999',
    })
    const ts = nowSec()
    const body = makeFailedEvent('hf-placement-uuid')
    const res = await POST(buildRequest({ body, ts, sig: sign(ts, body) }))
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe('already_terminal')
    expect(prismaMock.telegramPlacement.update).not.toHaveBeenCalled()
  })

  it('200-acks unknown event types without touching the DB', async () => {
    const ts = nowSec()
    const body = JSON.stringify({ event: 'telegram.placement.queued', data: {} })
    const res = await POST(buildRequest({ body, ts, sig: sign(ts, body) }))
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe('event_not_handled')
    expect(prismaMock.telegramPlacement.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.telegramPlacement.update).not.toHaveBeenCalled()
  })

  it('200-ignores when neither externalRef nor placementId provided', async () => {
    const ts = nowSec()
    const body = JSON.stringify({ event: 'telegram.placement.sent', data: {} })
    const res = await POST(buildRequest({ body, ts, sig: sign(ts, body) }))
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe('no_placement_id')
  })

  it('200-ignores when placement row does not exist (cancelled before callback)', async () => {
    prismaMock.telegramPlacement.findUnique.mockResolvedValueOnce(null)
    const ts = nowSec()
    const body = makeSentEvent('nonexistent-hf-uuid')
    const res = await POST(buildRequest({ body, ts, sig: sign(ts, body) }))
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe('placement_not_found')
  })
})
