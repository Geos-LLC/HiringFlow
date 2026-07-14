import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendWorkspaceInviteEmail } from '@/lib/workspace-invite'
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

// Invite a new team member (creates user if needed + membership + emails invite)
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const { email, name, role } = await request.json()
  if (!email || typeof email !== 'string') {
    return NextResponse.json({ error: 'Email required' }, { status: 400 })
  }
  const normalizedEmail = email.toLowerCase().trim()

  // Check if user already exists
  let user = await prisma.user.findUnique({ where: { email: normalizedEmail } })
  const isNewUser = !user

  if (!user) {
    // Create user with a random password. The invite email carries a
    // PasswordResetToken so they can set their own on first visit.
    const tempPassword = nanoid(24)
    const passwordHash = await bcrypt.hash(tempPassword, 12)
    user = await prisma.user.create({
      data: { email: normalizedEmail, passwordHash, name: name || null },
    })
  }

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

  const invite = await sendWorkspaceInviteEmail({
    workspaceId: ws.workspaceId,
    invitedUserId: user.id,
    invitedEmail: normalizedEmail,
    invitedRole: role || 'member',
    inviterUserId: ws.userId,
    // New users need a set-password link. Existing users already have a
    // working password, so a plain "you've been added" heads-up is enough.
    includeSetPasswordLink: isNewUser,
  }).catch((err) => {
    // Don't fail the API call — the membership is created, admin can resend
    // the invite. Log so we can see it in Grafana.
    console.error('[workspace/members] invite email failed for', normalizedEmail, ':', (err as Error).message)
    return { sent: false, error: (err as Error).message, setPasswordUrl: null }
  })

  return NextResponse.json({
    success: true,
    email: user.email,
    invitedAsNewUser: isNewUser,
    inviteSent: invite.sent,
  })
}
