import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const t = await prisma.smsTemplate.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await request.json()
  try {
    const updated = await prisma.smsTemplate.update({
      where: { id: params.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.body !== undefined && { body: body.body }),
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
  const t = await prisma.smsTemplate.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Detach any steps that referenced this template — they'll fall back to
  // step.smsBody (which holds a cached copy of the last rendered body).
  await prisma.automationStep.updateMany({
    where: { smsTemplateId: params.id },
    data: { smsTemplateId: null },
  })
  await prisma.smsTemplate.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
