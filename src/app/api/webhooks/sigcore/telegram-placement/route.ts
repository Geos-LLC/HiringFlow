/**
 * POST /api/webhooks/sigcore/telegram-placement
 *
 * Receives Sigcore outbound webhook events for Telegram channel placements:
 *
 *   telegram.placement.sent   → TelePorter delivered the message to Telegram.
 *                               Updates TelegramPlacement.status='sent' +
 *                               providerMessageId + sentAt.
 *   telegram.placement.failed → terminal delivery failure (chat not found,
 *                               bot banned, channel removed, etc).
 *                               Updates status='failed' + errorCode/Message
 *                               + failedAt.
 *
 *   anything else             → 200 ack so Sigcore doesn't retry forever.
 *
 * Auth: same HMAC contract as the SMS inbound webhook —
 *   X-Callio-Signature = hex(HMAC-SHA256(SIGCORE_WEBHOOK_KEY, `${ts}.${rawBody}`))
 *   X-Callio-Timestamp = epoch seconds (±5 min skew window)
 * 401 on mismatch / stale ts. 503 if SIGCORE_WEBHOOK_KEY is unset.
 *
 * Event payload (data field) per docs/TELEGRAM_PUBLISHER.md:
 *   {
 *     "placementId": "sigcore-uuid",      // Sigcore's placement id
 *     "chatRef": "@cleaners_jax",
 *     "externalRef": "hf-telegram-placement-uuid",  // HF row id
 *     "teleporterMessageId": "msg_abc123",
 *     "providerMessageId": "tg_999",
 *     "status": "sent" | "failed",
 *     "errorCode": "CHAT_NOT_FOUND",      // failed only
 *     "errorMessage": "...",              // failed only
 *     "occurredAt": "2026-06-19T..."
 *   }
 *
 * Placement matching: prefer `externalRef` (our row id) for direct lookup;
 * fall back to `placementId` against our `sigcorePlacementId` column for
 * the edge case where the publish response wasn't persisted before the
 * callback arrived.
 *
 * Idempotency: callbacks can be re-delivered. We only transition from
 * non-terminal → terminal; once status is 'sent' or 'failed', we no-op.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifySigcoreSignature, isFreshSigcoreTimestamp } from '@/lib/sigcore-signature'

interface PlacementEventPayload {
  event?: string
  timestamp?: string
  data?: {
    placementId?: string
    chatRef?: string
    externalRef?: string
    teleporterMessageId?: string
    providerMessageId?: string
    status?: string
    errorCode?: string | null
    errorMessage?: string | null
    occurredAt?: string
  }
}

const TERMINAL = new Set(['sent', 'failed', 'cancelled'])

export async function POST(req: Request) {
  const expected = process.env.SIGCORE_WEBHOOK_KEY?.trim()
  if (!expected) {
    console.error('[telegram-placement] SIGCORE_WEBHOOK_KEY not configured — refusing all webhooks')
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 })
  }

  const rawBody = await req.text()
  const providedSig = req.headers.get('x-callio-signature')?.trim()
  const providedTs = req.headers.get('x-callio-timestamp')?.trim()

  if (!isFreshSigcoreTimestamp(providedTs, Math.floor(Date.now() / 1000))) {
    return NextResponse.json({ error: 'stale_timestamp' }, { status: 401 })
  }
  if (!providedSig || !verifySigcoreSignature(providedTs as string, rawBody, providedSig, expected)) {
    return NextResponse.json({ error: 'signature_mismatch' }, { status: 401 })
  }

  let payload: PlacementEventPayload
  try {
    payload = JSON.parse(rawBody) as PlacementEventPayload
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const eventType = payload.event ?? ''
  if (eventType === 'telegram.placement.sent') {
    return await handleEvent(payload, 'sent')
  }
  if (eventType === 'telegram.placement.failed') {
    return await handleEvent(payload, 'failed')
  }
  // 200-ack unhandled events so Sigcore stops retrying on event types we
  // don't model (e.g. a future telegram.placement.queued).
  return NextResponse.json({ ok: true, ignored: 'event_not_handled', event: eventType })
}

async function handleEvent(
  payload: PlacementEventPayload,
  status: 'sent' | 'failed',
): Promise<Response> {
  const data = payload.data ?? {}
  const externalRef = typeof data.externalRef === 'string' ? data.externalRef : null
  const sigcorePlacementId = typeof data.placementId === 'string' ? data.placementId : null
  if (!externalRef && !sigcorePlacementId) {
    return NextResponse.json({ ok: true, ignored: 'no_placement_id' })
  }

  // Prefer externalRef (our row id) — single-row PK lookup. Fall back to
  // sigcorePlacementId in case the publish response wasn't persisted before
  // the callback arrived (Vercel kills fire-and-forget; see
  // project_lifecycle_middleware_drops memory for the analogous SMS case).
  const placement = externalRef
    ? await prisma.telegramPlacement.findUnique({ where: { id: externalRef } })
    : await prisma.telegramPlacement.findFirst({ where: { sigcorePlacementId: sigcorePlacementId as string } })

  if (!placement) {
    return NextResponse.json({ ok: true, ignored: 'placement_not_found', externalRef, sigcorePlacementId })
  }

  // Idempotency: terminal → terminal is a no-op even if the new event is a
  // different terminal (we never overwrite sent with failed or vice versa —
  // first terminal wins).
  if (TERMINAL.has(placement.status)) {
    return NextResponse.json({ ok: true, ignored: 'already_terminal', current: placement.status })
  }

  const occurredAt = parseDate(data.occurredAt) ?? new Date()
  const providerMessageId =
    typeof data.providerMessageId === 'string' && data.providerMessageId.length > 0
      ? data.providerMessageId
      : null

  await prisma.telegramPlacement.update({
    where: { id: placement.id },
    data: {
      status,
      providerMessageId: providerMessageId ?? placement.providerMessageId,
      sigcorePlacementId: sigcorePlacementId ?? placement.sigcorePlacementId,
      errorCode: status === 'failed' ? (data.errorCode ?? null) : placement.errorCode,
      errorMessage: status === 'failed' ? (data.errorMessage ?? null) : placement.errorMessage,
      sentAt: status === 'sent' ? occurredAt : placement.sentAt,
      failedAt: status === 'failed' ? occurredAt : placement.failedAt,
    },
  })

  return NextResponse.json({ ok: true, placementId: placement.id, status })
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}
