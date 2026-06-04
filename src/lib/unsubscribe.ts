/**
 * Signed, stateless unsubscribe tokens for the `List-Unsubscribe` header
 * required by Apple (Feb 2024) and Gmail bulk-sender rules. The header
 * carries a one-click URL that mailbox providers can hit on the
 * candidate's behalf without rendering a page.
 *
 * Token format: `${sessionId}.${sig}` where sig is base64url HMAC-SHA256
 * of sessionId, truncated to 16 bytes (128 bits — plenty for a non-secret
 * unsubscribe path).
 *
 * No expiry: once a candidate has clicked unsubscribe, the link continues
 * to work if the candidate clicks it again. Idempotent on our side.
 *
 * Secret reuses NEXTAUTH_SECRET — no new env var required.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto'

function getSecret(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET || ''
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET required to sign unsubscribe links')
  }
  return createHash('sha256').update('unsubscribe:' + secret).digest()
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function sign(sessionId: string): string {
  return base64url(createHmac('sha256', getSecret()).update(sessionId).digest().subarray(0, 16))
}

export function signUnsubscribeToken(sessionId: string): string {
  return `${sessionId}.${sign(sessionId)}`
}

export type UnsubscribeVerifyResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'malformed' | 'invalid_signature' }

export function verifyUnsubscribeToken(token: string | null | undefined): UnsubscribeVerifyResult {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' }
  const dot = token.indexOf('.')
  if (dot < 1 || dot === token.length - 1) return { ok: false, reason: 'malformed' }
  const sessionId = token.slice(0, dot)
  const givenSigB64 = token.slice(dot + 1)
  let givenSig: Buffer
  try {
    givenSig = fromBase64url(givenSigB64)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const expectedSig = createHmac('sha256', getSecret()).update(sessionId).digest().subarray(0, 16)
  if (givenSig.length !== expectedSig.length) {
    return { ok: false, reason: 'invalid_signature' }
  }
  if (!timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: 'invalid_signature' }
  }
  return { ok: true, sessionId }
}

export function buildUnsubscribeUrl(sessionId: string, appUrl?: string): string {
  const base = (appUrl || process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://hirefunnel.app').replace(/\/+$/, '')
  return `${base}/u/${signUnsubscribeToken(sessionId)}`
}
