import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { renderTemplate } from '@/lib/email'
import { resolveSchedulingUrl } from '@/lib/scheduling'

/**
 * Preview an UNSAVED automation step. Used by the rule editor modal so
 * recruiters can vet copy before committing the rule to the DB.
 *
 * Mirrors the saved-rule preview endpoint at /api/automations/[id]/preview
 * but reads the step config from the request body instead of from a
 * persisted AutomationRuleStep.
 *
 * Body:
 *   {
 *     channel: 'email' | 'sms',
 *     emailTemplateId?: string,
 *     smsBody?: string,
 *     nextStepType?: 'training' | 'scheduling' | 'meet_link' | null,
 *     trainingId?: string,
 *     schedulingConfigId?: string,
 *     emailDestination?: 'applicant' | 'company' | 'specific',
 *     emailDestinationAddress?: string,
 *   }
 *
 * No side effects: nothing is sent or persisted.
 */
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = await request.json().catch(() => null) as {
    channel?: 'email' | 'sms'
    emailTemplateId?: string | null
    smsTemplateId?: string | null
    smsBody?: string | null
    nextStepType?: 'training' | 'scheduling' | 'meet_link' | null
    trainingId?: string | null
    schedulingConfigId?: string | null
    emailDestination?: 'applicant' | 'company' | 'specific'
    emailDestinationAddress?: string | null
    smsDestination?: 'applicant' | 'company' | 'specific'
    smsDestinationNumber?: string | null
  } | null
  if (!body) return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })

  const channel = body.channel === 'sms' ? 'sms' : 'email'
  // For SMS preview we accept either a saved-template id or an inline body —
  // exact same resolution rule the executor uses, so what you preview is
  // exactly what the candidate would receive.
  const smsHasTemplate = !!body.smsTemplateId
  const smsHasBody = !!(body.smsBody && body.smsBody.trim().length > 0)
  if (channel === 'sms' && !smsHasTemplate && !smsHasBody) {
    return NextResponse.json({ error: 'SMS body is empty' }, { status: 400 })
  }
  if (channel === 'email' && !body.emailTemplateId) {
    return NextResponse.json({ error: 'Email template required' }, { status: 400 })
  }

  // Load workspace + (for email) the chosen template — both scoped to the
  // caller's workspace so you can't preview templates you don't own.
  const workspace = await prisma.workspace.findUnique({
    where: { id: ws.workspaceId },
    select: { senderEmail: true, senderName: true, timezone: true, phone: true },
  })
  const template = channel === 'email' && body.emailTemplateId
    ? await prisma.emailTemplate.findFirst({
        where: { id: body.emailTemplateId, workspaceId: ws.workspaceId },
        select: { id: true, name: true, subject: true, bodyHtml: true, bodyText: true },
      })
    : null
  if (channel === 'email' && !template) {
    return NextResponse.json({ error: 'Email template not found in this workspace' }, { status: 404 })
  }
  const smsTemplate = channel === 'sms' && body.smsTemplateId
    ? await prisma.smsTemplate.findFirst({
        where: { id: body.smsTemplateId, workspaceId: ws.workspaceId },
        select: { id: true, name: true, body: true },
      })
    : null
  if (channel === 'sms' && body.smsTemplateId && !smsTemplate) {
    return NextResponse.json({ error: 'SMS template not found in this workspace' }, { status: 404 })
  }

  const training = body.nextStepType === 'training' && body.trainingId
    ? await prisma.training.findFirst({
        where: { id: body.trainingId, workspaceId: ws.workspaceId },
        select: { id: true, slug: true, title: true },
      })
    : null
  const schedulingConfig = body.nextStepType === 'scheduling' && body.schedulingConfigId
    ? await prisma.schedulingConfig.findFirst({
        where: { id: body.schedulingConfigId, workspaceId: ws.workspaceId },
        select: { id: true, name: true, schedulingUrl: true },
      })
    : null

  const resolved = await resolveSchedulingUrl(body.schedulingConfigId ?? null, ws.workspaceId).catch(() => null)
  const sampleScheduleLink = body.nextStepType === 'scheduling'
    ? (resolved?.url || schedulingConfig?.schedulingUrl || 'https://calendly.com/example/30min')
    : ''
  // See /api/automations/[id]/preview: owner-preview mode instead of a fake
  // token so clicking the link in the preview modal actually opens the
  // training rather than 403ing on TOKEN_INVALID. Origin from the request
  // keeps the dashboard session cookie in scope (bare domain vs www.).
  const sampleTrainingLink = body.nextStepType === 'training' && training
    ? `${new URL(request.url).origin}/t/${training.slug}?preview=1`
    : ''

  const workspaceTz = workspace?.timezone || 'America/New_York'
  const sampleMeetingDateObj = (() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(14, 0, 0, 0)
    return d
  })()
  const sampleMeetingTime = sampleMeetingDateObj.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: workspaceTz,
    timeZoneName: 'short',
  })
  const sampleMeetingDate = sampleMeetingDateObj.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: workspaceTz,
  })
  const sampleMeetingClock = sampleMeetingDateObj.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: workspaceTz,
    timeZoneName: 'short',
  })

  const variables: Record<string, string> = {
    candidate_name: 'Alex Sample',
    flow_name: 'Application Form',
    training_link: sampleTrainingLink,
    schedule_link: sampleScheduleLink,
    meeting_time: sampleMeetingTime,
    meeting_date: sampleMeetingDate,
    meeting_clock: sampleMeetingClock,
    meeting_link: 'https://meet.google.com/sam-ple-xyz',
    recording_link: 'https://hirefunnel.app/api/interview-meetings/sample/recording',
    transcript_link: 'https://hirefunnel.app/api/interview-meetings/sample/transcript',
    recording_status_note: '',
    source: 'preview',
    ad_name: 'Sample ad',
  }

  if (channel === 'sms') {
    // Match the executor's resolution rule: template wins over inline body.
    const rawBody = (smsTemplate?.body && smsTemplate.body.trim().length > 0)
      ? smsTemplate.body
      : (body.smsBody as string)
    const renderedBody = renderTemplate(rawBody, variables)
    const smsRecipient = body.smsDestination === 'company'
      ? (workspace?.phone || '(no company phone configured)')
      : body.smsDestination === 'specific'
        ? (body.smsDestinationNumber || '(no specific number configured)')
        : '+15551230000'
    return NextResponse.json({
      channel,
      smsBody: renderedBody,
      recipient: smsRecipient,
      from: { name: 'HireFunnel SMS', email: 'sigcore-pool' },
      templateName: smsTemplate?.name ?? 'SMS body',
      variables,
      length: renderedBody.length,
      segments: Math.max(1, Math.ceil(renderedBody.length / 160)),
    })
  }

  const subject = renderTemplate(template!.subject, variables)
  const html = renderTemplate(template!.bodyHtml, variables)
  const text = template!.bodyText ? renderTemplate(template!.bodyText, variables) : null

  const recipient = body.emailDestination === 'company'
    ? (workspace?.senderEmail || 'company@example.com')
    : body.emailDestination === 'specific'
      ? (body.emailDestinationAddress || 'specific@example.com')
      : 'alex.sample@example.com'

  const fromAddress = workspace?.senderEmail || 'no-reply@hirefunnel.app'
  const fromName = workspace?.senderName || 'HireFunnel'

  return NextResponse.json({
    channel,
    subject,
    html,
    text,
    recipient,
    from: { name: fromName, email: fromAddress },
    templateName: template!.name,
    variables,
  })
}
