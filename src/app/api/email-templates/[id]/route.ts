import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const t = await prisma.emailTemplate.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await request.json()
  try {
    const updated = await prisma.emailTemplate.update({
      where: { id: params.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.subject !== undefined && { subject: body.subject }),
        ...(body.bodyHtml !== undefined && { bodyHtml: body.bodyHtml }),
        ...(body.bodyText !== undefined && { bodyText: body.bodyText }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
      },
    })
    return NextResponse.json(updated)
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json(
        { error: 'A template with this name already exists', code: 'duplicate_name' },
        { status: 409 },
      )
    }
    throw err
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const t = await prisma.emailTemplate.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await prisma.emailTemplate.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
