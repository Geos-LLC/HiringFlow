/**
 * GET /api/integrations/telegram
 *
 * Returns the workspace's Telegram subscription state for rendering the
 * Settings → Integrations tile. Reads from the local cache row; opportunistically
 * refreshes from Sigcore when the row is stale or when the caller passes
 * `?sync=1` (used by the post-subscribe poll loop in the UI).
 *
 * Response shape:
 *   {
 *     configured: boolean,           // Sigcore env vars present
 *     subscription: {
 *       status: 'not_initialized' | 'provisioning' | 'ready' | 'retired',
 *       mode: 'bot' | 'account',
 *       // bot-mode identity
 *       botUsername?: string | null,
 *       inviteHint?: string | null,
 *       // account-mode identity
 *       tgUserId?: string | null,
 *       tgUsername?: string | null,
 *       linkAccountId?: string | null,
 *       linkStatus?: 'code_requested' | 'password_required' | 'linked' | 'revoked' | null,
 *       lastSyncedAt?: string | null
 *     }
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getSubscriptionStatus } from '@/lib/telegram-publisher'

// How long before we consider a cached subscription row stale enough to
// re-fetch on a plain GET (without ?sync=1). Onboarding polls hit ?sync=1
// directly so this only affects the steady-state read.
const STALE_MS = 5 * 60 * 1000

export async function GET(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const configured = !!(process.env.SIGCORE_API_URL && process.env.SIGCORE_API_KEY)
  // Account-mode is gated until the Sigcore wrapper + TelePorter GramJS
  // session manager land. Flip `TELEGRAM_ACCOUNT_MODE_ENABLED=1` to expose
  // the picker + wizard in the UI. Bot mode is unaffected.
  const accountModeEnabled = process.env.TELEGRAM_ACCOUNT_MODE_ENABLED === '1'

  const url = new URL(request.url)
  const forceSync = url.searchParams.get('sync') === '1'

  let row = await prisma.telegramSubscription.findUnique({
    where: { workspaceId: ws.workspaceId },
  })

  const stale = !row?.lastSyncedAt || Date.now() - row.lastSyncedAt.getTime() > STALE_MS
  if (configured && (forceSync || stale)) {
    try {
      const live = await getSubscriptionStatus()
      if (live.status === 'not_initialized') {
        // Sigcore says no subscriber — drop any stale local row so we don't
        // confuse the UI. Onboarding is the only path that should resurface it.
        if (row) {
          await prisma.telegramSubscription.delete({ where: { workspaceId: ws.workspaceId } })
          row = null
        }
      } else {
        // Preserve local mode if Sigcore omits it (older response shape).
        // Once Sigcore returns mode, we adopt it as source of truth.
        const mode = live.mode ?? row?.mode ?? 'bot'
        row = await prisma.telegramSubscription.upsert({
          where: { workspaceId: ws.workspaceId },
          create: {
            workspaceId: ws.workspaceId,
            status: live.status,
            mode,
            botUsername: live.botUsername ?? null,
            inviteHint: live.inviteHint ?? null,
            tgUserId: live.tgUserId ?? null,
            tgUsername: live.tgUsername ?? null,
            linkAccountId: live.linkAccountId ?? null,
            linkStatus: live.linkStatus ?? null,
            lastSyncedAt: new Date(),
          },
          update: {
            status: live.status,
            mode,
            botUsername: live.botUsername ?? null,
            inviteHint: live.inviteHint ?? null,
            tgUserId: live.tgUserId ?? null,
            tgUsername: live.tgUsername ?? null,
            linkAccountId: live.linkAccountId ?? null,
            linkStatus: live.linkStatus ?? null,
            lastSyncedAt: new Date(),
          },
        })
      }
    } catch (err) {
      // Sigcore unreachable — keep the cached row, don't 500. The UI can
      // render "last synced" + a retry button.
      console.warn('[integrations/telegram GET] sync failed:', (err as Error).message)
    }
  }

  return NextResponse.json({
    configured,
    accountModeEnabled,
    subscription: row
      ? {
          status: row.status,
          mode: row.mode,
          botUsername: row.botUsername,
          inviteHint: row.inviteHint,
          tgUserId: row.tgUserId,
          tgUsername: row.tgUsername,
          linkAccountId: row.linkAccountId,
          linkStatus: row.linkStatus,
          lastSyncedAt: row.lastSyncedAt,
        }
      : { status: 'not_initialized', mode: 'bot' },
  })
}
