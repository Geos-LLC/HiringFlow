/**
 * POST /api/integrations/telegram/channels/[id]/verify
 *
 * Re-verify a previously added channel. Used by the "Re-verify" button when
 * a recruiter has just fixed bot permissions on the Telegram side.
 *
 * Body (optional):
 *   { probe?: boolean }   // pass true to bypass Sigcore's 1h verify cache
 *                         // (rate-limit expensive — only on user demand)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { verifyChat, TelegramApiError, TelegramConfigError } from '@/lib/telegram-publisher'
import { deriveVerifyStatus } from '@/lib/telegram-channels'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const channel = await prisma.telegramChannel.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
  })
  if (!channel) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = (await request.json().catch(() => ({}))) as { probe?: boolean }

  try {
    const verdict = await verifyChat({ chatRef: channel.chatRef, probe: body.probe === true })
    const updated = await prisma.telegramChannel.update({
      where: { id: channel.id },
      data: {
        verifyStatus: deriveVerifyStatus(verdict),
        verifyVerdict: verdict as any,
        verifiedAt: new Date(),
        lastVerifyError: null,
      },
    })
    return NextResponse.json({ channel: updated })
  } catch (err) {
    if (err instanceof TelegramConfigError) {
      return NextResponse.json({ error: 'Sigcore not configured' }, { status: 503 })
    }
    if (err instanceof TelegramApiError) {
      const updated = await prisma.telegramChannel.update({
        where: { id: channel.id },
        data: { verifyStatus: 'blocked', lastVerifyError: err.message },
      })
      return NextResponse.json({ channel: updated, verifyError: err.message }, { status: 502 })
    }
    throw err
  }
}
