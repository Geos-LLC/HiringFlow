/**
 * POST /api/integrations/telegram/subscribe
 *
 * Enables Telegram publishing for the calling workspace.
 *
 * Two modes (controlled by `?mode=bot|account`, default 'bot'):
 *
 *   bot     — Sigcore allocates (or returns) the per-workspace bot from
 *             the TelePorter pool. Idempotent on Sigcore's side keyed by
 *             tenant. UI proceeds to channel management.
 *
 *   account — No Sigcore call yet; we just create / update the local row
 *             with mode='account', status='provisioning'. The 3-step link
 *             wizard (phone → code → optional 2FA password) is then driven
 *             by /api/integrations/telegram/account/{start,code,password}.
 *             Splitting it this way lets the user choose the mode before
 *             we ask them for credentials.
 *
 * Body (optional, bot mode only):
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

  const url = new URL(request.url)
  const requestedMode = url.searchParams.get('mode') === 'account' ? 'account' : 'bot'

  if (requestedMode === 'account') {
    if (process.env.TELEGRAM_ACCOUNT_MODE_ENABLED !== '1') {
      return NextResponse.json(
        { error: 'Account mode is not yet enabled for this platform' },
        { status: 503 },
      )
    }
    // No Sigcore call — flip the row into account-mode placeholder state.
    // The wizard takes over from here. Keep any previously-linked tg* fields
    // null on re-entry so a partial relink doesn't surface stale identity.
    const row = await prisma.telegramSubscription.upsert({
      where: { workspaceId: ws.workspaceId },
      create: {
        workspaceId: ws.workspaceId,
        status: 'provisioning',
        mode: 'account',
        lastSyncedAt: new Date(),
      },
      update: {
        status: 'provisioning',
        mode: 'account',
        botUsername: null,
        inviteHint: null,
        tgUserId: null,
        tgUsername: null,
        linkAccountId: null,
        linkStatus: null,
        lastSyncedAt: new Date(),
      },
    })
    return NextResponse.json({
      subscription: {
        status: row.status,
        mode: row.mode,
        tgUserId: row.tgUserId,
        tgUsername: row.tgUsername,
        linkAccountId: row.linkAccountId,
        linkStatus: row.linkStatus,
        lastSyncedAt: row.lastSyncedAt,
      },
    })
  }

  // --- bot mode (default) ---
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
        mode: 'bot',
        botUsername: live.botUsername ?? null,
        inviteHint: live.inviteHint ?? null,
        lastSyncedAt: new Date(),
      },
      update: {
        status: live.status,
        mode: 'bot',
        botUsername: live.botUsername ?? null,
        inviteHint: live.inviteHint ?? null,
        // Clear account-mode identity when switching back to bot mode so the
        // UI never shows stale @tgUsername alongside a fresh bot.
        tgUserId: null,
        tgUsername: null,
        linkAccountId: null,
        linkStatus: null,
        lastSyncedAt: new Date(),
      },
    })
    return NextResponse.json({
      subscription: {
        status: row.status,
        mode: row.mode,
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
