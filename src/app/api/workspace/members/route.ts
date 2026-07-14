import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, createHash } from 'crypto'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/email'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'

const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://www.hirefunnel.app'

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
    // Create user with a random password. They can never guess this — the
    // invite email carries a set-password token so they land on the reset
    // page with a known-good session-scoped token.
    const tempPassword = nanoid(24)
    const passwordHash = await bcrypt.hash(tempPassword, 12)
    user = await prisma.user.create({
      data: { email: normalizedEmail, passwordHash, name: name || null },
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

  // Send the invite email. For a brand-new user we mint a PasswordResetToken
  // (7-day TTL — invite links live longer than the 1h forgot-password token)
  // so they land on /reset-password?token=... and can set their password on
  // first visit. For an existing user the email is a heads-up + login link.
  const workspace = await prisma.workspace.findUnique({
    where: { id: ws.workspaceId },
    select: { name: true, senderName: true, senderEmail: true, senderDomain: true, senderDomainValidatedAt: true, senderVerifiedAt: true },
  })
  const workspaceName = workspace?.name || 'HireFunnel'

  // Inviter identity, for the email body ("Alice invited you to Acme").
  const inviter = await prisma.user.findUnique({
    where: { id: ws.userId },
    select: { name: true, email: true },
  })
  const inviterLabel = inviter?.name || inviter?.email || 'Your teammate'

  let setPasswordUrl: string | null = null
  if (isNewUser) {
    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    })
    setPasswordUrl = `${APP_URL}/reset-password?token=${rawToken}`
  }
  const loginUrl = `${APP_URL}/login`

  // Match executeStep from-selection so the invite goes from the workspace's
  // branded sender when it's actually authorized; otherwise SendGrid falls
  // through to the platform default in sendEmail().
  const domainOk = !!(workspace?.senderDomainValidatedAt && workspace.senderDomain && workspace?.senderEmail && workspace.senderEmail.toLowerCase().endsWith('@' + workspace.senderDomain.toLowerCase()))
  const singleOk = !!workspace?.senderVerifiedAt
  const from = (domainOk || singleOk) && workspace?.senderName && workspace?.senderEmail
    ? { email: workspace.senderEmail, name: workspace.senderName }
    : null

  const subject = `${inviterLabel} invited you to ${workspaceName} on HireFunnel`
  const cta = isNewUser
    ? `<a href="${setPasswordUrl}" style="background:#FF9500;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">Set your password &amp; sign in</a>`
    : `<a href="${loginUrl}" style="background:#FF9500;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">Sign in to HireFunnel</a>`
  const linkLine = isNewUser
    ? `If the button doesn't work, paste this into your browser:<br/>${setPasswordUrl}`
    : `If the button doesn't work, paste this into your browser:<br/>${loginUrl}`
  const linkExpiryNote = isNewUser
    ? `<p style="color:#8A8A8C;font-size:13px;">This invite link is valid for 7 days.</p>`
    : ''

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #262626;">
      <h2 style="margin:0 0 8px 0;">You've been added to ${escapeHtml(workspaceName)}</h2>
      <p style="color:#59595A;margin:0 0 16px 0;">
        ${escapeHtml(inviterLabel)} added you as a <strong>${escapeHtml(role || 'member')}</strong> on ${escapeHtml(workspaceName)}'s HireFunnel workspace. You can now view candidates, host interviews, and receive meeting notifications for this team.
      </p>
      <p style="margin: 24px 0;">${cta}</p>
      ${linkExpiryNote}
      <p style="color:#8A8A8C;font-size:12px;word-break:break-all;">${linkLine}</p>
    </div>
  `.trim()

  const text = [
    `${inviterLabel} added you to ${workspaceName} on HireFunnel as a ${role || 'member'}.`,
    '',
    isNewUser
      ? `Set your password and sign in: ${setPasswordUrl}\n(This invite link is valid for 7 days.)`
      : `Sign in: ${loginUrl}`,
  ].join('\n')

  await sendEmail({
    to: normalizedEmail,
    subject,
    html,
    text,
    from,
    workspaceId: ws.workspaceId,
  }).catch((err) => {
    // Don't fail the API call — the membership is created, admin can resend
    // the invite. Log so we can see it in Grafana.
    console.error('[workspace/members] invite email failed for', normalizedEmail, ':', (err as Error).message)
  })

  return NextResponse.json({
    success: true,
    email: user.email,
    invitedAsNewUser: isNewUser,
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
