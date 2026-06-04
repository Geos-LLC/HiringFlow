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

  const t = await prisma.smsTemplate.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    include: { steps: { select: { rule: { select: { id: true, name: true } } } } },
  })
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Guard: refuse if any rule still references this template. The legacy
  // auto-detach behaviour ("any rule still using it will fall back to its
  // inline SMS body") was confusing — a recruiter would delete the template
  // and not realise the SMS body had silently been frozen at whatever cached
  // string was on the step row. Forcing them to detach explicitly first
  // makes the consequence visible.
  const refs = new Map<string, string>()
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

  await prisma.smsTemplate.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
