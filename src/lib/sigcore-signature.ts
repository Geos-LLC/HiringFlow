/**
 * Sigcore outbound-webhook signature verification (post-2026-05-07 contract).
 *
 * Sigcore signs each webhook with:
 *   X-Callio-Signature  = hex(HMAC-SHA256(secret, `${ts}.${rawBody}`))
 *   X-Callio-Timestamp  = epoch seconds (integer string)
 *
 * We verify both the HMAC and a ±5 minute freshness window on the timestamp.
 * The freshness check bounds replay attacks even when the secret hasn't
 * leaked — an attacker would have to replay the captured request within the
 * window.
 *
 * Contract history:
 *   - Pre-2026-05-07 Sigcore commit 12e9bd8f: signed `rawBody` only, no ts.
 *   - 2026-05-07 onwards: signs `${ts}.${rawBody}` and emits ts header.
 *
 * HF's verifier was stuck on the pre-2026-05-07 contract until 2026-06-05,
 * dropping every inbound delivery during that window. The regression test
 * in `sigcore-signature.test.ts` pins the new contract so that revert is
 * caught at CI.
 */

import { createHmac, timingSafeEqual } from 'crypto'

// ±5 minute window. Bumping this lowers replay safety; lowering it risks
// rejecting legitimate deliveries on slow network paths.
export const SIGCORE_SKEW_SECONDS = 300

export function verifySigcoreSignature(
  ts: string,
  rawBody: string,
  providedHex: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
  // timingSafeEqual requires equal-length buffers; bail early on mismatched
  // length so we don't throw.
  if (expected.length !== providedHex.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(providedHex, 'hex'))
  } catch {
    return false
  }
}

export function isFreshSigcoreTimestamp(
  tsHeader: string | null | undefined,
  nowSeconds: number,
): boolean {
  if (!tsHeader) return false
  const ts = parseInt(tsHeader, 10)
  if (!Number.isFinite(ts)) return false
  return Math.abs(nowSeconds - ts) <= SIGCORE_SKEW_SECONDS
}
