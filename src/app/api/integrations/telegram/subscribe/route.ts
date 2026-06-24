/**
 * POST /api/integrations/telegram/subscribe
 *
 * Enables Telegram publishing for the calling workspace. Sigcore allocates
 * (or returns the existing) per-workspace bot from the TelePorter pool;
 * the call is idempotent on Sigcore's side keyed by the tenant.
 *
 * Body (optional):
 *   { displayName?: string }   // BotFather profile display name; defaults
 *                              // to the workspace name when omitted
 *
 * Response: the upserted TelegramSubscription row.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { subscribeWorkspace, TelegramApiError, TelegramConfigError } from '@/lib/telegram-publisher'

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  let displayName: string | undefined
  try {
    const body = (await request.json().catch(() => ({}))) as { displayName?: string }
    if (typeof body.displayName === 'string' && body.displayName.trim().length > 0) {
      displayName = body.displayName.trim()
    }
  } catch {
    // empty body is fine
  }

  if (!displayName) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: ws.workspaceId },
      select: { name: true },
    })
    displayName = workspace?.name ?? undefined
  }

  try {
    const live = await subscribeWorkspace(displayName ? { displayName } : undefined)
    const row = await prisma.telegramSubscription.upsert({
      where: { workspaceId: ws.workspaceId },
      create: {
        workspaceId: ws.workspaceId,
        status: live.status,
        botUsername: live.botUsername ?? null,
        inviteHint: live.inviteHint ?? null,
        lastSyncedAt: new Date(),
      },
      update: {
        status: live.status,
        botUsername: live.botUsername ?? null,
        inviteHint: live.inviteHint ?? null,
        lastSyncedAt: new Date(),
      },
    })
    return NextResponse.json({
      subscription: {
        status: row.status,
        botUsername: row.botUsername,
        inviteHint: row.inviteHint,
        lastSyncedAt: row.lastSyncedAt,
      },
    })
  } catch (err) {
    if (err instanceof TelegramConfigError) {
      return NextResponse.json({ error: 'Sigcore not configured' }, { status: 503 })
    }
    if (err instanceof TelegramApiError) {
      return NextResponse.json(
        { error: err.message, providerStatus: err.status, providerBody: err.providerError },
        { status: 502 },
      )
    }
    console.error('[telegram subscribe] unexpected', err)
    return NextResponse.json({ error: 'subscribe failed' }, { status: 500 })
  }
}
