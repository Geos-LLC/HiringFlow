/**
 * Baseline meeting-confirmation email — the platform-level "you're booked,
 * here's the Meet link" send that fires unconditionally from bookInterview()
 * the moment an InterviewMeeting row is created. Independent of any
 * AutomationRule configuration: a workspace with zero `meeting_scheduled`
 * rules still gets this; a workspace with rules ALSO gets this (any
 * additional copy in their rules is layered on top).
 *
 * Why this lives outside the automation engine:
 *   - AutomationRules are filtered by isActive, flow scope, AND pipeline
 *     scope. A scope mismatch (rule pinned to pipeline A, flow on pipeline B)
 *     silently drops the rule. A candidate who books a meeting and never
 *     receives the link is a hard product failure — it cannot be opt-in.
 *   - This send is deliberately minimal: confirmation + Meet link + time +
 *     reschedule/cancel. All custom copy (reminders, recruiter notifications,
 *     branding, multi-step flows) belongs in user-configured layers
 *     (SchedulingConfig-level reminders, pipeline AutomationRules).
 *
 * Idempotency: best-effort. Booking is a single user action; retries inside
 * bookInterview() happen before the InterviewMeeting row exists. We do not
 * persist a sent-at marker — if some future caller invokes this twice for
 * the same meeting, two emails go out. Acceptable until proven otherwise.
 */

import { prisma } from '../prisma'
import { sendEmail } from '../email'
import { issueBookingToken } from './booking-links'

export interface SendMeetingConfirmationResult {
  sent: boolean
  skipped?: 'no_candidate_email' | 'meeting_not_found'
  error?: string
  messageId?: string
}

export async function sendMeetingConfirmation(
  meetingId: string,
): Promise<SendMeetingConfirmationResult> {
  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    include: {
      workspace: {
        select: {
          id: true,
          name: true,
          timezone: true,
          senderName: true,
          senderEmail: true,
        },
      },
      session: {
        select: {
          id: true,
          candidateName: true,
          candidateEmail: true,
        },
      },
    },
  })

  if (!meeting) {
    return { sent: false, skipped: 'meeting_not_found' }
  }
  if (!meeting.session.candidateEmail) {
    return { sent: false, skipped: 'no_candidate_email' }
  }

  const workspaceTz = meeting.workspace.timezone || 'America/New_York'
  const meetingTime = meeting.scheduledStart.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: workspaceTz,
    timeZoneName: 'short',
  })

  // Reschedule + cancel links (best-effort — only meaningful for built-in
  // scheduler bookings; Calendly/external configs don't accept our routes).
  let rescheduleLink = ''
  let cancelLink = ''
  if (meeting.schedulingConfigId) {
    try {
      const cfg = await prisma.schedulingConfig.findUnique({
        where: { id: meeting.schedulingConfigId },
        select: { useBuiltInScheduler: true },
      })
      if (cfg?.useBuiltInScheduler) {
        const appUrl = process.env.APP_URL
          || process.env.NEXT_PUBLIC_APP_URL
          || process.env.NEXTAUTH_URL
          || 'https://www.hirefunnel.app'
        // Tokens expire 1h before scheduledStart — reschedule/cancel cuts off
        // once the meeting is imminent, matching the existing reminder flow.
        const cutoff = new Date(meeting.scheduledStart.getTime() - 60 * 60_000)
        const reTok = issueBookingToken({
          sessionId: meeting.session.id,
          configId: meeting.schedulingConfigId,
          purpose: 'reschedule',
          expiresAt: cutoff,
        })
        const caTok = issueBookingToken({
          sessionId: meeting.session.id,
          configId: meeting.schedulingConfigId,
          purpose: 'cancel',
          expiresAt: cutoff,
        })
        rescheduleLink = `${appUrl}/book/${meeting.schedulingConfigId}/reschedule?t=${encodeURIComponent(reTok)}`
        cancelLink = `${appUrl}/book/${meeting.schedulingConfigId}/cancel?t=${encodeURIComponent(caTok)}`
      }
    } catch (err) {
      console.error('[meeting-confirmation] failed to issue reschedule/cancel tokens:', err)
    }
  }

  const candidateFirstName = (meeting.session.candidateName || 'there').split(/\s+/)[0]
  const brandName = meeting.workspace.senderName || meeting.workspace.name || 'HireFunnel'
  const subject = `Your interview is confirmed — ${meetingTime}`

  const linksRow = rescheduleLink || cancelLink
    ? `<p style="margin:24px 0 0 0;font-size:13px;color:#6b7280;">
         Need to change something?
         ${rescheduleLink ? ` <a href="${rescheduleLink}" style="color:#2563eb;">Reschedule</a>` : ''}
         ${rescheduleLink && cancelLink ? ' &nbsp;·&nbsp; ' : ''}
         ${cancelLink ? `<a href="${cancelLink}" style="color:#2563eb;">Cancel</a>` : ''}
       </p>`
    : ''

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <p style="margin:0 0 16px 0;font-size:16px;">Hi ${escapeHtml(candidateFirstName)},</p>
    <p style="margin:0 0 24px 0;font-size:16px;line-height:1.5;">
      Your interview with ${escapeHtml(brandName)} is confirmed for
      <strong>${escapeHtml(meetingTime)}</strong>.
    </p>
    <div style="margin:0 0 24px 0;padding:20px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;">
      <p style="margin:0 0 12px 0;font-size:13px;color:#64748b;letter-spacing:0.04em;text-transform:uppercase;">Join the interview</p>
      <p style="margin:0 0 16px 0;font-size:18px;">
        <a href="${meeting.meetingUri}" style="color:#2563eb;word-break:break-all;">${meeting.meetingUri}</a>
      </p>
      <a href="${meeting.meetingUri}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:500;">
        Open Google Meet
      </a>
    </div>
    <p style="margin:0;font-size:14px;color:#475569;line-height:1.5;">
      The link is reserved for you — please join at the scheduled time.
    </p>
    ${linksRow}
    <p style="margin:32px 0 0 0;font-size:13px;color:#94a3b8;">— ${escapeHtml(brandName)}</p>
  </div>
</body></html>`

  const text = [
    `Hi ${candidateFirstName},`,
    '',
    `Your interview with ${brandName} is confirmed for ${meetingTime}.`,
    '',
    `Join: ${meeting.meetingUri}`,
    '',
    rescheduleLink ? `Reschedule: ${rescheduleLink}` : '',
    cancelLink ? `Cancel: ${cancelLink}` : '',
    '',
    `— ${brandName}`,
  ].filter(Boolean).join('\n')

  const from = meeting.workspace.senderEmail
    ? { email: meeting.workspace.senderEmail, name: meeting.workspace.senderName || brandName }
    : null

  const result = await sendEmail({
    to: meeting.session.candidateEmail,
    subject,
    html,
    text,
    from,
    workspaceId: meeting.workspace.id,
    candidateId: meeting.session.id,
  })

  if (!result.success) {
    console.error('[meeting-confirmation] send failed for meeting', meetingId, ':', result.error)
    return { sent: false, error: result.error }
  }
  return { sent: true, messageId: result.messageId }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
