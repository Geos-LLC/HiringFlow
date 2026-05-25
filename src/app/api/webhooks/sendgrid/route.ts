/**
 * POST /api/webhooks/sendgrid
 *
 * SendGrid Event Webhook receiver — global, account-wide. The webhook URL
 * is configured ONCE in the SendGrid dashboard (Mail Settings → Event
 * Webhook). All HF outbound email runs through the same SendGrid account,
 * so a single endpoint covers every workspace.
 *
 * Each event in the bulk payload echoes back the `customArgs` we attached
 * at send time (`executionId`, `workspaceId`, `candidateId`) — we use
 * those to find the right `AutomationExecution` row and update its
 * `deliveryStatus`. Cross-workspace event/execution mismatches are
 * silently dropped (defense against forged customArgs).
 *
 * Auth: ECDSA-P256 signature over `timestamp + rawBody`, header
 * `X-Twilio-Email-Event-Webhook-Signature`. Public key in
 * `SENDGRID_WEBHOOK_PUBLIC_KEY` env var. In production a missing/invalid
 * signature returns 401. In dev (NODE_ENV !== 'production') we accept
 * unsigned for local smoke tests but log a warning.
 *
 * Idempotency: `shouldUpdateStatus` enforces the priority ladder
 *   processed < deferred < delivered < blocked < bounce < dropped
 * so duplicate deliveries from SendGrid's retry queue are harmless.
 *
 * Engagement events (open, click, spamreport, unsubscribe, …) are
 * ignored — we only track delivery confirmation.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySendgridSignature,
  mapEventToStatus,
  readExecutionId,
  type SendgridEvent,
} from '@/lib/sendgrid-events'
import { applyEventToExecution } from '@/lib/sendgrid-apply-event'

// SendGrid uses gzip compression when bulk events are large; Next.js
// already decompresses by default. Force this route to dynamic so the
// raw body is always available for signature verification.
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const publicKey = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY
  const rawBody = await request.text()

  // Verify signature when the key is configured. In production a missing
  // key is a hard fail (503) — we can't trust unsigned events to update
  // candidate timelines. In dev we accept and log so local SendGrid
  // forwarding ("twilio sendgrid event forwarding") can be tested.
  const isProd = process.env.NODE_ENV === 'production'
  if (publicKey) {
    const verifyResult = verifySendgridSignature({
      publicKey,
      signature: request.headers.get(SIGNATURE_HEADER),
      timestamp: request.headers.get(TIMESTAMP_HEADER),
      rawBody,
    })
    if (!verifyResult.ok) {
      console.warn('[SendGridWebhook] signature verification failed:', verifyResult.reason)
      return NextResponse.json({ error: 'Invalid signature', reason: verifyResult.reason }, { status: 401 })
    }
  } else if (isProd) {
    console.error('[SendGridWebhook] SENDGRID_WEBHOOK_PUBLIC_KEY not configured in production — refusing')
    return NextResponse.json({ error: 'Webhook public key not configured' }, { status: 503 })
  } else {
    console.warn('[SendGridWebhook] SENDGRID_WEBHOOK_PUBLIC_KEY not set — accepting unsigned event in non-production')
  }

  let events: SendgridEvent[] = []
  try {
    const parsed = JSON.parse(rawBody)
    events = Array.isArray(parsed) ? parsed : []
  } catch (err) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  let processed = 0
  let skipped = 0
  let errors = 0

  for (const ev of events) {
    try {
      const next = mapEventToStatus(ev)
      if (!next) {
        skipped++
        continue
      }
      const executionId = readExecutionId(ev)
      if (!executionId) {
        skipped++
        continue
      }
      const result = await applyEventToExecution(executionId, next, ev)
      if (result === 'updated') processed++
      else skipped++
    } catch (err) {
      errors++
      console.error('[SendGridWebhook] error applying event', err)
    }
  }

  return NextResponse.json({ ok: true, processed, skipped, errors })
}
