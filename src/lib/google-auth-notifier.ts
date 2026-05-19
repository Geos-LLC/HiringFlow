/**
 * Tenant-facing notifications when a candidate hits a non-self-fixable
 * booking failure. The workspace owner / business email gets an email so
 * they can intervene (reconnect Google, fix scheduling config, etc.).
 *
 * Categories handled (see CATEGORY map below):
 *   oauth_revoked       → Google OAuth refresh token rejected. Owner must
 *                          reconnect from the integrations page.
 *   oauth_client_drift  → GOOGLE_CLIENT_SECRET env out of sync with GCP.
 *                          Owner can't fix; ops must rotate the secret.
 *   integration_down    → Calendar / Meet API call failed for a non-auth
 *                          reason (5xx, quota, transient).
 *   config_broken       → Scheduling link points at a config that doesn't
 *                          exist, isn't active, or has no flow attached.
 *   meeting_missing     → Reschedule / cancel hit no live meeting row.
 *   internal            → Unhandled server error during booking.
 *
 * Dedup: at most one email per workspace per category per 24h. Per-category
 * timestamps live in `Workspace.settings.tenantNotifications` (JSON, no
 * schema change beyond the OAuth columns already on GoogleIntegration).
 * The OAuth-specific columns (`auth_error_at` / `auth_error_code` /
 * `auth_error_notified_at`) are still updated for the two oauth_* cases so
 * the dashboard can surface "integration unhealthy" without joining JSON.
 */

import { prisma } from './prisma'
import { sendEmail } from './email'

const NOTIFY_THROTTLE_MS = 24 * 60 * 60 * 1000

// Error codes that mean the candidate did something wrong — don't bother
// the tenant about these.
const SELF_FIXABLE: ReadonlySet<string> = new Set([
  'slot_unavailable',
  'name_required',
  'invalid_email',
  'slotStartUtc_required',
  'invalid_slot',
  'rate_limited',
  'invalid_window',
])

// Map a code (or raw error) to a high-level category that decides the
// email content and the dedup bucket.
type Category =
  | 'oauth_revoked'
  | 'oauth_client_drift'
  | 'integration_down'
  | 'config_broken'
  | 'meeting_missing'
  | 'internal'

const CODE_CATEGORY: Record<string, Category> = {
  // Config-side
  config_not_found: 'config_broken',
  built_in_disabled: 'config_broken',
  not_built_in: 'config_broken',
  no_flow_available: 'config_broken',
  invalid_token: 'config_broken',
  wrong_purpose: 'config_broken',
  config_mismatch: 'config_broken',
  // Missing rows
  no_meeting_to_cancel: 'meeting_missing',
  no_meeting_to_reschedule: 'meeting_missing',
  no_calendar_event: 'meeting_missing',
  // Integration / Google
  google_not_connected: 'oauth_revoked',
  reconnect_required: 'oauth_revoked',
  free_busy_failed: 'integration_down',
  calendar_patch_failed: 'integration_down',
  // Generic
  internal: 'internal',
}

const AUTH_PATTERNS: Array<{ pattern: RegExp; category: Category; code: string }> = [
  { pattern: /invalid_grant/i, category: 'oauth_revoked', code: 'invalid_grant' },
  { pattern: /token has been expired or revoked/i, category: 'oauth_revoked', code: 'invalid_grant' },
  { pattern: /invalid_client/i, category: 'oauth_client_drift', code: 'invalid_client' },
  { pattern: /insufficient.permission/i, category: 'oauth_revoked', code: 'insufficient_permission' },
]

interface NotifyOpts {
  /** The original error thrown by the underlying call, if any. Used to
   *  detect OAuth-specific subcategories (invalid_grant etc.) that
   *  override the code-based category. */
  err?: unknown
}

/**
 * Notify the workspace owner that a candidate hit a booking failure.
 * Always non-throwing — never replaces the original error path.
 */
