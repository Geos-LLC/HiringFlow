/**
 * GET|POST /api/ads/[id]/placements
 *
 * Recruiter-recorded manual placements for an ad. One row per posting
 * event; an ad can have many (multi-board and re-posts).
 *   GET  → list newest-first
 *   POST → create { source, url?, postedAt, note? }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

async function assertAdInWorkspace(adId: string, workspaceId: string) {
  return prisma.ad.findFirst({ where: { id: adId, workspaceId }, select: { id: true } })
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const ad = await assertAdInWorkspace(params.id, ws.workspaceId)
  if (!ad) return NextResponse.json({ error: 'Ad not found' }, { status: 404 })

  const placements = await prisma.adPlacement.findMany({
    where: { adId: params.id, workspaceId: ws.workspaceId },
    orderBy: { postedAt: 'desc' },
  })
  return NextResponse.json({ placements })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const ad = await assertAdInWorkspace(params.id, ws.workspaceId)
  if (!ad) return NextResponse.json({ error: 'Ad not found' }, { status: 404 })

  const body = await req.json().catch(() => null) as {
    source?: string; url?: string | null; postedAt?: string; note?: string | null
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const source = (body.source || '').trim().toLowerCase()
  if (!source) return NextResponse.json({ error: 'source required' }, { status: 400 })

  const postedAt = body.postedAt ? new Date(body.postedAt) : new Date()
  if (Number.isNaN(postedAt.getTime())) {
    return NextResponse.json({ error: 'invalid postedAt' }, { status: 400 })
  }

  const placement = await prisma.adPlacement.create({
    data: {
      adId: params.id,
      workspaceId: ws.workspaceId,
      source,
      url: body.url?.trim() || null,
      postedAt,
      note: body.note?.trim() || null,
      createdById: ws.userId,
    },
  })
  return NextResponse.json({ placement }, { status: 201 })
}
