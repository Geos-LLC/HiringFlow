/**
 * POST /api/integrations/telegram/account/password
 *
 * Step 3 of the account-link wizard. Only invoked when /account/code
 * returned nextStep === 'password' (Telegram account has 2FA enabled).
 * Submits the cloud password to Sigcore; on success the GramJS session
 * is established and `account.linked` fires via webhook.
 *
 * Body: { password: string }
 *
 * Security: the password is forwarded to Sigcore over the same SIGCORE_API_KEY
 * channel and never persisted in HF.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { submitAccountPassword, TelegramApiError, TelegramConfigError } from '@/lib/telegram-publisher'

export async function POST(request: NextRequest) {
  if (process.env.TELEGRAM_ACCOUNT_MODE_ENABLED !== '1') {
    return NextResponse.json({ error: 'Account mode is not enabled' }, { status: 503 })
  }
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = (await request.json().catch(() => ({}))) as { password?: string }
  const password = typeof body.password === 'string' ? body.password : ''
  if (!password) {
    return NextResponse.json({ error: 'password is required' }, { status: 400 })
  }

  const existing = await prisma.telegramSubscription.findUnique({
    where: { workspaceId: ws.workspaceId },
  })
  if (!existing || existing.mode !== 'account') {
    return NextResponse.json(
      { error: 'Workspace is not in account mode' },
      { status: 409 },
    )
  }

  let result
  try {
    result = await submitAccountPassword({ password })
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
    console.error('[telegram account/password] unexpected', err)
    return NextResponse.json({ error: 'password submit failed' }, { status: 500 })
  }

  // The password step's only valid terminal is 'linked'. If Sigcore returns
  // anything else, surface it but don't crash.
  const linkStatus =
    result.nextStep === 'linked'
      ? 'linked'
      : result.nextStep === 'password'
      ? 'password_required'
      : 'code_requested'

  const updated = await prisma.telegramSubscription.update({
    where: { workspaceId: ws.workspaceId },
    data: {
      linkAccountId: result.linkAccountId ?? existing.linkAccountId,
      linkStatus,
      tgUserId: result.tgUserId ?? existing.tgUserId,
      tgUsername: result.tgUsername ?? existing.tgUsername,
      status: result.nextStep === 'linked' ? 'ready' : 'provisioning',
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
    nextStep: result.nextStep,
    message: result.message,
  })
}
