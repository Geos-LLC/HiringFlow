import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const templates = await prisma.emailTemplate.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { updatedAt: 'desc' } })
  return NextResponse.json(templates)
}

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const { name, subject, bodyHtml, bodyText } = await request.json()
  if (!name || !subject || !bodyHtml) return NextResponse.json({ error: 'name, subject, bodyHtml required' }, { status: 400 })
  try {
    const template = await prisma.emailTemplate.create({
      data: { workspaceId: ws.workspaceId, createdById: ws.userId, name, subject, bodyHtml, bodyText: bodyText || null },
    })
    return NextResponse.json(template)
  } catch (err) {
    // P2002 = unique constraint violation. We have a (workspaceId, name)
    // unique index — surface it as a 409 with a stable code so the UI can
    // detect it and prompt for a different name.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json(
        { error: 'A template with this name already exists', code: 'duplicate_name' },
        { status: 409 },
      )
    }
    throw err
  }
}
