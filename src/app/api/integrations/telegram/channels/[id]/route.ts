/**
 * DELETE /api/integrations/telegram/channels/[id]
 *
 * Remove a channel from the workspace's roster. Rejected if any non-terminal
 * placements still reference it — recruiter must cancel those first so we
 * don't end up with an orphan placement pointing at a deleted channel
 * (TelegramPlacement.channel uses onDelete: Restrict for this reason).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const channel = await prisma.telegramChannel.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!channel) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const blocking = await prisma.telegramPlacement.count({
    where: { channelId: params.id, status: { in: ['queued', 'scheduled'] } },
  })
  if (blocking > 0) {
    return NextResponse.json(
      { error: 'Channel has pending placements — cancel them first', pending: blocking },
      { status: 409 },
    )
  }

  await prisma.telegramChannel.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
