/**
 * POST /api/webhooks/sigcore/telegram-account
 *
 * Receives Sigcore outbound webhook events for account-mode Telegram link
 * lifecycle:
 *
 *   telegram.account.linked   → GramJS session established (or re-established
 *                               after a refresh). Updates the local row with
 *                               tgUserId / tgUsername / linkAccountId, flips
 *                               status='ready' + linkStatus='linked'.
 *   telegram.account.revoked  → Telegram terminated the session (USER_DEACTIVATED,
 *                               AUTH_KEY_UNREGISTERED, manual logout, etc).
 *                               Updates status='retired' + linkStatus='revoked';
 *                               UI surfaces the "Your Telegram account was
 *                               logged out" banner from the GET response.
 *
 *   anything else             → 200 ack so Sigcore doesn't retry forever.
 *
 * Auth: same HMAC contract as the SMS inbound + telegram-placement webhooks —
 *   X-Callio-Signature = hex(HMAC-SHA256(SIGCORE_WEBHOOK_KEY, `${ts}.${rawBody}`))
 *   X-Callio-Timestamp = epoch seconds (±5 min skew window)
 * 401 on mismatch / stale ts. 503 if SIGCORE_WEBHOOK_KEY is unset.
 *
 * Event payload (data field):
 *   {
 *     "workspaceId": "hf-ws-uuid",   // Sigcore re-sends our workspace id
 *                                    // — we ignore this and trust the tenant
 *                                    // mapping (linkAccountId → workspace)
 *     "linkAccountId": "sigcore-uuid",
 *     "tgUserId": "123456789",
 *     "tgUsername": "alice",
 *     "reason": "USER_DEACTIVATED",  // revoked only
 *     "occurredAt": "2026-06-25T..."
 *   }
 *
 * Workspace match: prefer `linkAccountId` against our column; fall back to
 * the workspaceId field for events where Sigcore hasn't issued an accountId
 * yet (theoretical, but cheap to support).
 *
 * Idempotency: re-deliveries are safe — terminal states are set with
 * absolute values, not transitions. `account.revoked` overwrites a `linked`
 * row to revoked; `account.linked` overwrites a `revoked` row to linked
 * (e.g. after a relink with the same accountId).
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifySigcoreSignature, isFreshSigcoreTimestamp } from '@/lib/sigcore-signature'

interface AccountEventPayload {
  event?: string
  timestamp?: string
  data?: {
    workspaceId?: string
    linkAccountId?: string
    tgUserId?: string
    tgUsername?: string
    reason?: string
    occurredAt?: string
  }
}

export async function POST(req: Request) {
  const expected = process.env.SIGCORE_WEBHOOK_KEY?.trim()
  if (!expected) {
    console.error('[telegram-account] SIGCORE_WEBHOOK_KEY not configured — refusing all webhooks')
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

  let payload: AccountEventPayload
  try {
    payload = JSON.parse(rawBody) as AccountEventPayload
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const eventType = payload.event ?? ''
  if (eventType === 'telegram.account.linked') {
    return await handleLinked(payload)
  }
  if (eventType === 'telegram.account.revoked') {
    return await handleRevoked(payload)
  }
  return NextResponse.json({ ok: true, ignored: 'event_not_handled', event: eventType })
}

async function findSubscription(data: NonNullable<AccountEventPayload['data']>) {
  if (data.linkAccountId) {
    const byAccount = await prisma.telegramSubscription.findFirst({
      where: { linkAccountId: data.linkAccountId },
    })
    if (byAccount) return byAccount
  }
  if (data.workspaceId) {
    return prisma.telegramSubscription.findUnique({
      where: { workspaceId: data.workspaceId },
    })
  }
  return null
}

async function handleLinked(payload: AccountEventPayload): Promise<Response> {
  const data = payload.data ?? {}
  const subscription = await findSubscription(data)
  if (!subscription) {
    return NextResponse.json({ ok: true, ignored: 'subscription_not_found' })
  }
  if (subscription.mode !== 'account') {
    // Sanity: shouldn't happen but don't clobber a bot-mode row.
    return NextResponse.json({ ok: true, ignored: 'wrong_mode', mode: subscription.mode })
  }

  await prisma.telegramSubscription.update({
    where: { workspaceId: subscription.workspaceId },
    data: {
      status: 'ready',
      linkStatus: 'linked',
      linkAccountId: data.linkAccountId ?? subscription.linkAccountId,
      tgUserId: data.tgUserId ?? subscription.tgUserId,
      tgUsername: data.tgUsername ?? subscription.tgUsername,
      lastSyncedAt: new Date(),
    },
  })

  return NextResponse.json({ ok: true, workspaceId: subscription.workspaceId, status: 'linked' })
}

async function handleRevoked(payload: AccountEventPayload): Promise<Response> {
  const data = payload.data ?? {}
  const subscription = await findSubscription(data)
  if (!subscription) {
    return NextResponse.json({ ok: true, ignored: 'subscription_not_found' })
  }
  if (subscription.mode !== 'account') {
    return NextResponse.json({ ok: true, ignored: 'wrong_mode', mode: subscription.mode })
  }

  await prisma.telegramSubscription.update({
    where: { workspaceId: subscription.workspaceId },
    data: {
      status: 'retired',
      linkStatus: 'revoked',
      // Keep tgUsername around for one render so the UI can say "Your account
      // @alice was logged out" — don't clear it. The DELETE handler is the
      // place that wipes identity on user-initiated unlink.
      lastSyncedAt: new Date(),
    },
  })

  return NextResponse.json({ ok: true, workspaceId: subscription.workspaceId, status: 'revoked', reason: data.reason })
}
