import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getVideoUrl } from '@/lib/storage'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  try {
    const training = await prisma.training.findFirst({
      where: { id: params.id, workspaceId: ws.workspaceId },
      include: {
        sections: {
          orderBy: { sortOrder: 'asc' },
          include: {
            contents: { orderBy: { sortOrder: 'asc' }, include: { video: true } },
            quiz: { include: { questions: { orderBy: { sortOrder: 'asc' } } } },
          },
        },
      },
    })

    if (!training) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Add video URLs
    const withUrls = {
      ...training,
      sections: training.sections.map((section) => ({
        ...section,
        contents: section.contents.map((content) => ({
          ...content,
          video: content.video ? { ...content.video, url: getVideoUrl(content.video.storageKey) } : null,
        })),
      })),
    }

    return NextResponse.json(withUrls)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    console.error('[api/trainings/[id] GET] failed', { trainingId: params.id, workspaceId: ws.workspaceId, error: message, stack })
    return NextResponse.json({ error: 'Failed to load training', detail: message }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const training = await prisma.training.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!training) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json()
  const { title, description, coverImage, timeLimit, pricing, passingGrade, isPublished, branding, accessMode, sectionOrder } = body

  const updated = await prisma.training.update({
    where: { id: params.id },
    data: {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(coverImage !== undefined && { coverImage }),
      ...(timeLimit !== undefined && { timeLimit }),
      ...(pricing !== undefined && { pricing }),
      ...(passingGrade !== undefined && { passingGrade }),
      ...(isPublished !== undefined && { isPublished }),
      ...(branding !== undefined && { branding }),
      ...(accessMode !== undefined && { accessMode }),
      ...(sectionOrder !== undefined && { sectionOrder: sectionOrder === 'any' ? 'any' : 'sequential' }),
    },
  })

  return NextResponse.json(updated)
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const training = await prisma.training.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!training) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await prisma.training.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
