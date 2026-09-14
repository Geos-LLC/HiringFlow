/**
 * PATCH|DELETE /api/ads/[id]/placements/[placementId]
 *
 * Update or remove a single placement row. Workspace-scoped.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; placementId: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const existing = await prisma.adPlacement.findFirst({
    where: { id: params.placementId, adId: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!existing) return NextResponse.json({ error: 'Placement not found' }, { status: 404 })

  const body = await req.json().catch(() => null) as {
    source?: string; url?: string | null; postedAt?: string; note?: string | null
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const data: Record<string, unknown> = {}
  if (typeof body.source === 'string') data.source = body.source.trim().toLowerCase()
  if ('url' in body) data.url = body.url?.trim() || null
  if ('note' in body) data.note = body.note?.trim() || null
  if (typeof body.postedAt === 'string') {
    const d = new Date(body.postedAt)
    if (Number.isNaN(d.getTime())) return NextResponse.json({ error: 'invalid postedAt' }, { status: 400 })
    data.postedAt = d
  }

  const placement = await prisma.adPlacement.update({
    where: { id: params.placementId },
    data,
  })
  return NextResponse.json({ placement })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; placementId: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const existing = await prisma.adPlacement.findFirst({
    where: { id: params.placementId, adId: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!existing) return NextResponse.json({ error: 'Placement not found' }, { status: 404 })

  await prisma.adPlacement.delete({ where: { id: params.placementId } })
  return NextResponse.json({ ok: true })
}
