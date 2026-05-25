import crypto from 'crypto'

// ─── Signed Event Webhook verification ─────────────────────────────────
//
// SendGrid signs every Event Webhook payload with an ECDSA-P256 (ES256)
// signature over `timestamp + rawBody`. The public key lives in the
// SendGrid dashboard (Mail Settings → Event Webhook) and must be pasted
// into the SENDGRID_WEBHOOK_PUBLIC_KEY env var. Webhook handler MUST
// reject requests whose signature does not match.
//
// Docs:
// https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features
//
// The pubkey arrives base64-DER, not PEM. We wrap it in BEGIN/END lines
// so Node's crypto.createPublicKey can parse it.

export const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature'
export const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp'

// Allowed skew between SendGrid's signing timestamp and our wall clock,
// in seconds. SendGrid can retry deliveries within a few minutes; we
// allow 10 minutes either side to absorb that without rejecting legit
// retries, while still blocking ancient replays.
const MAX_TIMESTAMP_SKEW_SECONDS = 10 * 60

export function pemFromBase64(rawKey: string): string {
  const cleaned = rawKey.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '')
  // Re-wrap at 64-char lines so PEM parsers are happy.
  const wrapped = cleaned.match(/.{1,64}/g)?.join('\n') ?? cleaned
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`
}

export interface VerifyArgs {
  publicKey: string
  signature: string | null
  timestamp: string | null
  rawBody: string
  // Clock injectable for tests; defaults to Date.now() in seconds.
  nowSec?: number
}

export function verifySendgridSignature(args: VerifyArgs): { ok: true } | { ok: false; reason: string } {
  if (!args.signature) return { ok: false, reason: 'missing_signature' }
  if (!args.timestamp) return { ok: false, reason: 'missing_timestamp' }
  if (!args.publicKey) return { ok: false, reason: 'missing_public_key' }

  // Reject replays. SendGrid's timestamp is unix seconds.
  const sentSec = Number(args.timestamp)
  if (!Number.isFinite(sentSec)) return { ok: false, reason: 'invalid_timestamp' }
  const now = args.nowSec ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - sentSec) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_range' }
  }

  let keyObject: crypto.KeyObject
  try {
    keyObject = crypto.createPublicKey(pemFromBase64(args.publicKey))
  } catch (err) {
    return { ok: false, reason: 'invalid_public_key' }
  }

  // Signed payload format: timestamp + rawBody. SendGrid signs with
  // SHA-256 over the concatenation, in DER signature format encoded
  // base64.
  const signedPayload = Buffer.concat([
    Buffer.from(args.timestamp, 'utf8'),
    Buffer.from(args.rawBody, 'utf8'),
  ])

  let signatureBytes: Buffer
  try {
    signatureBytes = Buffer.from(args.signature, 'base64')
  } catch {
    return { ok: false, reason: 'invalid_signature_encoding' }
  }

  const verifier = crypto.createVerify('sha256')
  verifier.update(signedPayload)
  verifier.end()

  let ok = false
  try {
    ok = verifier.verify({ key: keyObject, dsaEncoding: 'der' }, signatureBytes)
  } catch {
    ok = false
  }
  return ok ? { ok: true } : { ok: false, reason: 'signature_mismatch' }
}

// ─── Event mapping + status priority ────────────────────────────────────
//
// SendGrid Event Webhook delivery events we care about:
//   processed  — accepted into the send queue
//   deferred   — recipient MTA is asking SendGrid to retry later
//   delivered  — handed off successfully to the recipient MTA
//   bounce     — hard rejection (404 No Such User, etc.)
//                If event.type === 'blocked' OR classification === 'block'
//                we map to our 'blocked' so the timeline distinguishes
//                IP/domain reputation problems from address failures.
//   dropped    — SendGrid refused to send (suppression list, invalid
//                addr, spam content). Final.
//
// We deliberately ignore engagement events (open, click) — irrelevant
// to delivery confirmation and would noise up the timeline.

export type DeliveryStatus = 'processed' | 'deferred' | 'delivered' | 'blocked' | 'bounce' | 'dropped'

const DELIVERY_PRIORITY: Record<DeliveryStatus, number> = {
  processed: 1,
  deferred: 2,
  delivered: 3,
  blocked: 4,
  bounce: 5,
  dropped: 6,
}

export function isTerminalFailure(s: DeliveryStatus | null | undefined): boolean {
  return s === 'blocked' || s === 'bounce' || s === 'dropped'
}

export function isWarningStatus(s: DeliveryStatus | null | undefined): boolean {
  return s === 'deferred' || isTerminalFailure(s)
}

// Decide which status wins when an existing delivery row gets a new event.
// Rules:
//   1. Terminal failures never get downgraded — once 'dropped'/'bounce'/'blocked'
//      is set, only a higher-priority terminal can override.
//   2. 'delivered' CAN be overwritten by a later terminal failure if SendGrid
//      sends one (rare async bounce path).
//   3. Lower-priority events (processed, deferred) never overwrite
//      higher-priority ones.
//   4. Same status replays update the timestamp + event id but no status
//      change (idempotent retries).
export function shouldUpdateStatus(prev: DeliveryStatus | null | undefined, next: DeliveryStatus): boolean {
  if (!prev) return true
  // Block downgrade from terminal failure → non-terminal.
  if (isTerminalFailure(prev) && !isTerminalFailure(next)) return false
  return DELIVERY_PRIORITY[next] >= DELIVERY_PRIORITY[prev]
}

export interface SendgridEvent {
  event?: string
  type?: string  // bounce sub-type; 'blocked' or 'bounce'
  reason?: string
  response?: string
  status?: string
  sg_message_id?: string
  sg_event_id?: string
  timestamp?: number
  email?: string
  // SendGrid forwards customArgs flat onto the top-level event payload.
  // We read defensively from a few aliases the SDK has used over time.
  executionId?: string
  workspaceId?: string
  candidateId?: string
  customArgs?: Record<string, string>
  custom_args?: Record<string, string>
  unique_args?: Record<string, string>
  [k: string]: unknown
}

export function mapEventToStatus(ev: SendgridEvent): DeliveryStatus | null {
  const raw = (ev.event || '').toLowerCase()
  switch (raw) {
    case 'processed': return 'processed'
    case 'deferred': return 'deferred'
    case 'delivered': return 'delivered'
    case 'dropped': return 'dropped'
    case 'blocked': return 'blocked'  // legacy event type
    case 'bounce':
    case 'bounced': {
      const sub = (ev.type || '').toLowerCase()
      // SendGrid distinguishes hard bounces ('bounce') from IP/content
      // blocks ('blocked'). Both ride on the event=bounce wire format.
      return sub === 'blocked' || sub === 'block' ? 'blocked' : 'bounce'
    }
    default:
      return null
  }
}

// Pull executionId out of an event, defensively. SendGrid has shipped
// customArgs under three names over the years.
export function readExecutionId(ev: SendgridEvent): string | null {
  if (typeof ev.executionId === 'string' && ev.executionId) return ev.executionId
  const sources = [ev.customArgs, ev.custom_args, ev.unique_args]
  for (const src of sources) {
    if (src && typeof src === 'object' && typeof src.executionId === 'string' && src.executionId) {
      return src.executionId
    }
  }
  return null
}

export function readWorkspaceId(ev: SendgridEvent): string | null {
  if (typeof ev.workspaceId === 'string' && ev.workspaceId) return ev.workspaceId
  const sources = [ev.customArgs, ev.custom_args, ev.unique_args]
  for (const src of sources) {
    if (src && typeof src === 'object' && typeof src.workspaceId === 'string' && src.workspaceId) {
      return src.workspaceId
    }
  }
  return null
}

// Pick a human-readable reason for the timeline tooltip. SendGrid puts
// the human string in `reason` for blocked/dropped, in `response` for
// bounce (it's the SMTP response from the recipient MTA), and `status`
// is the numeric code.
export function readDeliveryError(ev: SendgridEvent): string | null {
  const candidates = [ev.reason, ev.response, ev.status]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 500)
  }
  return null
}
