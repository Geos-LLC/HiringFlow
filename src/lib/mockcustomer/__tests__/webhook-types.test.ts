import { describe, expect, it } from 'vitest'
import { parseMcWebhookEvent } from '../webhook-types'

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: '11111111-1111-1111-1111-111111111111',
    type: 'external_call.queued',
    createdAt: '2026-09-10T00:00:00.000Z',
    apiVersion: '2026-09-09',
    data: {
      callId: '22222222-2222-2222-2222-222222222222',
      clientReferenceId: 'sim-xyz',
      organizationId: '33333333-3333-3333-3333-333333333333',
      organizationSlug: 'hirefunnel-canary',
      status: 'queued',
      queuedAt: '2026-09-10T00:00:00.000Z',
      ringingAt: null,
      answeredAt: null,
      completedAt: null,
      failedAt: null,
      durationSec: null,
      failureReason: null,
    },
    ...overrides,
  }
}

describe('parseMcWebhookEvent', () => {
  it('parses a well-formed .queued event', () => {
    const parsed = parseMcWebhookEvent(baseEvent())
    expect(parsed).not.toBeNull()
    expect(parsed!.type).toBe('external_call.queued')
    expect(parsed!.data.clientReferenceId).toBe('sim-xyz')
  })

  it('rejects missing top-level fields', () => {
    expect(parseMcWebhookEvent({ type: 'external_call.queued' })).toBeNull()
    expect(parseMcWebhookEvent({ eventId: 'x', type: 'external_call.queued' })).toBeNull()
    expect(parseMcWebhookEvent(null)).toBeNull()
    expect(parseMcWebhookEvent('string')).toBeNull()
    expect(parseMcWebhookEvent([])).toBeNull()
  })

  it('rejects unknown event types', () => {
    expect(parseMcWebhookEvent(baseEvent({ type: 'external_call.exploded' }))).toBeNull()
  })

  it('accepts terminal event with a partial result block (nulls preserved, not fabricated)', () => {
    const parsed = parseMcWebhookEvent(
      baseEvent({
        type: 'external_call.completed',
        data: {
          callId: '22222222-2222-2222-2222-222222222222',
          clientReferenceId: 'sim-xyz',
          organizationId: '33333333-3333-3333-3333-333333333333',
          organizationSlug: 'hirefunnel-canary',
          status: 'completed',
          queuedAt: '2026-09-10T00:00:00.000Z',
          ringingAt: null,
          answeredAt: null,
          completedAt: '2026-09-10T00:01:00.000Z',
          failedAt: null,
          durationSec: 42,
          failureReason: null,
          result: {
            overallScore: null,
            passed: null,
            summary: null,
            sessionId: null,
            deepLinkUrl: 'https://mockcustomer.example/x',
          },
        },
      }),
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.data.result?.overallScore).toBeNull()
    expect(parsed!.data.result?.passed).toBeNull()
    expect(parsed!.data.result?.deepLinkUrl).toBe('https://mockcustomer.example/x')
  })

  it('rejects result block without a deepLinkUrl (contract-critical field)', () => {
    const parsed = parseMcWebhookEvent(
      baseEvent({
        type: 'external_call.completed',
        data: {
          ...baseEvent().data,
          status: 'completed',
          result: { overallScore: null, passed: null, summary: null, sessionId: null },
        },
      }),
    )
    expect(parsed).toBeNull()
  })

  it('coerces clientReferenceId to null when missing (does not throw)', () => {
    const data = { ...baseEvent().data }
    delete (data as Record<string, unknown>).clientReferenceId
    const parsed = parseMcWebhookEvent(baseEvent({ data }))
    expect(parsed).not.toBeNull()
    expect(parsed!.data.clientReferenceId).toBeNull()
  })
})
