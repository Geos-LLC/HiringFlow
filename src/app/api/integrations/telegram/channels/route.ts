/**
 * /api/integrations/telegram/channels
 *
 *   GET  → list workspace's channels (oldest first; UI sorts as needed)
 *   POST → add a channel: normalize chatRef, run Sigcore verify, upsert row
 *
 * POST body:
 *   { chatRef: string, displayName?: string, probe?: boolean }
 *
 * `probe: true` sends a test message via TelePorter and deletes it ~2s later.
 * Recommended on first add for `@public_channel` refs where the bot might
 * silently lack `can_post_messages`. Rate-limit expensive — skip on bulk imports.
 *
 * Idempotency: `(workspaceId, chatRef)` is unique. Adding the same chatRef
 * twice updates the existing row's verdict in place.
 */

import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { verifyChat, TelegramApiError, TelegramConfigError } from '@/lib/telegram-publisher'
import { normalizeChatRef, deriveVerifyStatus } from '@/lib/telegram-channels'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const channels = await prisma.telegramChannel.findMany({
    where: { workspaceId: ws.workspaceId },
    orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json({ channels })
}

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = (await request.json().catch(() => ({}))) as {
    chatRef?: string
    displayName?: string
    probe?: boolean
  }
  const chatRef = normalizeChatRef(body.chatRef ?? '')
  if (!chatRef) {
    return NextResponse.json({ error: 'chatRef is required' }, { status: 400 })
  }

  // Require an active subscription before allowing channels — sending to a
  // channel with no bot allocated would fail downstream anyway.
  const subscription = await prisma.telegramSubscription.findUnique({
    where: { workspaceId: ws.workspaceId },
    select: { status: true },
  })
  if (!subscription || subscription.status !== 'ready') {
    return NextResponse.json(
      { error: 'Telegram publishing not ready', subscriptionStatus: subscription?.status ?? 'not_initialized' },
      { status: 409 },
    )
  }

  let verdict
  try {
    verdict = await verifyChat({ chatRef, probe: body.probe === true })
  } catch (err) {
    if (err instanceof TelegramConfigError) {
      return NextResponse.json({ error: 'Sigcore not configured' }, { status: 503 })
    }
    if (err instanceof TelegramApiError) {
      // Persist the failed verify so the UI can show what went wrong instead
      // of dropping the channel silently — recruiter can then fix permissions
      // and re-verify rather than re-entering the chatRef.
      const channel = await prisma.telegramChannel.upsert({
        where: { workspaceId_chatRef: { workspaceId: ws.workspaceId, chatRef } },
        create: {
          workspaceId: ws.workspaceId,
          chatRef,
          displayName: body.displayName?.trim() || null,
          verifyStatus: 'blocked',
          verifyVerdict: Prisma.JsonNull,
          lastVerifyError: err.message,
        },
        update: {
          displayName: body.displayName?.trim() || undefined,
          verifyStatus: 'blocked',
          lastVerifyError: err.message,
        },
      })
      return NextResponse.json({ channel, verifyError: err.message }, { status: 502 })
    }
    console.error('[telegram channels POST] unexpected', err)
    return NextResponse.json({ error: 'verify failed' }, { status: 500 })
  }

  const verifyStatus = deriveVerifyStatus(verdict)
  const channel = await prisma.telegramChannel.upsert({
    where: { workspaceId_chatRef: { workspaceId: ws.workspaceId, chatRef } },
    create: {
      workspaceId: ws.workspaceId,
      chatRef,
      displayName: body.displayName?.trim() || null,
      verifyStatus,
      verifyVerdict: verdict as any,
      verifiedAt: new Date(),
      lastVerifyError: null,
    },
    update: {
      displayName: body.displayName?.trim() || undefined,
      verifyStatus,
      verifyVerdict: verdict as any,
      verifiedAt: new Date(),
      lastVerifyError: null,
    },
  })

  return NextResponse.json({ channel })
}
