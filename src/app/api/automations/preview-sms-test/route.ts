import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendSms, normalizeToE164, SmsConfigError, SmsValidationError, SmsSendError } from '@/lib/sms'
import { renderTemplate } from '@/lib/email'
import { resolveSchedulingUrl, buildScheduleRedirectUrl } from '@/lib/scheduling'
import { createAccessToken, buildTrainingLink } from '@/lib/training-access'
import { resolveDynamicLinks } from '@/lib/template-link-resolver'

/**
 * Send a "real link" test SMS from the automation preview modal.
 *
 * The recruiter is previewing an SMS step and wants to receive it on their
 * phone with **working** links — tap the training link, see the training;
 * tap the schedule link, land on the booking page. Sending the sample-token
 * preview body (`?token=SAMPLE_TOKEN`) yields an unusable link.
 *
 * When `ruleId` + `stepId` are provided (saved-rule preview):
 *   1. Spin up a Session with source='test' + placeholder InterviewMeeting
 *      (source='test' isolates it from analytics/kanban and bypasses guard
 *      gates in executeStep — same pattern as /api/automations/[id]/test).
 *   2. Mint a real TrainingAccessToken keyed to that session so the link
 *      resolves against the tester's own enrollment (they'll show up under
 *      `Training: in progress` on that stub candidate, which is fine).
 *   3. Resolve sub-tokens ({{training_link:<id>}}, {{schedule_link:<id>}})
 *      via the shared resolver so button links in the body work too.
 *   4. Render the SMS body with real merge tokens and send via Sigcore.
 *
 * When `ruleId`/`stepId` are omitted (draft step from an unsaved rule):
 *   Falls back to sending `fallbackBody` verbatim — links inside will still
 *   be sample-token placeholders. Save the rule to get working links.
 */
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const payload = await request.json().catch(() => null) as {
    phone?: string
    ruleId?: string
    stepId?: string
    fallbackBody?: string
  } | null
  if (!payload || !payload.phone || typeof payload.phone !== 'string') {
    return NextResponse.json({ error: 'Recipient phone required' }, { status: 400 })
  }

  const normalized = normalizeToE164(payload.phone)
  if (!normalized) {
    return NextResponse.json(
      { error: 'Invalid recipient phone. Use E.164 format (e.g. +15551234567)' },
      { status: 400 },
    )
  }

  // ── Draft path — no ruleId/stepId means unsaved editor state; just send
  // the already-rendered sample body. Links inside won't work, but the
  // recruiter can still eyeball formatting / length on-device.
  if (!payload.ruleId || !payload.stepId) {
    if (!payload.fallbackBody || payload.fallbackBody.trim().length === 0) {
      return NextResponse.json({ error: 'SMS body is empty' }, { status: 400 })
    }
    return sendAndRespond({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      to: normalized,
      body: payload.fallbackBody,
      linksAreReal: false,
    })
  }

  // ── Saved-rule path — load rule + step, then build a real-context send.
  const rule = await prisma.automationRule.findFirst({
    where: { id: payload.ruleId, workspaceId: ws.workspaceId },
    include: {
      workspace: { select: { timezone: true, phone: true } },
      flow: { select: { id: true, name: true } },
      steps: {
        where: { id: payload.stepId },
        include: {
          smsTemplate: { select: { id: true, name: true, body: true } },
          training: { select: { id: true, slug: true, title: true } },
          schedulingConfig: { select: { id: true, name: true, schedulingUrl: true } },
        },
      },
    },
  })
  if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
  const step = rule.steps[0]
  if (!step) return NextResponse.json({ error: 'Step not found' }, { status: 404 })

  const rawBody = (step.smsTemplate?.body && step.smsTemplate.body.trim().length > 0)
    ? step.smsTemplate.body
    : (step.smsBody ?? '')
  if (!rawBody || rawBody.trim().length === 0) {
    return NextResponse.json({ error: 'SMS body missing on this step' }, { status: 400 })
  }

  // Fallback flow — session-wide triggers (meeting_*, before_meeting, etc.)
  // legitimately have no flowId. Mirror the pattern used in
  // /api/automations/[id]/test so the test session always attaches to *a*
  // flow — required by the Session FK.
  let testFlowId = rule.flowId
  if (!testFlowId) {
    const fallbackFlow = await prisma.flow.findFirst({
      where: { workspaceId: ws.workspaceId, isPublished: true },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    }) ?? await prisma.flow.findFirst({
      where: { workspaceId: ws.workspaceId },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    })
    if (!fallbackFlow) {
      return NextResponse.json(
        { error: 'No flow available for the test candidate. Create a flow first.' },
        { status: 400 },
      )
    }
    testFlowId = fallbackFlow.id
  }

  const last4 = normalized.replace(/\D/g, '').slice(-4)
  const session = await prisma.session.create({
    data: {
      workspaceId: ws.workspaceId,
      flowId: testFlowId,
      candidatePhone: normalized,
      candidateName: `SMS test: ${last4}`,
      source: 'test',
    },
  })

  // Placeholder meeting so {{meeting_time}} / {{meeting_link}} render.
  const meetingStart = new Date()
  meetingStart.setDate(meetingStart.getDate() + 1)
  meetingStart.setHours(14, 0, 0, 0)
  const meetingEnd = new Date(meetingStart.getTime() + 30 * 60 * 1000)
  await prisma.interviewMeeting.create({
    data: {
      workspaceId: ws.workspaceId,
      sessionId: session.id,
      meetSpaceName: `spaces/sms-test-${session.id}`,
      meetingCode: 'test-abc-defg',
      meetingUri: 'https://meet.google.com/test-abc-defg',
      googleCalendarEventId: `sms-test-${session.id}`,
      scheduledStart: meetingStart,
      scheduledEnd: meetingEnd,
    },
  }).catch((err) => {
    console.warn('[preview-sms-test] placeholder meeting failed:', (err as Error).message)
  })

  // Mint the real training link (top-level {{training_link}}). The token is
  // keyed to the test session, so the tester lands on the training page as
  // the "SMS test" candidate — expected behavior for a preview send.
  let trainingLink = ''
  if (step.nextStepType === 'training' && step.training) {
    const { token } = await createAccessToken({
      sessionId: session.id,
      trainingId: step.training.id,
      sourceRefId: `preview-sms-test:${rule.id}`,
    })
    trainingLink = buildTrainingLink(step.training.slug, token)
  } else if (step.nextStepUrl) {
    trainingLink = step.nextStepUrl
  }

  const resolvedSched = step.schedulingConfigId
    ? await resolveSchedulingUrl(step.schedulingConfigId, ws.workspaceId).catch(() => null)
    : null
  const scheduleLink = step.nextStepType === 'scheduling'
    ? (step.schedulingConfigId
        ? buildScheduleRedirectUrl(session.id, resolvedSched?.configId || step.schedulingConfigId)
        : (step.schedulingConfig?.schedulingUrl || ''))
    : ''

  // Sub-tokens: {{training_link:<id>}} + {{schedule_link:<id>}} in the body.
  const subTokens = await resolveDynamicLinks({
    text: rawBody,
    sessionId: session.id,
    workspaceId: ws.workspaceId,
    sourceRefId: `preview-sms-test:${rule.id}`,
  }).catch(() => ({} as Record<string, string>))

  const workspaceTz = rule.workspace?.timezone || 'America/New_York'
  const meetingTime = meetingStart.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: workspaceTz, timeZoneName: 'short',
  })
  const meetingDate = meetingStart.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: workspaceTz,
  })
  const meetingClock = meetingStart.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: workspaceTz, timeZoneName: 'short',
  })

  const variables: Record<string, string> = {
    candidate_name: `SMS test ${last4}`,
    flow_name: rule.flow?.name || 'Test Flow',
    training_link: trainingLink,
    schedule_link: scheduleLink,
    meeting_time: meetingTime,
    meeting_date: meetingDate,
    meeting_clock: meetingClock,
    meeting_link: 'https://meet.google.com/test-abc-defg',
    recording_link: '',
    transcript_link: '',
    recording_status_note: '',
    source: 'preview-test',
    ad_name: 'Test ad',
    ...subTokens,
  }

  const renderedBody = renderTemplate(rawBody, variables)

  return sendAndRespond({
    workspaceId: ws.workspaceId,
    userId: ws.userId,
    to: normalized,
    body: renderedBody,
    linksAreReal: true,
    sessionId: session.id,
  })
}

async function sendAndRespond(opts: {
  workspaceId: string
  userId: string
  to: string
  body: string
  linksAreReal: boolean
  sessionId?: string
}) {
  try {
    const result = await sendSms({
      candidateId: opts.sessionId ?? `preview-test-${opts.userId}`,
      workspaceId: opts.workspaceId,
      to: opts.to,
      body: opts.body,
    })
    return NextResponse.json({
      providerMessageId: result.providerMessageId,
      status: result.status,
      sentTo: opts.to,
      linksAreReal: opts.linksAreReal,
      sessionId: opts.sessionId,
    })
  } catch (err) {
    if (err instanceof SmsConfigError) {
      return NextResponse.json({ error: `SMS not configured: ${err.message}` }, { status: 500 })
    }
    if (err instanceof SmsValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    if (err instanceof SmsSendError) {
      return NextResponse.json({ error: `Send failed: ${err.message}` }, { status: 502 })
    }
    return NextResponse.json({ error: (err as Error).message || 'Send failed' }, { status: 500 })
  }
}
