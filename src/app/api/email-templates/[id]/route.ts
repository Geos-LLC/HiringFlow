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

  const t = await prisma.emailTemplate.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    include: {
      automations: { select: { id: true, name: true } },
      steps: { select: { rule: { select: { id: true, name: true } } } },
    },
  })
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Refuse to delete if anything still references this template. Without
  // this guard the FK constraint would 500; surface a clear 409 with the
  // referencing rule names so the UI can show "still used by … — detach
  // from those rules first".
  const refs = new Map<string, string>()
  for (const r of t.automations) refs.set(r.id, r.name)
  for (const s of t.steps) refs.set(s.rule.id, s.rule.name)
  if (refs.size > 0) {
    return NextResponse.json(
      {
        error: `Template is used by ${refs.size} automation rule${refs.size === 1 ? '' : 's'}`,
        code: 'template_in_use',
        usage: {
          ruleIds: Array.from(refs.keys()),
          ruleNames: Array.from(refs.values()),
        },
      },
      { status: 409 },
    )
  }

  await prisma.emailTemplate.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
