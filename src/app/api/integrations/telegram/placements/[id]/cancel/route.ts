/**
 * POST /api/integrations/telegram/placements/[id]/cancel
 *
 * Cancel a queued/scheduled placement. Calls Sigcore /placements/:id/cancel
 * (which propagates to TelePorter); on 200 we flip our row to 'cancelled'.
 *
 * Sigcore returns 409 if the placement has already been sent or failed —
 * we mirror that as 409 with the current local status so the UI can refresh
 * without surfacing a scary infra error.
 *
 * The `:id` here is the HF TelegramPlacement.id (our row), not Sigcore's
 * placement id — matches the convention of every other route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { cancelPlacement, TelegramApiError, TelegramConfigError } from '@/lib/telegram-publisher'

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const placement = await prisma.telegramPlacement.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
  })
  if (!placement) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (placement.status === 'cancelled') {
    return NextResponse.json({ placement }, { status: 200 })
  }
  if (placement.status === 'sent' || placement.status === 'failed') {
    return NextResponse.json(
      { error: 'Placement already terminal', status: placement.status },
      { status: 409 },
    )
  }
  if (!placement.sigcorePlacementId) {
    // Pre-dispatch failure — Sigcore never registered the placement so we
    // own the row entirely. Mark cancelled locally and return.
    const updated = await prisma.telegramPlacement.update({
      where: { id: placement.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    })
    return NextResponse.json({ placement: updated })
  }

  try {
    await cancelPlacement(placement.sigcorePlacementId)
  } catch (err) {
    if (err instanceof TelegramConfigError) {
      return NextResponse.json({ error: 'Sigcore not configured' }, { status: 503 })
    }
    if (err instanceof TelegramApiError && err.status === 409) {
      // Sigcore says it's already sent/failed but our row hasn't caught up —
      // the callback is on its way. Return current local status; UI can poll.
      return NextResponse.json(
        { error: 'Placement already terminal on Sigcore side', status: placement.status },
        { status: 409 },
      )
    }
    if (err instanceof TelegramApiError) {
      return NextResponse.json({ error: err.message, providerStatus: err.status }, { status: 502 })
    }
    throw err
  }

  const updated = await prisma.telegramPlacement.update({
    where: { id: placement.id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  })
  return NextResponse.json({ placement: updated })
}