export async function notifyTenantOfBookingFailure(
  workspaceId: string,
  code: string,
  opts: NotifyOpts = {},
): Promise<void> {
  if (SELF_FIXABLE.has(code)) return

  // Override category if the underlying error matches an OAuth pattern,
  // even when the code is something generic like calendar_patch_failed.
  let category = CODE_CATEGORY[code] || 'internal'
  let authCode: string | null = null
  if (opts.err) {
    const msg = opts.err instanceof Error ? opts.err.message : String(opts.err)
    for (const { pattern, category: cat, code: c } of AUTH_PATTERNS) {
      if (pattern.test(msg)) {
        category = cat
        authCode = c
        break
      }
    }
  }

  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        name: true,
        senderEmail: true,
        senderName: true,
        settings: true,
      },
    })
    if (!workspace?.senderEmail) {
      console.warn(`[tenant-notifier] workspace ${workspaceId} has no senderEmail — cannot notify (${category})`)
      return
    }

    const settings = (workspace.settings as Record<string, unknown> | null) || {}
    const tenantNotifications = (settings.tenantNotifications as Record<string, string> | undefined) || {}
    const lastIso = tenantNotifications[category]
    if (lastIso) {
      const last = new Date(lastIso).getTime()
      if (!isNaN(last) && Date.now() - last < NOTIFY_THROTTLE_MS) {
        // Already notified for this category in the throttle window. Still
        // record the OAuth-specific marker on GoogleIntegration (if
        // applicable) so the dashboard's "integration unhealthy" surfacing
        // stays current.
        if (authCode) await recordOAuthMarker(workspaceId, authCode)
        return
      }
    }

    const errDetail = opts.err instanceof Error ? opts.err.message : opts.err ? String(opts.err) : null
    const { subject, html, text } = renderEmail({
      category,
      code,
      workspaceName: workspace.name,
      senderName: workspace.senderName,
      errDetail,
    })

    const result = await sendEmail({
      to: workspace.senderEmail,
      subject,
      html,
      text,
    })

    if (result.success) {
      const nextSettings = {
        ...settings,
        tenantNotifications: {
          ...tenantNotifications,
          [category]: new Date().toISOString(),
        },
      }
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { settings: nextSettings },
      }).catch((e) => console.error('[tenant-notifier] failed to record notifiedAt:', e))
      if (authCode) await recordOAuthMarker(workspaceId, authCode)
      console.log(`[tenant-notifier] notified ${workspace.senderEmail} of ${category} (code=${code}) for workspace ${workspaceId}`)
    } else {
      console.error('[tenant-notifier] failed to send notification email:', result.error)
    }
  } catch (err) {
    console.error('[tenant-notifier] unexpected failure:', err)
  }
}

/**
 * Back-compat alias kept so existing call sites in availability/booking/
 * reschedule/cancel routes don't need a sweep. New code should call
 * `notifyTenantOfBookingFailure` directly with an explicit code.
 */
export async function recordGoogleAuthError(workspaceId: string, err: unknown): Promise<void> {
  return notifyTenantOfBookingFailure(workspaceId, 'free_busy_failed', { err })
}

async function recordOAuthMarker(workspaceId: string, code: string): Promise<void> {
  const integration = await prisma.googleIntegration.findUnique({
    where: { workspaceId },
    select: { id: true },
  }).catch(() => null)
  if (!integration) return
  await prisma.googleIntegration.update({
    where: { id: integration.id },
    data: {
      authErrorAt: new Date(),
      authErrorCode: code,
      authErrorNotifiedAt: new Date(),
    },
  }).catch((e) => console.error('[tenant-notifier] failed to record OAuth marker:', e))
}

interface RenderArgs {
  category: Category
  code: string
  workspaceName: string
  senderName: string | null
  errDetail: string | null
}

