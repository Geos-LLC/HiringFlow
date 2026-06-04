import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, renderTemplate } from '@/lib/email'
import { sendSms, normalizeToE164 } from '@/lib/sms'
import {
  MANUAL_MEETING_NUDGE_TEMPLATE_NAME,
  DEFAULT_EMAIL_TEMPLATES,
} from '@/lib/email-templates-seed'

// Manual "join now" nudge sent from the candidate page when the candidate
// is late or hasn't joined the live meeting. Distinct from before_meeting
// reminders (sent ahead of time) and meeting_no_show follow-ups (sent
// after, "pick a new time"). Uses a dedicated, editable email template
// scoped to the workspace so recruiters can tweak the copy.
//
// SMS is sent in addition to email when the candidate has a phone number.
// Both channels share the same template row: bodyHtml is the email body,
// and bodyText is the SMS body (also used as the email's plain-text alt).
// Recruiters edit both from the Email Templates page → "Meeting nudge —
// join now". Hardcoded fallback below is used only if a recruiter has
// blanked the bodyText field on a pre-existing template row.

const DEFAULT_SMS_BODY = "Hi {{candidate_name}}, we're on the call waiting for you. Join: {{meeting_link}}"

async function getOrCreateNudgeTemplate(workspaceId: string, userId: string) {
  const existing = await prisma.emailTemplate.findFirst({
    where: { workspaceId, name: MANUAL_MEETING_NUDGE_TEMPLATE_NAME },
  })
  if (existing) return existing
  const seed = DEFAULT_EMAIL_TEMPLATES.find((t) => t.name === MANUAL_MEETING_NUDGE_TEMPLATE_NAME)
  if (!seed) throw new Error('Manual nudge template seed missing')
  return prisma.emailTemplate.create({
    data: {
      workspaceId,
      createdById: userId,
      name: seed.name,
      subject: seed.subject,
      bodyHtml: seed.bodyHtml,
      bodyText: seed.bodyText ?? null,
    },
  })
}

async function findMeetingContext(sessionId: string) {
  const im = await prisma.interviewMeeting.findFirst({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    select: { meetingUri: true, scheduledStart: true },
  })
  if (im?.meetingUri) {
    return { meetingUrl: im.meetingUri, scheduledAt: im.scheduledStart }
  }
  const evt = await prisma.schedulingEvent.findFirst({
    where: { sessionId, eventType: { in: ['meeting_scheduled', 'meeting_rescheduled'] } },
    orderBy: { eventAt: 'desc' },
    select: { metadata: true },
  })
  const meta = (evt?.metadata as Record<string, unknown> | null) || null
  const url = typeof meta?.meetingUrl === 'string' ? meta.meetingUrl : null
  const scheduledAtRaw = typeof meta?.scheduledAt === 'string' ? meta.scheduledAt : null
  const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : null
  if (!url) return null
  return { meetingUrl: url, scheduledAt }
}

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    include: { flow: true, workspace: { select: { senderEmail: true, senderName: true, senderVerifiedAt: true, senderDomain: true, senderDomainValidatedAt: true, timezone: true } } },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!session.candidateEmail) {
    return NextResponse.json({ error: 'Candidate has no email on file.' }, { status: 400 })
  }

  const meetingCtx = await findMeetingContext(session.id)
  if (!meetingCtx) {
    return NextResponse.json({ error: 'No meeting found for this candidate — nothing to remind about.' }, { status: 400 })
  }

  const template = await getOrCreateNudgeTemplate(ws.workspaceId, ws.userId)

  // Render meeting time in the workspace's timezone — same logic as the
  // automation executor, so the candidate sees a consistent format.
  const tz = session.workspace?.timezone || 'America/New_York'
  const meetingTime = meetingCtx.scheduledAt
    ? meetingCtx.scheduledAt.toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: tz, timeZoneName: 'short',
      })
    : ''

  const variables: Record<string, string> = {
    candidate_name: session.candidateName || 'there',
    flow_name: session.flow?.name || '',
    meeting_link: meetingCtx.meetingUrl,
    meeting_time: meetingTime,
  }

  // Pick the workspace's verified sender if it has one; otherwise fall
  // back to the platform default (handled inside sendEmail).
  let from: { email: string; name?: string } | null = null
  const wsRow = session.workspace
  if (wsRow?.senderEmail && wsRow?.senderName) {
    const domainOk = !!(wsRow.senderDomainValidatedAt && wsRow.senderDomain && wsRow.senderEmail.toLowerCase().endsWith('@' + wsRow.senderDomain.toLowerCase()))
    const singleOk = !!wsRow.senderVerifiedAt
    if (domainOk || singleOk) from = { email: wsRow.senderEmail, name: wsRow.senderName || undefined }
  }

  const subject = renderTemplate(template.subject, variables)
  const html = renderTemplate(template.bodyHtml, variables)
  const text: string | undefined = template.bodyText ? renderTemplate(template.bodyText, variables) : undefined
  const emailResult = await sendEmail({
    to: session.candidateEmail,
    subject,
    html,
    text,
    from,
    workspaceId: session.workspaceId,
    candidateId: session.id,
    unsubscribeSessionId: session.id,
  })

  let smsResult: { success: boolean; error?: string } | null = null
  if (session.candidatePhone) {
    const normalized = normalizeToE164(session.candidatePhone)
    if (normalized) {
      // Prefer the recruiter-editable bodyText for SMS copy; fall back to
      // the hardcoded default only when the template row exists but
      // bodyText was blanked out.
      const smsTemplate = (template.bodyText && template.bodyText.trim().length > 0)
        ? template.bodyText
        : DEFAULT_SMS_BODY
      try {
        await sendSms({
          candidateId: session.id,
          workspaceId: ws.workspaceId,
          to: normalized,
          body: renderTemplate(smsTemplate, variables),
        })
        smsResult = { success: true }
      } catch (err) {
        smsResult = { success: false, error: err instanceof Error ? err.message : 'SMS send failed' }
      }
    }
  }

  // Log to the timeline so the recruiter can see when nudges went out.
  await prisma.schedulingEvent.create({
    data: {
      sessionId: session.id,
      eventType: 'nudge_sent',
      metadata: {
        meetingUrl: meetingCtx.meetingUrl,
        scheduledAt: meetingCtx.scheduledAt?.toISOString() || null,
        emailOk: emailResult.success,
        smsOk: smsResult?.success ?? null,
        templateName: MANUAL_MEETING_NUDGE_TEMPLATE_NAME,
        sentBy: ws.userId,
      },
    },
  }).catch((err) => console.error('[send-meeting-reminder] failed to log SchedulingEvent:', err))

  return NextResponse.json({
    email: emailResult,
    sms: smsResult,
    templateName: MANUAL_MEETING_NUDGE_TEMPLATE_NAME,
  })
}
