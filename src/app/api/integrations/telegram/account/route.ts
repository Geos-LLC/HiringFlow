/**
 * DELETE /api/integrations/telegram/account
 *
 * Unlink the workspace's Telegram account. Calls Sigcore which terminates
 * the GramJS session and wipes the encrypted session blob in Secret Manager.
 * Local row is flipped to status='retired', linkStatus='revoked' and the
 * identity fields are cleared so the UI shows the "Re-link" CTA instead of
 * a stale @username.
 *
 * Idempotent: if no account is currently linked, both Sigcore and HF return
 * 200 with the cleared row.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { unlinkAccount, TelegramApiError, TelegramConfigError } from '@/lib/telegram-publisher'

export async function DELETE(_request: NextRequest) {
  if (process.env.TELEGRAM_ACCOUNT_MODE_ENABLED !== '1') {
    return NextResponse.json({ error: 'Account mode is not enabled' }, { status: 503 })
  }
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const existing = await prisma.telegramSubscription.findUnique({
    where: { workspaceId: ws.workspaceId },
  })
  if (!existing) {
    // Nothing to unlink — still 200 so the UI's optimistic clear is happy.
    return NextResponse.json({ subscription: null })
  }
  if (existing.mode !== 'account') {
    return NextResponse.json(
      { error: 'Workspace is not in account mode' },
      { status: 409 },
    )
  }

  try {
    await unlinkAccount()
  } catch (err) {
    if (err instanceof TelegramConfigError) {
      return NextResponse.json({ error: 'Sigcore not configured' }, { status: 503 })
    }
    if (err instanceof TelegramApiError) {
      // Don't gate the local clear on Sigcore — if Sigcore already wiped its
      // session, the second call may 404, and we still want HF to reflect
      // "not linked" so the user can recover.
      console.warn('[telegram account DELETE] sigcore returned', err.status, err.message)
    } else {
      console.error('[telegram account DELETE] unexpected', err)
    }
  }

  const updated = await prisma.telegramSubscription.update({
    where: { workspaceId: ws.workspaceId },
    data: {
      status: 'retired',
      linkStatus: 'revoked',
      tgUserId: null,
      tgUsername: null,
      linkAccountId: null,
      lastSyncedAt: new Date(),
    },
  })

  return NextResponse.json({
    subscription: {
      status: updated.status,
      mode: updated.mode,
      tgUserId: updated.tgUserId,
      tgUsername: updated.tgUsername,
      linkAccountId: updated.linkAccountId,
      linkStatus: updated.linkStatus,
      lastSyncedAt: updated.lastSyncedAt,
    },
  })
}
