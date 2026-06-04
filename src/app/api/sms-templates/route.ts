import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const templates = await prisma.smsTemplate.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { updatedAt: 'desc' } })
  return NextResponse.json(templates)
}

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const { name, body } = await request.json()
  if (!name || !body) return NextResponse.json({ error: 'name, body required' }, { status: 400 })
  try {
    const template = await prisma.smsTemplate.create({
      data: { workspaceId: ws.workspaceId, createdById: ws.userId, name, body },
    })
    return NextResponse.json(template)
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
