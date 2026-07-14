import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'

// List workspace members. Used by the SchedulingConfig editor and the
// per-meeting host picker on the candidate page.
export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: ws.workspaceId },
    orderBy: { joinedAt: 'asc' },
    select: {
      id: true,
      role: true,
      joinedAt: true,
      user: { select: { id: true, email: true, name: true } },
    },
  })

  return NextResponse.json({ members })
}

// Invite a new team member (creates user if needed + membership)
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const { email, name, role } = await request.json()
  if (!email) return NextResponse.json({ error: 'Email required' }, { status: 400 })

  // Check if user already exists
  let user = await prisma.user.findUnique({ where: { email } })

  if (!user) {
    // Create user with random password (they'll need to reset)
    const tempPassword = nanoid(12)
    const passwordHash = await bcrypt.hash(tempPassword, 12)
    user = await prisma.user.create({
      data: { email, passwordHash, name: name || null },
    })
  }

  // Check if already a member
  const existing = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws.workspaceId } },
  })
  if (existing) return NextResponse.json({ error: 'Already a member' }, { status: 409 })

  await prisma.workspaceMember.create({
    data: {
      userId: user.id,
      workspaceId: ws.workspaceId,
      role: role || 'member',
    },
  })

  return NextResponse.json({ success: true, email: user.email })
}
