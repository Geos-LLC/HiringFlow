/**
 * GET /api/ads/[id]/telegram-placements
 *
 * List Telegram placements for an ad, newest-first. Used by the per-ad
 * preview to render send history (status pill, channel, sent/failed time,
 * error). Includes the channel chatRef + displayName so the UI doesn't have
 * to do a second round trip.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  // Guard: ad must belong to caller's workspace.
  const ad = await prisma.ad.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!ad) return NextResponse.json({ error: 'Ad not found' }, { status: 404 })

  const placements = await prisma.telegramPlacement.findMany({
    where: { adId: params.id, workspaceId: ws.workspaceId },
    orderBy: { createdAt: 'desc' },
    include: {
      channel: { select: { id: true, chatRef: true, displayName: true } },
    },
  })
  return NextResponse.json({ placements })
}
