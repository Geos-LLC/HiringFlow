/**
 * Detect Google OAuth auth failures (invalid_grant / invalid_client) when
 * making Calendar / Meet / Drive API calls, and notify the workspace owner
 * by email so they can reconnect their integration.
 *
 * Wired into the booking endpoints (and any other code path that catches
 * a Google API error). Without this hook, candidate-facing scheduling
 * silently breaks until the recruiter happens to notice — by then they
 * may have lost candidates.
 *
 * Dedup: at most one email per workspace per 24h. Tracked via
 * `GoogleIntegration.authErrorNotifiedAt`. The most recent error code is
 * recorded in `authErrorCode` so admins can see what's failing even when
 * an email isn't due.
 */

import { prisma } from './prisma'
import { sendEmail } from './email'

const NOTIFY_THROTTLE_MS = 24 * 60 * 60 * 1000

const AUTH_ERROR_PATTERNS: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /invalid_grant/i, code: 'invalid_grant' },
  { pattern: /invalid_client/i, code: 'invalid_client' },
  { pattern: /insufficient.permission/i, code: 'insufficient_permission' },
  { pattern: /token has been expired or revoked/i, code: 'invalid_grant' },
]

function detectAuthErrorCode(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err)
  for (const { pattern, code } of AUTH_ERROR_PATTERNS) {
    if (pattern.test(msg)) return code
  }
  return null
}

/**
 * Inspect an error thrown by a Google API call. If it looks like an auth
 * failure for the workspace's integration, mark the integration as broken
 * and email the workspace owner (throttled to once per 24h).
 *
 * Always non-throwing — never replaces the original error path. Callers
 * still throw / return their own error to the candidate.
 */
export async function recordGoogleAuthError(workspaceId: string, err: unknown): Promise<void> {
  const code = detectAuthErrorCode(err)
  if (!code) return

  const integration = await prisma.googleIntegration.findUnique({
    where: { workspaceId },
    select: {
      id: true,
      googleEmail: true,
      authErrorNotifiedAt: true,
    },
  }).catch(() => null)
  if (!integration) return

  const now = new Date()
  await prisma.googleIntegration.update({
    where: { id: integration.id },
    data: {
      authErrorAt: now,
      authErrorCode: code,
    },
  }).catch((e) => console.error('[auth-notifier] failed to record authError:', e))

  const shouldNotify =
    !integration.authErrorNotifiedAt ||
    now.getTime() - integration.authErrorNotifiedAt.getTime() > NOTIFY_THROTTLE_MS
  if (!shouldNotify) return

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, senderEmail: true, senderName: true },
  }).catch(() => null)
  if (!workspace?.senderEmail) {
    console.warn(`[auth-notifier] workspace ${workspaceId} has no senderEmail — cannot notify of ${code}`)
    return
  }

  const appUrl =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    'https://www.hirefunnel.app'

  const subject = `Action needed: reconnect your Google account in HireFunnel`
  const reconnectUrl = `${appUrl}/dashboard/integrations`
  const explanation =
    code === 'invalid_grant'
      ? `Google has revoked the refresh token for <strong>${escapeHtml(integration.googleEmail)}</strong>. This usually happens when the OAuth consent screen in Google Cloud is still in "Testing" mode (Google rotates refresh tokens for personal Gmail every 7 days in that mode) or when a user manually revokes access from their Google account.`
      : code === 'invalid_client'
      ? `Google rejected our app's OAuth credentials. The Google Cloud client secret used by this workspace is out of sync with what HireFunnel currently has configured.`
      : code === 'insufficient_permission'
      ? `Google says we don't have permission to access the connected calendar. The integration's scopes may have been narrowed since it was set up.`
      : `Google returned <code>${escapeHtml(code)}</code> on the last call. The integration needs attention.`

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1f2937; margin-top: 0;">Your Google integration needs attention</h2>
      <p style="color: #374151;">Hi ${escapeHtml(workspace.senderName || workspace.name)},</p>
      <p style="color: #374151;">Candidate-facing scheduling for <strong>${escapeHtml(workspace.name)}</strong> is currently failing. Candidates who click your interview booking links will see an error and may not be able to book.</p>
      <p style="color: #374151;">${explanation}</p>
      <p style="margin: 24px 0;">
        <a href="${reconnectUrl}"
           style="background:#FF9500;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">
          Reconnect Google
        </a>
      </p>
      <p style="color: #6b7280; font-size: 13px;">After reconnecting, candidates will be able to book interviews again immediately. We'll send another reminder if the issue isn't resolved in 24 hours.</p>
      <p style="color: #9ca3af; font-size: 12px; margin-top: 32px;">— HireFunnel</p>
    </div>
  `.trim()
  const text = `Your Google integration for ${workspace.name} is failing.\n\n${stripHtml(explanation)}\n\nReconnect at: ${reconnectUrl}\n\nCandidate-facing scheduling will continue to break until you reconnect.\n\n— HireFunnel`

  const result = await sendEmail({
    to: workspace.senderEmail,
    subject,
    html,
    text,
  })

  if (result.success) {
    await prisma.googleIntegration.update({
      where: { id: integration.id },
      data: { authErrorNotifiedAt: now },
    }).catch((e) => console.error('[auth-notifier] failed to record notifiedAt:', e))
    console.log(`[auth-notifier] notified ${workspace.senderEmail} of ${code} for workspace ${workspaceId}`)
  } else {
    console.error('[auth-notifier] failed to send notification email:', result.error)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}
