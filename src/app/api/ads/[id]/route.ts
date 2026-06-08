import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const ad = await prisma.ad.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    include: { flow: { select: { id: true, name: true, slug: true, isPublished: true } } },
  })
  if (!ad) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(ad)
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const ad = await prisma.ad.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!ad) return NextResponse.json({ error: 'Ad not found' }, { status: 404 })

  const body = await request.json()
  const { name, source, campaign, targetPosition, flowId, isActive, imageUrl, placementUrl, templateId, headline, bodyText, requirements, benefits, callToAction, notes } = body

  const updated = await prisma.ad.update({
    where: { id: params.id },
    data: {
      ...(name !== undefined && { name }),
      ...(source !== undefined && { source }),
      ...(campaign !== undefined && { campaign: campaign || null }),
      ...(targetPosition !== undefined && { targetPosition: typeof targetPosition === 'string' && targetPosition.trim() ? targetPosition.trim() : null }),
      ...(flowId !== undefined && { flowId }),
      ...(isActive !== undefined && { isActive }),
      ...(imageUrl !== undefined && { imageUrl: imageUrl || null }),
      ...(placementUrl !== undefined && { placementUrl: placementUrl || null }),
      ...(templateId !== undefined && { templateId: templateId || null }),
      ...(headline !== undefined && { headline: headline || null }),
      ...(bodyText !== undefined && { bodyText: bodyText || null }),
      ...(requirements !== undefined && { requirements: requirements || null }),
      ...(benefits !== undefined && { benefits: benefits || null }),
      ...(callToAction !== undefined && { callToAction: callToAction || null }),
      ...(notes !== undefined && { notes: notes || null }),
    },
    include: { flow: { select: { id: true, name: true, slug: true } } },
  })

  return NextResponse.json(updated)
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const ad = await prisma.ad.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!ad) return NextResponse.json({ error: 'Ad not found' }, { status: 404 })

  await prisma.ad.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
