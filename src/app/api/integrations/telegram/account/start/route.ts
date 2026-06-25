/**
 * POST /api/integrations/telegram/account/start
 *
 * Step 1 of the account-link wizard. Recruiter submits a phone number;
 * Sigcore → TelePorter → MTProto requests the SMS code from Telegram and
 * returns the next step.
 *
 * Body: { phoneNumber: string }   // E.164, with leading '+'
 *
 * Response:
 *   {
 *     subscription: { ...row },
 *     nextStep: 'code' | 'password' | 'linked',
 *     message?: string            // hint to render (e.g. "Code sent to +1...4321")
 *   }
 *
 * Guard: the workspace must already be in account-mode (created via
 * /subscribe?mode=account). Otherwise we 409 so the UI can route the user
 * through the toggle first.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { startAccountLink, TelegramApiError, TelegramConfigError } from '@/lib/telegram-publisher'

export async function POST(request: NextRequest) {
  if (process.env.TELEGRAM_ACCOUNT_MODE_ENABLED !== '1') {
    return NextResponse.json({ error: 'Account mode is not enabled' }, { status: 503 })
  }
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = (await request.json().catch(() => ({}))) as { phoneNumber?: string }
  const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : ''
  if (!phoneNumber) {
    return NextResponse.json({ error: 'phoneNumber is required' }, { status: 400 })
  }

  const existing = await prisma.telegramSubscription.findUnique({
    where: { workspaceId: ws.workspaceId },
  })
  if (!existing || existing.mode !== 'account') {
    return NextResponse.json(
      { error: 'Workspace is not in account mode — call /subscribe?mode=account first' },
      { status: 409 },
    )
  }

  let result
  try {
    result = await startAccountLink({ phoneNumber })
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
    console.error('[telegram account/start] unexpected', err)
    return NextResponse.json({ error: 'start failed' }, { status: 500 })
  }

  // Persist the Sigcore-side accountId so subsequent step calls don't need
  // to round-trip the wizard state through the client. linkStatus mirrors
  // Sigcore's nextStep so the UI can resume the wizard on reload.
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
      // If Sigcore short-circuits to 'linked' (rare — only if a prior session
      // is still valid), surface identity immediately. The webhook will
      // confirm shortly after.
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
