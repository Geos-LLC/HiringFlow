import sgMail from '@sendgrid/mail'

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@hirefunnel.app'
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'HireFunnel'

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY)
}

export interface EmailPayload {
  to: string
  subject: string
  html: string
  text?: string
  from?: { email: string; name?: string } | null
  replyTo?: { email: string; name?: string } | null
  // Correlate this send with a row in our DB so the SendGrid Event Webhook
  // can update delivery status async. The webhook handler reads
  // custom_args.executionId off every event payload (delivered, bounce,
  // dropped…) and finds the matching AutomationExecution row.
  //
  // workspaceId / candidateId travel alongside for cross-workspace safety
  // checks in the webhook handler and for future per-workspace delivery
  // dashboards. All three are optional — non-automation sends (transcoder
  // notifications, password reset, etc.) can omit them; the email still
  // goes out, it just won't get a delivery row updated.
  executionId?: string | null
  workspaceId?: string | null
  candidateId?: string | null
}

export async function sendEmail(payload: EmailPayload): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!SENDGRID_API_KEY) {
    console.warn('[Email] SendGrid not configured — skipping send')
    return { success: false, error: 'SendGrid not configured' }
  }

  const from = payload.from?.email
    ? { email: payload.from.email, name: payload.from.name || FROM_NAME }
    : { email: FROM_EMAIL, name: FROM_NAME }

  const replyTo = payload.replyTo?.email
    ? { email: payload.replyTo.email, name: payload.replyTo.name || undefined }
    : undefined

  // SendGrid echoes customArgs back on every webhook event for this send.
  // Keep keys short — SendGrid caps the total customArgs payload at 10 KB
  // across all events for this message.
  const customArgs: Record<string, string> = {}
  if (payload.executionId) customArgs.executionId = payload.executionId
  if (payload.workspaceId) customArgs.workspaceId = payload.workspaceId
  if (payload.candidateId) customArgs.candidateId = payload.candidateId

  try {
    const [response] = await sgMail.send({
      to: payload.to,
      from,
      replyTo,
      subject: payload.subject,
      html: payload.html,
      text: payload.text || undefined,
      trackingSettings: {
        clickTracking: { enable: false, enableText: false },
        openTracking: { enable: false },
      },
      ...(Object.keys(customArgs).length > 0 ? { customArgs } : {}),
    })

    const messageId = response.headers['x-message-id'] as string || undefined
    console.log('[Email] Sent to', payload.to, 'messageId:', messageId)
    return { success: true, messageId }
  } catch (error: any) {
    const message = error?.response?.body?.errors?.[0]?.message || error?.message || 'Unknown error'
    console.error('[Email] Failed to send to', payload.to, ':', message)
    return { success: false, error: message }
  }
}

// Template variable replacement. Tolerates whitespace inside the braces
// (`{{ name }}` is treated the same as `{{name}}`) — recruiters paste
// templates from docs/emails where the formatting tool sometimes adds
// invisible spaces. Sub-token form `{{name:id}}` (e.g.
// `{{schedule_link:<configId>}}`) is also accepted — id chars allow
// hyphens for UUIDs. Unknown keys render as empty strings.
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z_][\w:.-]*)\s*\}\}/g, (_match, key: string) => {
    return variables[key] ?? ''
  })
}
