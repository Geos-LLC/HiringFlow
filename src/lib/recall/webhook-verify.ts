/**
 * Verify a Recall.ai webhook signature.
 *
 * Recall delivers webhooks via Svix, which signs the payload with HMAC-SHA256
 * using the endpoint secret. The signed string is `${svix-id}.${svix-timestamp}.${rawBody}`.
 * The signature header carries one or more space-separated `v1,<base64sig>`
 * pairs (Svix supports key rotation by emitting multiple signatures); the
 * request is considered valid if ANY one matches.
 *
 * Header contract (lowercase, set by Svix):
 *   - svix-id        — unique message id
 *   - svix-timestamp — unix seconds; reject if drift > tolerance
 *   - svix-signature — "v1,<sig1> v1,<sig2> ..." (space-separated)
 *
 * Endpoint secret format: "whsec_<base64-encoded random>". The base64 part
 * is the actual HMAC key. We strip the prefix before decoding.
 */

import { createHmac, timingSafeEqual } from 'crypto'

const TOLERANCE_SECONDS = 5 * 60 // ±5 min, Svix default

export interface SvixHeaders {
  id: string
  timestamp: string
  signature: string
}

export function readSvixHeaders(headers: Headers): SvixHeaders | null {
  const id = headers.get('svix-id')
  const timestamp = headers.get('svix-timestamp')
  const signature = headers.get('svix-signature')
  if (!id || !timestamp || !signature) return null
  return { id, timestamp, signature }
}

/**
 * Returns true when the rawBody + headers verify against the configured
 * endpoint secret. False on any failure (missing secret, drift, bad sig).
 * Constant-time compare; no information leak from short-circuit returns.
 */
export function verifyRecallSignature(rawBody: string, headers: SvixHeaders, secret: string): boolean {
  if (!secret) return false
  // Reject obviously old / future-dated messages — protects against replay.
  const ts = Number(headers.timestamp)
  if (!Number.isFinite(ts)) return false
  const driftSec = Math.abs(Math.floor(Date.now() / 1000) - ts)
  if (driftSec > TOLERANCE_SECONDS) return false

  // Strip "whsec_" prefix if present (Svix dashboard exposes the secret with
  // the prefix; the actual HMAC key is the base64-decoded suffix).
  const keyMaterial = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  let key: Buffer
  try {
    key = Buffer.from(keyMaterial, 'base64')
  } catch {
    return false
  }

  const signedPayload = `${headers.id}.${headers.timestamp}.${rawBody}`
  const expected = createHmac('sha256', key).update(signedPayload).digest('base64')

  // Header may carry multiple "v<version>,<sig>" pairs space-separated.
  const candidates = headers.signature.split(' ')
  for (const c of candidates) {
    const [version, sig] = c.split(',', 2)
    if (version !== 'v1' || !sig) continue
    if (sig.length !== expected.length) continue
    try {
      if (timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return true
    } catch {
      // length mismatch from Buffer.from coercion — keep checking other sigs.
    }
  }
  return false
}
