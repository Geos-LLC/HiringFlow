/**
 * Shared "send a workspace invite email" helper.
 *
 * Used by both the initial invite path (`POST /api/workspace/members`) and
 * the "resend invite" action (`POST /api/workspace/members/[id]/resend-invite`).
 * Encapsulates: PasswordResetToken minting for new users, workspace-branded
 * sender selection, and the invite email body.
 */

import { randomBytes, createHash } from 'crypto'
import { prisma } from './prisma'
import { sendEmail } from './email'

const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://www.hirefunnel.app'
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface SendInviteOpts {
  workspaceId: string
  invitedUserId: string
  invitedEmail: string
  invitedRole: string
  inviterUserId: string
  /**
   * When true, mint a fresh PasswordResetToken and land the recipient on
   * /reset-password?token=... so they can set their password. Use for brand-
   * new users AND for resend-invite when the original token has expired or
   * you want to reissue.
   *
   * When false, the email uses a plain /login CTA (for existing users who
   * already have a working password).
   */
  includeSetPasswordLink: boolean
}

export interface SendInviteResult {
  sent: boolean
  error?: string
  setPasswordUrl: string | null
}

export async function sendWorkspaceInviteEmail(opts: SendInviteOpts): Promise<SendInviteResult> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: {
      name: true,
      senderName: true,
      senderEmail: true,
      senderDomain: true,
      senderDomainValidatedAt: true,
      senderVerifiedAt: true,
    },
  })
  if (!workspace) return { sent: false, error: 'workspace_not_found', setPasswordUrl: null }

  const inviter = await prisma.user.findUnique({
    where: { id: opts.inviterUserId },
    select: { name: true, email: true },
  })

  const workspaceName = workspace.name || 'HireFunnel'
  const inviterLabel = inviter?.name || inviter?.email || 'Your teammate'

  let setPasswordUrl: string | null = null
  if (opts.includeSetPasswordLink) {
    // Invalidate any previous unused invite/reset tokens for this user so a
    // resend-invite always leaves exactly one live token in play.
    await prisma.passwordResetToken.updateMany({
      where: { userId: opts.invitedUserId, usedAt: null },
      data: { usedAt: new Date() },
    })
    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS)
    await prisma.passwordResetToken.create({
      data: { userId: opts.invitedUserId, tokenHash, expiresAt },
    })
    setPasswordUrl = `${APP_URL}/reset-password?token=${rawToken}`
  }
  const loginUrl = `${APP_URL}/login`

  const domainOk = !!(
    workspace.senderDomainValidatedAt &&
    workspace.senderDomain &&
    workspace.senderEmail &&
    workspace.senderEmail.toLowerCase().endsWith('@' + workspace.senderDomain.toLowerCase())
  )
  const singleOk = !!workspace.senderVerifiedAt
  const from = (domainOk || singleOk) && workspace.senderName && workspace.senderEmail
    ? { email: workspace.senderEmail, name: workspace.senderName }
    : null

  const subject = `${inviterLabel} invited you to ${workspaceName} on HireFunnel`
  const cta = setPasswordUrl
    ? `<a href="${setPasswordUrl}" style="background:#FF9500;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">Set your password &amp; sign in</a>`
    : `<a href="${loginUrl}" style="background:#FF9500;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">Sign in to HireFunnel</a>`
  const linkLine = setPasswordUrl
    ? `If the button doesn't work, paste this into your browser:<br/>${setPasswordUrl}`
    : `If the button doesn't work, paste this into your browser:<br/>${loginUrl}`
  const linkExpiryNote = setPasswordUrl
    ? `<p style="color:#8A8A8C;font-size:13px;">This invite link is valid for 7 days.</p>`
    : ''

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #262626;">
      <h2 style="margin:0 0 8px 0;">You've been added to ${escapeHtml(workspaceName)}</h2>
      <p style="color:#59595A;margin:0 0 16px 0;">
        ${escapeHtml(inviterLabel)} added you as a <strong>${escapeHtml(opts.invitedRole)}</strong> on ${escapeHtml(workspaceName)}'s HireFunnel workspace. You can now view candidates, host interviews, and receive meeting notifications for this team.
      </p>
      <p style="margin: 24px 0;">${cta}</p>
      ${linkExpiryNote}
      <p style="color:#8A8A8C;font-size:12px;word-break:break-all;">${linkLine}</p>
    </div>
  `.trim()

  const text = [
    `${inviterLabel} added you to ${workspaceName} on HireFunnel as a ${opts.invitedRole}.`,
    '',
    setPasswordUrl
      ? `Set your password and sign in: ${setPasswordUrl}\n(This invite link is valid for 7 days.)`
      : `Sign in: ${loginUrl}`,
  ].join('\n')

  const result = await sendEmail({
    to: opts.invitedEmail,
    subject,
    html,
    text,
    from,
    workspaceId: opts.workspaceId,
  })

  if (!result.success) {
    return { sent: false, error: result.error, setPasswordUrl }
  }
  return { sent: true, setPasswordUrl }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
