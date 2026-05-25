import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import {
  verifySendgridSignature,
  mapEventToStatus,
  readExecutionId,
  readWorkspaceId,
  readDeliveryError,
  shouldUpdateStatus,
  isTerminalFailure,
  pemFromBase64,
  type SendgridEvent,
} from '../sendgrid-events'

// Generate a fresh P-256 key pair for signature tests so we exercise the
// real ECDSA verify path SendGrid uses, without depending on a fixed
// vendored test vector.
function genKeyPair() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
}

function signPayload(privateKey: crypto.KeyObject, timestamp: string, body: string): string {
  const signer = crypto.createSign('sha256')
  signer.update(Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]))
  signer.end()
  return signer.sign({ key: privateKey, dsaEncoding: 'der' }).toString('base64')
}

function publicKeyToBase64Der(publicKey: crypto.KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

describe('verifySendgridSignature', () => {
  const nowSec = Math.floor(Date.now() / 1000)

  it('accepts a valid signature', () => {
    const { privateKey, publicKey } = genKeyPair()
    const body = JSON.stringify([{ event: 'delivered' }])
    const ts = String(nowSec)
    const sig = signPayload(privateKey, ts, body)
    const result = verifySendgridSignature({
      publicKey: publicKeyToBase64Der(publicKey),
      signature: sig,
      timestamp: ts,
      rawBody: body,
      nowSec,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects when signature is missing', () => {
    const { publicKey } = genKeyPair()
    const result = verifySendgridSignature({
      publicKey: publicKeyToBase64Der(publicKey),
      signature: null,
      timestamp: String(nowSec),
      rawBody: 'x',
      nowSec,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing_signature')
  })

  it('rejects when timestamp is too old (replay)', () => {
    const { privateKey, publicKey } = genKeyPair()
    const oldTs = String(nowSec - 60 * 60) // 1 hour ago
    const body = '[]'
    const sig = signPayload(privateKey, oldTs, body)
    const result = verifySendgridSignature({
      publicKey: publicKeyToBase64Der(publicKey),
      signature: sig,
      timestamp: oldTs,
      rawBody: body,
      nowSec,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('timestamp_out_of_range')
  })

  it('rejects when body is tampered after signing', () => {
    const { privateKey, publicKey } = genKeyPair()
    const ts = String(nowSec)
    const sig = signPayload(privateKey, ts, '[{"event":"delivered"}]')
    const result = verifySendgridSignature({
      publicKey: publicKeyToBase64Der(publicKey),
      signature: sig,
      timestamp: ts,
      rawBody: '[{"event":"bounce"}]',  // attacker swapped delivered → bounce
      nowSec,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('signature_mismatch')
  })

  it('rejects when signature was made with a different key', () => {
    const { privateKey } = genKeyPair()
    const { publicKey: attackerPub } = genKeyPair() // different key, same curve
    const ts = String(nowSec)
    const body = '[]'
    const sig = signPayload(privateKey, ts, body)
    const result = verifySendgridSignature({
      publicKey: publicKeyToBase64Der(attackerPub),
      signature: sig,
      timestamp: ts,
      rawBody: body,
      nowSec,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('signature_mismatch')
  })

  it('accepts both raw base64 and PEM-wrapped public keys', () => {
    const { privateKey, publicKey } = genKeyPair()
    const ts = String(nowSec)
    const body = '[]'
    const sig = signPayload(privateKey, ts, body)
    const rawBase64 = publicKeyToBase64Der(publicKey)
    const wrapped = pemFromBase64(rawBase64)

    expect(verifySendgridSignature({ publicKey: rawBase64, signature: sig, timestamp: ts, rawBody: body, nowSec }).ok).toBe(true)
    expect(verifySendgridSignature({ publicKey: wrapped, signature: sig, timestamp: ts, rawBody: body, nowSec }).ok).toBe(true)
  })
})

describe('mapEventToStatus', () => {
  it('maps delivery lifecycle events', () => {
    expect(mapEventToStatus({ event: 'processed' })).toBe('processed')
    expect(mapEventToStatus({ event: 'deferred' })).toBe('deferred')
    expect(mapEventToStatus({ event: 'delivered' })).toBe('delivered')
    expect(mapEventToStatus({ event: 'dropped' })).toBe('dropped')
    expect(mapEventToStatus({ event: 'bounce' })).toBe('bounce')
  })

  it('maps event=bounce with type=blocked to blocked', () => {
    expect(mapEventToStatus({ event: 'bounce', type: 'blocked' })).toBe('blocked')
    expect(mapEventToStatus({ event: 'bounce', type: 'block' })).toBe('blocked')
  })

  it('treats event=blocked (legacy format) as blocked', () => {
    expect(mapEventToStatus({ event: 'blocked' })).toBe('blocked')
  })

  it('ignores engagement events (open, click, spamreport, unsubscribe)', () => {
    expect(mapEventToStatus({ event: 'open' })).toBeNull()
    expect(mapEventToStatus({ event: 'click' })).toBeNull()
    expect(mapEventToStatus({ event: 'spamreport' })).toBeNull()
    expect(mapEventToStatus({ event: 'unsubscribe' })).toBeNull()
    expect(mapEventToStatus({ event: 'group_unsubscribe' })).toBeNull()
  })

  it('is case-insensitive on event name', () => {
    expect(mapEventToStatus({ event: 'DELIVERED' } as unknown as SendgridEvent)).toBe('delivered')
  })
})

describe('shouldUpdateStatus', () => {
  it('always accepts when no previous status', () => {
    expect(shouldUpdateStatus(null, 'processed')).toBe(true)
    expect(shouldUpdateStatus(null, 'delivered')).toBe(true)
    expect(shouldUpdateStatus(null, 'bounce')).toBe(true)
  })

  it('promotes up the priority ladder', () => {
    expect(shouldUpdateStatus('processed', 'deferred')).toBe(true)
    expect(shouldUpdateStatus('processed', 'delivered')).toBe(true)
    expect(shouldUpdateStatus('deferred', 'delivered')).toBe(true)
    expect(shouldUpdateStatus('delivered', 'bounce')).toBe(true)
    expect(shouldUpdateStatus('blocked', 'bounce')).toBe(true)
    expect(shouldUpdateStatus('bounce', 'dropped')).toBe(true)
  })

  it('refuses to downgrade from a terminal failure back to non-terminal', () => {
    expect(shouldUpdateStatus('dropped', 'processed')).toBe(false)
    expect(shouldUpdateStatus('dropped', 'deferred')).toBe(false)
    expect(shouldUpdateStatus('dropped', 'delivered')).toBe(false)
    expect(shouldUpdateStatus('bounce', 'delivered')).toBe(false)
    expect(shouldUpdateStatus('blocked', 'delivered')).toBe(false)
  })

  it('allows delivered to be overwritten by a later async bounce/drop', () => {
    expect(shouldUpdateStatus('delivered', 'bounce')).toBe(true)
    expect(shouldUpdateStatus('delivered', 'dropped')).toBe(true)
    expect(shouldUpdateStatus('delivered', 'blocked')).toBe(true)
  })

  it('refuses to downgrade between terminal failures of lower priority', () => {
    // dropped (6) > bounce (5) > blocked (4) — downgrade is forbidden
    expect(shouldUpdateStatus('dropped', 'bounce')).toBe(false)
    expect(shouldUpdateStatus('bounce', 'blocked')).toBe(false)
  })

  it('allows same-status replays (no-op promote, lets caller update timestamp/event id)', () => {
    expect(shouldUpdateStatus('delivered', 'delivered')).toBe(true)
    expect(shouldUpdateStatus('bounce', 'bounce')).toBe(true)
  })
})

describe('isTerminalFailure', () => {
  it('flags bounce/dropped/blocked as terminal', () => {
    expect(isTerminalFailure('bounce')).toBe(true)
    expect(isTerminalFailure('dropped')).toBe(true)
    expect(isTerminalFailure('blocked')).toBe(true)
  })

  it('does not flag in-flight / success states', () => {
    expect(isTerminalFailure('processed')).toBe(false)
    expect(isTerminalFailure('deferred')).toBe(false)
    expect(isTerminalFailure('delivered')).toBe(false)
    expect(isTerminalFailure(null)).toBe(false)
    expect(isTerminalFailure(undefined)).toBe(false)
  })
})

describe('readExecutionId / readWorkspaceId', () => {
  it('reads top-level fields when SendGrid flattens customArgs', () => {
    expect(readExecutionId({ executionId: 'exec-1' } as SendgridEvent)).toBe('exec-1')
    expect(readWorkspaceId({ workspaceId: 'ws-1' } as SendgridEvent)).toBe('ws-1')
  })

  it('reads from customArgs / custom_args / unique_args wrapper objects', () => {
    expect(readExecutionId({ customArgs: { executionId: 'a' } })).toBe('a')
    expect(readExecutionId({ custom_args: { executionId: 'b' } })).toBe('b')
    expect(readExecutionId({ unique_args: { executionId: 'c' } })).toBe('c')
  })

  it('returns null when no execution id is present', () => {
    expect(readExecutionId({ event: 'delivered' })).toBeNull()
    expect(readExecutionId({ customArgs: {} })).toBeNull()
  })

  it('prefers top-level over wrapper when both are set', () => {
    expect(readExecutionId({ executionId: 'top', customArgs: { executionId: 'nested' } })).toBe('top')
  })
})

describe('readDeliveryError', () => {
  it('prefers reason, falls back to response, then status', () => {
    expect(readDeliveryError({ reason: 'Bounced address' })).toBe('Bounced address')
    expect(readDeliveryError({ response: '550 not allowed' })).toBe('550 not allowed')
    expect(readDeliveryError({ status: '5.1.1' })).toBe('5.1.1')
  })

  it('returns null when nothing is set', () => {
    expect(readDeliveryError({ event: 'delivered' })).toBeNull()
  })

  it('trims very long error strings to 500 chars', () => {
    const long = 'x'.repeat(800)
    expect(readDeliveryError({ reason: long })?.length).toBe(500)
  })
})
