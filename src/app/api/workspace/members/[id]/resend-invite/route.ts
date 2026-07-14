/**
 * POST /api/workspace/members/[id]/resend-invite
 *
 * Re-issue the workspace invite email for an existing member. Used when the
 * first invite was lost (mail delivery failure, spam filter, wrong address
 * fixed after the fact, or the token expired past its 7-day TTL).
 *
 * Always mints a fresh PasswordResetToken so the recipient can set/reset
 * their password from the invite link — cheap to include even for existing
 * users, and covers the "existing user forgot their password" case in one
 * click.
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendWorkspaceInviteEmail } from '@/lib/workspace-invite'

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const member = await prisma.workspaceMember.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: {
      id: true,
      role: true,
      user: { select: { id: true, email: true } },
    },
  })
  if (!member || !member.user?.email) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const result = await sendWorkspaceInviteEmail({
    workspaceId: ws.workspaceId,
    invitedUserId: member.user.id,
    invitedEmail: member.user.email,
    invitedRole: member.role,
    inviterUserId: ws.userId,
    includeSetPasswordLink: true,
  })

  if (!result.sent) {
    return NextResponse.json({ error: 'email_failed', message: result.error || 'Failed to send' }, { status: 502 })
  }
  return NextResponse.json({ success: true, email: member.user.email })
}
