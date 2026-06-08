import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { nanoid } from 'nanoid'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const ads = await prisma.ad.findMany({
    where: { workspaceId: ws.workspaceId },
    orderBy: { createdAt: 'desc' },
    include: {
      flow: { select: { id: true, name: true, slug: true, isPublished: true } },
      _count: { select: { sessions: true } },
    },
  })

  return NextResponse.json(ads)
}

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = await request.json()
  const { name, source, campaign, targetPosition, flowId, imageUrl, placementUrl, templateId, headline, bodyText, requirements, benefits, callToAction, notes } = body

  if (!name || !source || !flowId) {
    return NextResponse.json({ error: 'name, source, and flowId are required' }, { status: 400 })
  }

  // Verify flow belongs to workspace
  const flow = await prisma.flow.findFirst({ where: { id: flowId, workspaceId: ws.workspaceId } })
  if (!flow) return NextResponse.json({ error: 'Flow not found' }, { status: 404 })

  const ad = await prisma.ad.create({
    data: {
      workspaceId: ws.workspaceId,
      createdById: ws.userId,
      name,
      source,
      campaign: campaign || null,
      targetPosition: typeof targetPosition === 'string' && targetPosition.trim() ? targetPosition.trim() : null,
      flowId,
      slug: nanoid(10),
      imageUrl: imageUrl || null,
      placementUrl: placementUrl || null,
      templateId: templateId || null,
      headline: headline || null,
      bodyText: bodyText || null,
      requirements: requirements || null,
      benefits: benefits || null,
      callToAction: callToAction || null,
      notes: notes || null,
    },
    include: { flow: { select: { id: true, name: true, slug: true } } },
  })

  return NextResponse.json(ad)
}
