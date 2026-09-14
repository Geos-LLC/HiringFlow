/**
 * MC webhook signature verification.
 *
 * MC signs at delivery time (not enqueue) — see the mockcustomer repo's
 * webhook-signer + webhook-delivery.worker. Header format is Stripe-style:
 *
 *     X-MC-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
 *
 * Signed content is `<unix-seconds>.<raw-request-body>`. The raw body
 * MUST be the exact bytes as delivered on the wire — Node's request
 * parsers normalize JSON in ways that break byte-identity, so the caller
 * is responsible for reading `request.text()` (not `.json()`) and passing
 * that string here verbatim.
 *
 * Skew: receiver rejects when `|now - t| > 300s` (matches MC's default
 * skew slack). If MC's retry queue holds a delivery past that window,
 * verification fails and the event is 401'd — MC will keep retrying and
 * eventually give up. That's intentional: a signature that's 6+ minutes
 * stale is more likely a replay attack than a legitimate delivery.
 */

import { createHmac, timingSafeEqual } from 'crypto'

export const MC_SIGNATURE_HEADER = 'X-MC-Signature'
export const MC_MAX_SKEW_SEC = 300

export type McVerifyResult =
  | { valid: true; timestamp: number }
  | {
      valid: false
      reason:
        | 'missing_header'
        | 'malformed_header'
        | 'timestamp_skew'
        | 'signature_mismatch'
    }

interface ParsedHeader {
  t: number
  v1: string
}

export function parseMcSignatureHeader(header: string | null | undefined): ParsedHeader | null {
  if (!header) return null
  let t: number | null = null
  let v1: string | null = null
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') {
      const parsed = Number.parseInt(value, 10)
      if (Number.isFinite(parsed) && parsed > 0) t = parsed
    } else if (key === 'v1') {
      if (/^[0-9a-f]{64}$/.test(value)) v1 = value
    }
  }
  if (t === null || v1 === null) return null
  return { t, v1 }
}

/**
 * Verify a raw body against a signature header + secret.
 *
 * @param rawBody   the exact string that arrived on the wire. Callers MUST
 *                  use `request.text()` — passing `JSON.stringify(await
 *                  request.json())` will fail because Node's JSON
 *                  round-trip normalizes bytes.
 * @param header    the value of the `X-MC-Signature` header.
 * @param secret    the plaintext `whsec_*` from McWorkspaceMapping (already
 *                  decrypted).
 * @param options   test seams: `nowUnix` overrides the wall clock;
 *                  `maxSkewSec` overrides the default 300s window.
 */
export function verifyMcSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  options: { nowUnix?: number; maxSkewSec?: number } = {},
): McVerifyResult {
  if (!header) return { valid: false, reason: 'missing_header' }
  const parsed = parseMcSignatureHeader(header)
  if (!parsed) return { valid: false, reason: 'malformed_header' }
  const now = options.nowUnix ?? Math.floor(Date.now() / 1000)
  const maxSkew = options.maxSkewSec ?? MC_MAX_SKEW_SEC
  if (Math.abs(now - parsed.t) > maxSkew) {
    return { valid: false, reason: 'timestamp_skew' }
  }
  const expected = createHmac('sha256', secret).update(`${parsed.t}.${rawBody}`).digest('hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  const gotBuf = Buffer.from(parsed.v1, 'hex')
  if (expectedBuf.length !== gotBuf.length) {
    return { valid: false, reason: 'signature_mismatch' }
  }
  if (!timingSafeEqual(expectedBuf, gotBuf)) {
    return { valid: false, reason: 'signature_mismatch' }
  }
  return { valid: true, timestamp: parsed.t }
}
