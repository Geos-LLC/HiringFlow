import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function POST(request: NextRequest, { params }: { params: { id: string; sectionId: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const training = await prisma.training.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!training) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json()
  const maxOrder = await prisma.trainingContent.aggregate({ where: { sectionId: params.sectionId }, _max: { sortOrder: true } })

  const content = await prisma.trainingContent.create({
    data: {
      sectionId: params.sectionId,
      type: body.type || 'text',
      sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
      videoId: body.videoId || null,
      requiredWatch: body.requiredWatch ?? true,
      autoplayNext: body.autoplayNext ?? false,
      textContent: body.textContent || null,
    },
    include: { video: true },
  })

  return NextResponse.json(content)
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string; sectionId: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const training = await prisma.training.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!training) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json()
  const { contentId, ...data } = body

  const updated = await prisma.trainingContent.update({
    where: { id: contentId },
    data: {
      ...(data.type !== undefined && { type: data.type }),
      ...(data.videoId !== undefined && { videoId: data.videoId }),
      ...(data.requiredWatch !== undefined && { requiredWatch: data.requiredWatch }),
      ...(data.autoplayNext !== undefined && { autoplayNext: data.autoplayNext }),
      ...(data.textContent !== undefined && { textContent: data.textContent }),
      ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
    },
    include: { video: true },
  })

  return NextResponse.json(updated)
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string; sectionId: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const training = await prisma.training.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!training) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { contentId } = await request.json()
  await prisma.trainingContent.delete({ where: { id: contentId } })
  return NextResponse.json({ success: true })
}
