/**
 * POST /api/webhooks/recall
 *
 * Receives Recall.ai bot lifecycle events. Verifies Svix signature against
 * RECALL_WEBHOOK_SECRET, resolves the InterviewMeeting via the bot id, and
 * dispatches into src/lib/recall/sync.ts which writes the same lifecycle
 * SchedulingEvents the Workspace Events Meet API path emits.
 *
 * Auth: Svix HMAC-SHA256 signature in `svix-signature` header (see
 * src/lib/recall/webhook-verify.ts). 401 on missing/bad signature; 503 when
 * the secret env var isn't set so we surface deploy misconfig instead of
 * silently dropping events.
 *
 * Idempotency: every handler in sync.ts dedupes on
 * (sessionId, eventType, metadata.interviewMeetingId) — Recall retries on
 * 4xx/5xx for 24h, and we return 200 to retries on already-handled events.
 *
 * Middleware: see src/middleware.ts allowlist; signature verification is
 * inside this handler so we can return diagnostic errors on misconfig
 * without exposing the route to unauthenticated traffic in any other way.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { readSvixHeaders, verifyRecallSignature } from '@/lib/recall/webhook-verify'
import { dispatchRecallEvent } from '@/lib/recall/sync'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface RecallWebhookPayload {
  event?: string
  data?: {
    data?: {
      code?: string
      sub_code?: string | null
      updated_at?: string
    }
    bot?: {
      id?: string
      metadata?: Record<string, string>
    }
  }
}

export async function POST(request: NextRequest) {
  const secret = process.env.RECALL_WEBHOOK_SECRET
  if (!secret) {
    console.error('[recall webhook] RECALL_WEBHOOK_SECRET not set — refusing request')
    return NextResponse.json({ error: 'webhook_secret_unset' }, { status: 503 })
  }

  const svixHeaders = readSvixHeaders(request.headers)
  if (!svixHeaders) {
    return NextResponse.json({ error: 'missing_signature_headers' }, { status: 401 })
  }
  const rawBody = await request.text()
  if (!verifyRecallSignature(rawBody, svixHeaders, secret)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let body: RecallWebhookPayload
  try { body = JSON.parse(rawBody) as RecallWebhookPayload }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

  const event = body.event ?? body.data?.data?.code ?? ''
  const botId = body.data?.bot?.id ?? ''
  const occurredAtRaw = body.data?.data?.updated_at
  const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date()
  if (!event || !botId) {
    return NextResponse.json({ error: 'malformed_event', received: { event, botId } }, { status: 400 })
  }

  // Resolve the InterviewMeeting. Two paths:
  //   1. Bot metadata carries our interviewMeetingId (set at schedule time).
  //   2. Fallback: lookup by unique recallBotId column we stamped on
  //      scheduleBot success.
  let interviewMeetingId: string | null = null
  const metaId = body.data?.bot?.metadata?.interviewMeetingId
  if (typeof metaId === 'string' && metaId.length > 0) {
    interviewMeetingId = metaId
  } else {
    const row = await prisma.interviewMeeting.findUnique({
      where: { recallBotId: botId },
      select: { id: true },
    })
    interviewMeetingId = row?.id ?? null
  }
  if (!interviewMeetingId) {
    // 200 — don't make Recall retry forever on a bot whose meeting we've
    // since deleted or that belongs to a different environment.
    console.warn('[recall webhook] no meeting matches bot', botId, 'event', event)
    return NextResponse.json({ ok: true, ignored: 'no_meeting' }, { status: 200 })
  }

  try {
    await dispatchRecallEvent({
      event,
      meetingId: interviewMeetingId,
      botId,
      occurredAt,
    })
  } catch (err) {
    console.error('[recall webhook] dispatch failed:', (err as Error).message)
    // Return 5xx so Recall retries — error was likely transient (DB hiccup,
    // upstream getBot API error, etc.).
    return NextResponse.json({ error: 'dispatch_failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, event, meetingId: interviewMeetingId }, { status: 200 })
}
