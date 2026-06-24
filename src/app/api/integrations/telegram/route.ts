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
 *       botUsername?: string,
 *       inviteHint?: string,
 *       lastSyncedAt?: string
 *     }
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getSubscriptionStatus, TelegramConfigError } from '@/lib/telegram-publisher'

// How long before we consider a cached subscription row stale enough to
// re-fetch on a plain GET (without ?sync=1). Onboarding polls hit ?sync=1
// directly so this only affects the steady-state read.
const STALE_MS = 5 * 60 * 1000

export async function GET(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const configured = !!(process.env.SIGCORE_API_URL && process.env.SIGCORE_API_KEY)

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
        row = await prisma.telegramSubscription.upsert({
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
      }
    } catch (err) {
      // Sigcore unreachable — keep the cached row, don't 500. The UI can
      // render "last synced" + a retry button.
      console.warn('[integrations/telegram GET] sync failed:', (err as Error).message)
    }
  }

  return NextResponse.json({
    configured,
    subscription: row
      ? {
          status: row.status,
          botUsername: row.botUsername,
          inviteHint: row.inviteHint,
          lastSyncedAt: row.lastSyncedAt,
        }
      : { status: 'not_initialized' },
  })
}