function renderEmail(args: RenderArgs): { subject: string; html: string; text: string } {
  const appUrl =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    'https://www.hirefunnel.app'

  const greeting = `Hi ${escapeHtml(args.senderName || args.workspaceName)},`

  type Content = { subject: string; intro: string; ctaLabel: string; ctaUrl: string; followup?: string }
  const content: Content = (() => {
    switch (args.category) {
      case 'oauth_revoked':
        return {
          subject: 'Action needed: reconnect your Google account in HireFunnel',
          intro:
            `Candidates trying to book interviews for <strong>${escapeHtml(args.workspaceName)}</strong> are seeing an error. Google has revoked the connection between HireFunnel and your Google account. ` +
            `This is most commonly caused by Google's 7-day refresh-token rotation that applies while your OAuth consent screen is in "Testing" mode (any personal Gmail used as a test user is affected). It can also happen if you manually revoked access from your Google Account permissions page.`,
          ctaLabel: 'Reconnect Google',
          ctaUrl: `${appUrl}/dashboard/integrations`,
          followup:
            'To stop this from recurring, publish the OAuth consent screen in Google Cloud (APIs &amp; Services → OAuth consent screen → "Publish app"). Tokens then last indefinitely.',
        }
      case 'oauth_client_drift':
        return {
          subject: 'HireFunnel ↔ Google credentials need rotation',
          intro:
            `Google rejected HireFunnel's app credentials when serving a candidate booking for <strong>${escapeHtml(args.workspaceName)}</strong>. The Google Cloud client secret HireFunnel currently holds is out of sync with what's live on the OAuth client. This affects every workspace, not just yours.`,
          ctaLabel: 'View integration status',
          ctaUrl: `${appUrl}/dashboard/integrations`,
          followup: 'We have been alerted. Reconnecting your own account will not help here — the platform team needs to rotate the shared client secret.',
        }
      case 'integration_down':
        return {
          subject: 'A candidate just hit a scheduling error',
          intro:
            `A candidate trying to book an interview for <strong>${escapeHtml(args.workspaceName)}</strong> just got a temporary error from Google. Most of the time this clears within a few minutes — if it keeps happening, the integration may need attention.`,
          ctaLabel: 'View integration status',
          ctaUrl: `${appUrl}/dashboard/integrations`,
        }
      case 'config_broken':
        return {
          subject: 'A candidate hit a broken scheduling link',
          intro:
            `A candidate tried to book an interview for <strong>${escapeHtml(args.workspaceName)}</strong> but the scheduling link they followed is no longer valid (the underlying error was <code>${escapeHtml(args.code)}</code>). This usually means the scheduling config was deleted, deactivated, or the candidate's emailed link expired.`,
          ctaLabel: 'Open scheduling settings',
          ctaUrl: `${appUrl}/dashboard/scheduling`,
        }
      case 'meeting_missing':
        return {
          subject: 'A candidate tried to change a meeting that no longer exists',
          intro:
            `A candidate tried to cancel or reschedule an interview for <strong>${escapeHtml(args.workspaceName)}</strong> but HireFunnel could not find the original meeting (error: <code>${escapeHtml(args.code)}</code>). The candidate may need a fresh booking link or direct help.`,
          ctaLabel: 'View candidates',
          ctaUrl: `${appUrl}/dashboard/candidates`,
        }
      case 'internal':
      default:
        return {
          subject: 'A candidate hit an unexpected scheduling error',
          intro:
            `A candidate trying to book an interview for <strong>${escapeHtml(args.workspaceName)}</strong> hit an unexpected server error (code: <code>${escapeHtml(args.code)}</code>). We have logged it for review.`,
          ctaLabel: 'View dashboard',
          ctaUrl: `${appUrl}/dashboard`,
        }
    }
  })()

  const detailBlock = args.errDetail
    ? `<p style="color:#9ca3af;font-size:12px;background:#f9fafb;padding:8px 12px;border-radius:4px;font-family:ui-monospace,monospace;word-break:break-word;">${escapeHtml(args.errDetail).slice(0, 600)}</p>`
    : ''

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1f2937; margin-top: 0;">${escapeHtml(content.subject)}</h2>
      <p style="color: #374151;">${greeting}</p>
      <p style="color: #374151;">${content.intro}</p>
      <p style="margin: 24px 0;">
        <a href="${content.ctaUrl}"
           style="background:#FF9500;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">
          ${escapeHtml(content.ctaLabel)}
        </a>
      </p>
      ${content.followup ? `<p style="color:#6b7280;font-size:13px;">${content.followup}</p>` : ''}
      ${detailBlock}
      <p style="color:#9ca3af;font-size:12px;margin-top:32px;">We will not email you again about the same kind of issue for 24 hours.</p>
      <p style="color:#9ca3af;font-size:12px;">— HireFunnel</p>
    </div>
  `.trim()

  const text =
    `${greeting.replace(/<[^>]+>/g, '')}\n\n` +
    stripHtml(content.intro) +
    `\n\n${content.ctaLabel}: ${content.ctaUrl}\n\n` +
    (content.followup ? `${stripHtml(content.followup)}\n\n` : '') +
    (args.errDetail ? `Technical detail: ${args.errDetail.slice(0, 600)}\n\n` : '') +
    'You will not be re-notified about the same kind of issue for 24 hours.\n\n— HireFunnel'

  return { subject: content.subject, html, text }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}
