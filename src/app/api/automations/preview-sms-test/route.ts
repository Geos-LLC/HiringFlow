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
 * Two entry paths — same output:
 *
 * 1) Saved-rule preview (`ruleId` + `stepId`) — server loads the step from
 *    DB.
 *
 * 2) Editor/draft preview (`draftStep`) — server uses the live in-modal
 *    step config. Lets the recruiter iterate on the SMS body + training
 *    picker without saving the rule first, and still tap the link.
 *
 * Both paths: spin up a `source='test'` Session, attach a placeholder
 * InterviewMeeting (for `{{meeting_*}}`), mint a real TrainingAccessToken
 * when a training is attached, resolve sub-tokens, render, send via
 * Sigcore. Falls back to sending `fallbackBody` verbatim if neither path
 * yields a resolvable step (defensive).
 */
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const payload = await request.json().catch(() => null) as {
    phone?: string
    ruleId?: string
    stepId?: string
    editingRuleId?: string
    draftStep?: {
      channel?: string
      smsTemplateId?: string | null
      smsBody?: string | null
      nextStepType?: string | null
      trainingId?: string | null
      schedulingConfigId?: string | null
      smsDestination?: string
      smsDestinationNumber?: string | null
    }
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

  // ── Resolve step config into a shared shape so the render + send path
  // is single-source. Step data can arrive from the DB (saved rule preview)
  // or from the live editor state (draft preview).
  type ResolvedStep = {
    rawBody: string
    nextStepType: string | null
    nextStepUrl: string | null
    training: { id: string; slug: string; title: string } | null
    schedulingConfigId: string | null
    schedulingConfig: { schedulingUrl: string | null } | null
    ruleId: string | null
    flowId: string | null
    flowName: string | null
    workspaceTz: string | null
  }
  let resolved: ResolvedStep | null = null

  if (payload.ruleId && payload.stepId) {
    const rule = await prisma.automationRule.findFirst({
      where: { id: payload.ruleId, workspaceId: ws.workspaceId },
      include: {
        workspace: { select: { timezone: true } },
        flow: { select: { id: true, name: true } },
        steps: {
          where: { id: payload.stepId },
          include: {
            smsTemplate: { select: { body: true } },
            training: { select: { id: true, slug: true, title: true } },
            schedulingConfig: { select: { schedulingUrl: true } },
          },
        },
      },
    })
    const step = rule?.steps[0]
    if (rule && step) {
      const rawBody = (step.smsTemplate?.body && step.smsTemplate.body.trim().length > 0)
        ? step.smsTemplate.body
        : (step.smsBody ?? '')
      if (rawBody.trim().length > 0) {
        resolved = {
          rawBody,
          nextStepType: step.nextStepType,
          nextStepUrl: step.nextStepUrl,
          training: step.training ?? null,
          schedulingConfigId: step.schedulingConfigId ?? null,
          schedulingConfig: step.schedulingConfig ?? null,
          ruleId: rule.id,
          flowId: rule.flowId,
          flowName: rule.flow?.name ?? null,
          workspaceTz: rule.workspace?.timezone ?? null,
        }
      }
    }
  } else if (payload.draftStep) {
    const d = payload.draftStep
    // Resolve the raw body from either the picked template or the inline
    // body — same rule the executor uses.
    let rawBody = ''
    if (d.smsTemplateId) {
      const tpl = await prisma.smsTemplate.findFirst({
        where: { id: d.smsTemplateId, workspaceId: ws.workspaceId },
        select: { body: true },
      })
      if (tpl?.body && tpl.body.trim().length > 0) rawBody = tpl.body
    }
    if (!rawBody && d.smsBody && d.smsBody.trim().length > 0) rawBody = d.smsBody

    if (rawBody.trim().length > 0) {
      // Look up training + scheduling config from the workspace, if any.
      const training = d.nextStepType === 'training' && d.trainingId
        ? await prisma.training.findFirst({
            where: { id: d.trainingId, workspaceId: ws.workspaceId },
            select: { id: true, slug: true, title: true },
          })
        : null
      const schedulingConfig = d.nextStepType === 'scheduling' && d.schedulingConfigId
        ? await prisma.schedulingConfig.findFirst({
            where: { id: d.schedulingConfigId, workspaceId: ws.workspaceId },
            select: { schedulingUrl: true },
          })
        : null

      // Prefer the workspace of the edited rule (for flow_name/tz), fall
      // back to workspace defaults. editingRuleId means "user is editing
      // a saved rule" — we can pull flow/tz from it for correctness.
      const editingRule = payload.editingRuleId
        ? await prisma.automationRule.findFirst({
            where: { id: payload.editingRuleId, workspaceId: ws.workspaceId },
            include: {
              workspace: { select: { timezone: true } },
              flow: { select: { id: true, name: true } },
            },
          })
        : null

      resolved = {
        rawBody,
        nextStepType: d.nextStepType ?? null,
        nextStepUrl: null,
        training,
        schedulingConfigId: d.schedulingConfigId ?? null,
        schedulingConfig,
        ruleId: editingRule?.id ?? null,
        flowId: editingRule?.flowId ?? null,
        flowName: editingRule?.flow?.name ?? null,
        workspaceTz: editingRule?.workspace?.timezone ?? null,
      }
    }
  }

  // ── Neither path yielded a step → send the fallback body as-is. Links
  // inside will still be sample tokens — but the recruiter at least sees
  // the SMS on their phone. (Should be rare; usually indicates the modal
  // is missing a body entirely.)
  if (!resolved) {
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

  // ── Real-render path: create a test session so TrainingAccessToken has
  // a candidate to bind to (also lets the schedule-redirect URL work).
  let testFlowId = resolved.flowId
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

  // Real training link — top-level {{training_link}}.
  let trainingLink = ''
  if (resolved.nextStepType === 'training' && resolved.training) {
    const { token } = await createAccessToken({
      sessionId: session.id,
      trainingId: resolved.training.id,
      sourceRefId: `preview-sms-test:${resolved.ruleId ?? 'draft'}`,
    })
    trainingLink = buildTrainingLink(resolved.training.slug, token)
  } else if (resolved.nextStepUrl) {
    trainingLink = resolved.nextStepUrl
  }

  const resolvedSched = resolved.schedulingConfigId
    ? await resolveSchedulingUrl(resolved.schedulingConfigId, ws.workspaceId).catch(() => null)
    : null
  const scheduleLink = resolved.nextStepType === 'scheduling'
    ? (resolved.schedulingConfigId
        ? buildScheduleRedirectUrl(session.id, resolvedSched?.configId || resolved.schedulingConfigId)
        : (resolved.schedulingConfig?.schedulingUrl || ''))
    : ''

  const subTokens = await resolveDynamicLinks({
    text: resolved.rawBody,
    sessionId: session.id,
    workspaceId: ws.workspaceId,
    sourceRefId: `preview-sms-test:${resolved.ruleId ?? 'draft'}`,
  }).catch(() => ({} as Record<string, string>))

  const workspaceTz = resolved.workspaceTz || 'America/New_York'
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
    flow_name: resolved.flowName || 'Test Flow',
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

  const renderedBody = renderTemplate(resolved.rawBody, variables)

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
