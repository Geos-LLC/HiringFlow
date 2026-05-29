import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { renderTemplate } from '@/lib/email'
import { resolveSchedulingUrl } from '@/lib/scheduling'

/**
 * Render what an automation step would send, using sample values so the
 * recruiter can see exactly what the candidate would receive.
 *
 * Query: ?stepId=<id>&channel=email|sms — selects the specific step+channel
 * to preview. Defaults: first step, primary channel ('email' if step.channel
 * is 'email' or 'both'; 'sms' otherwise).
 *
 * No side effects: nothing is sent or persisted.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const url = new URL(request.url)
  const stepIdParam = url.searchParams.get('stepId')
  const channelParam = url.searchParams.get('channel') as 'email' | 'sms' | null

  const rule = await prisma.automationRule.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    include: {
      workspace: { select: { senderEmail: true, senderName: true, timezone: true, phone: true } },
      steps: {
        orderBy: { order: 'asc' },
        include: {
          emailTemplate: true,
          smsTemplate: true,
          training: { select: { id: true, slug: true, title: true } },
          schedulingConfig: { select: { id: true, name: true, schedulingUrl: true } },
        },
      },
    },
  })
  if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (rule.steps.length === 0) return NextResponse.json({ error: 'Rule has no steps configured' }, { status: 400 })

  const step = stepIdParam ? rule.steps.find((s) => s.id === stepIdParam) : rule.steps[0]
  if (!step) return NextResponse.json({ error: 'Step not found' }, { status: 404 })

  // Decide channel: explicit query > step's primary channel.
  let channel: 'email' | 'sms'
  if (channelParam === 'email' || channelParam === 'sms') channel = channelParam
  else channel = step.channel === 'sms' ? 'sms' : 'email'

  if (channel === 'email' && !step.emailTemplate) return NextResponse.json({ error: 'Email template missing on this step' }, { status: 400 })
  // SMS body resolution: prefer template, fall back to inline body — same as executor.
  const resolvedSmsBody = (step.smsTemplate?.body && step.smsTemplate.body.trim().length > 0)
    ? step.smsTemplate.body
    : (step.smsBody ?? '')
  if (channel === 'sms' && (!resolvedSmsBody || resolvedSmsBody.trim().length === 0)) {
    return NextResponse.json({ error: 'SMS body missing on this step' }, { status: 400 })
  }

  const resolved = await resolveSchedulingUrl(step.schedulingConfigId, ws.workspaceId).catch(() => null)
  const sampleScheduleLink = step.nextStepType === 'scheduling'
    ? (resolved?.url || step.schedulingConfig?.schedulingUrl || 'https://calendly.com/example/30min')
    : ''
  const sampleTrainingLink = step.nextStepType === 'training' && step.training
    ? `https://hirefunnel.app/t/${step.training.slug}?token=SAMPLE_TOKEN`
    : (step.nextStepUrl || '')

  const workspaceTz = rule.workspace.timezone || 'America/New_York'
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
    const body = renderTemplate(resolvedSmsBody, variables)
    const smsRecipient = step.smsDestination === 'company'
      ? (rule.workspace?.phone || '(no company phone configured)')
      : step.smsDestination === 'specific'
        ? (step.smsDestinationNumber || '(no specific number configured)')
        : '+15551230000'
    return NextResponse.json({
      channel,
      stepId: step.id,
      stepOrder: step.order,
      smsBody: body,
      recipient: smsRecipient,
      from: { name: 'HireFunnel SMS', email: 'sigcore-pool' },
      templateName: step.smsTemplate?.name ?? 'SMS body',
      variables,
      length: body.length,
      segments: Math.max(1, Math.ceil(body.length / 160)),
    })
  }

  const subject = renderTemplate(step.emailTemplate!.subject, variables)
  const html = renderTemplate(step.emailTemplate!.bodyHtml, variables)
  const text = step.emailTemplate!.bodyText ? renderTemplate(step.emailTemplate!.bodyText, variables) : null

  const recipient = step.emailDestination === 'company'
    ? (rule.workspace?.senderEmail || 'company@example.com')
    : step.emailDestination === 'specific'
      ? (step.emailDestinationAddress || 'specific@example.com')
      : 'alex.sample@example.com'

  const fromAddress = rule.workspace?.senderEmail || 'no-reply@hirefunnel.app'
  const fromName = rule.workspace?.senderName || 'HireFunnel'

  return NextResponse.json({
    channel,
    stepId: step.id,
    stepOrder: step.order,
    subject,
    html,
    text,
    recipient,
    from: { name: fromName, email: fromAddress },
    templateName: step.emailTemplate!.name,
    variables,
  })
}
