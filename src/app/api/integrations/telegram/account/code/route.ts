/**
 * POST /api/integrations/telegram/account/code
 *
 * Step 2 of the account-link wizard. Recruiter submits the SMS code that
 * Telegram sent in response to /account/start. Sigcore verifies the code;
 * if the account has 2FA enabled, nextStep === 'password' and the wizard
 * proceeds to step 3. Otherwise nextStep === 'linked' and the GramJS session
 * is established.
 *
 * Body: { code: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { submitAccountCode, TelegramApiError, TelegramConfigError } from '@/lib/telegram-publisher'

export async function POST(request: NextRequest) {
  if (process.env.TELEGRAM_ACCOUNT_MODE_ENABLED !== '1') {
    return NextResponse.json({ error: 'Account mode is not enabled' }, { status: 503 })
  }
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = (await request.json().catch(() => ({}))) as { code?: string }
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!code) {
    return NextResponse.json({ error: 'code is required' }, { status: 400 })
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
  // Don't reject if linkStatus === 'password_required' — recruiter may have
  // bounced back to the code step after a typo. Sigcore is the source of
  // truth and will 4xx if the code is no longer valid.

  let result
  try {
    result = await submitAccountCode({ code })
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
    console.error('[telegram account/code] unexpected', err)
    return NextResponse.json({ error: 'code submit failed' }, { status: 500 })
  }

  const linkStatus = result.nextStep === 'linked' ? 'linked' : 'password_required'
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
