import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { executeRule } from '@/lib/automation'

// Map an automation's triggerType to a reasonable starting pipeline status so
// the test candidate shows up at the stage the rule normally fires from.
const TRIGGER_TO_PIPELINE: Record<string, string> = {
  flow_completed: 'completed_flow',
  flow_passed: 'passed',
  training_started: 'training_in_progress',
  training_completed: 'training_completed',
  meeting_scheduled: 'scheduled',
  meeting_started: 'scheduled',
  meeting_ended: 'scheduled',
  recording_ready: 'scheduled',
  transcript_ready: 'scheduled',
}

const TRIGGER_TO_OUTCOME: Record<string, string | null> = {
  flow_completed: 'completed',
  flow_passed: 'passed',
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const { to } = await request.json().catch(() => ({ to: null }))
  if (!to || typeof to !== 'string') {
    return NextResponse.json({ error: 'Recipient required' }, { status: 400 })
  }

  const rule = await prisma.automationRule.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: {
      id: true, triggerType: true, name: true,
      // Multi-flow scope replaces the legacy single flowId. We pick a
      // deterministic sample flow for the test candidate below.
      flows: { select: { flowId: true } },
      steps: {
        orderBy: { order: 'asc' },
        select: { id: true, channel: true, emailTemplateId: true, smsTemplateId: true, smsBody: true },
      },
    },
  })
  if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (rule.steps.length === 0) return NextResponse.json({ error: 'Rule has no steps configured' }, { status: 400 })

  // Test recipient direction: pick the first step's channel to decide whether
  // we need an email or phone. For 'both' steps, prefer the email channel for
  // backwards-compat with the existing test UI.
  const firstStep = rule.steps[0]
  const testChannel: 'email' | 'sms' = firstStep.channel === 'sms' ? 'sms' : 'email'
  if (testChannel === 'email' && !firstStep.emailTemplateId) return NextResponse.json({ error: 'Email template missing on first step' }, { status: 400 })
  // Test mode only needs the step to be "sendable" — either a saved template
  // or an inline body. The executor itself does the final resolution.
  if (testChannel === 'sms' && !firstStep.smsTemplateId && (!firstStep.smsBody || firstStep.smsBody.trim().length === 0)) {
    return NextResponse.json({ error: 'SMS template or body missing on first step' }, { status: 400 })
  }

  if (testChannel === 'email' && !to.includes('@')) {
    return NextResponse.json({ error: 'Valid recipient email required' }, { status: 400 })
  }
  if (testChannel === 'sms' && !/^\+?\d[\d\s().-]{6,}$/.test(to)) {
    return NextResponse.json({ error: 'Valid recipient phone required' }, { status: 400 })
  }
  // Rules with no explicit flow scope (the "Any flow" default) are still
  // testable — fall back to the workspace's first active flow so we can
  // create a tracked test session. Session-wide triggers (meeting_*,
  // before_meeting, etc.) hide the flow picker entirely; they hit this
  // branch by design. Rules with multiple scoped flows: pick the first for
  // the test candidate — the rule fires the same way regardless of which
  // matching flow the candidate came through.
  let testFlowId: string | null = rule.flows[0]?.flowId ?? null
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

  const localPart = testChannel === 'email' ? to.split('@')[0] : to.replace(/\D/g, '').slice(-4)
  const candidateName = `Test: ${localPart}`
  const pipelineStatus = TRIGGER_TO_PIPELINE[rule.triggerType] ?? null
  const outcome = TRIGGER_TO_OUTCOME[rule.triggerType] ?? null

  const session = await prisma.session.create({
    data: {
      workspaceId: ws.workspaceId,
      flowId: testFlowId,
      candidateEmail: testChannel === 'email' ? to : null,
      candidatePhone: testChannel === 'sms' ? to : null,
      candidateName,
      // `source='test'` is the marker analytics/kanban/backfill filter on.
      // The central guard treats source='test' sessions as eligible for the
      // test-bypass (see executeStep) so the recruiter can render the
      // email/SMS end-to-end without first satisfying lifecycle/stage gates.
      source: 'test',
      pipelineStatus,
      outcome,
      finishedAt: outcome ? new Date() : null,
    },
  })

  // Attach a placeholder InterviewMeeting so {{meeting_link}} and
  // {{meeting_time}} render meaningfully in the test email/SMS. The
  // executeRule path always reads the latest InterviewMeeting for the
  // session — without one, those tokens render as empty strings, which
  // looks broken even though it'll populate correctly for real candidates.
  // Schedule for tomorrow at 14:00 local server time (matches the preview
  // sample date so test ↔ preview are consistent).
  const meetingStart = new Date()
  meetingStart.setDate(meetingStart.getDate() + 1)
  meetingStart.setHours(14, 0, 0, 0)
  const meetingEnd = new Date(meetingStart.getTime() + 30 * 60 * 1000)
  await prisma.interviewMeeting.create({
    data: {
      workspaceId: ws.workspaceId,
      sessionId: session.id,
      meetSpaceName: `spaces/test-${session.id}`,
      meetingCode: 'test-abc-defg',
      meetingUri: 'https://meet.google.com/test-abc-defg',
      googleCalendarEventId: `test-${session.id}`,
      scheduledStart: meetingStart,
      scheduledEnd: meetingEnd,
      // Pretend the test meeting already happened and was recorded so
      // post-meeting templates that use {{recording_link}} /
      // {{transcript_link}} render real-looking signed URLs instead of
      // empty hrefs ("View recording | View transcript" anchors going
      // nowhere). The signed URLs will 404 if clicked — by design;
      // there's no actual file — but the test body looks complete.
      actualStart: meetingStart,
      actualEnd: meetingEnd,
      recordingEnabled: true,
      recordingProvider: 'google_meet',
      recordingState: 'ready',
      driveRecordingFileId: 'sample-test-recording',
      transcriptState: 'ready',
      driveTranscriptFileId: 'sample-test-transcript',
    },
  }).catch((err) => {
    // Non-fatal — the test still runs, just without {{meeting_link}}.
    console.warn('[automation/test] could not seed placeholder InterviewMeeting:', (err as Error).message)
  })

  // Run the rule against the real session. Uses the same code path as a real
  // trigger — renders template, sends email/SMS, writes AutomationExecution,
  // logs SchedulingEvent (if next step is scheduling), chains downstream rules.
  // ignoreActive=true so tests work on draft/inactive rules.
  // bypassEligibilityForTest is honoured ONLY when session.source==='test'
  // (the guard re-verifies that in executeStep). Without this bypass the
  // test endpoint can't render bodies that depend on prerequisite state
  // (e.g. a training_completed rule against a freshly-created test session
  // with no enrollments).
  try {
    await executeRule(rule.id, session.id, {
      ignoreActive: true,
      dispatchCtx: {
        triggerType: rule.triggerType,
        executionMode: 'manual_rerun',
        actorUserId: ws.userId,
        bypassEligibilityForTest: true,
      },
    })
  } catch (err) {
    return NextResponse.json({
      success: false,
      sessionId: session.id,
      error: err instanceof Error ? err.message : 'Automation execution failed',
    }, { status: 502 })
  }

  // Surface the result of the first step's primary channel — that's what the
  // test recipient was expecting to receive. Multi-step / multi-channel rules
  // run end-to-end against the test session so users can inspect the full
  // sequence in the candidate timeline.
  const execution = await prisma.automationExecution.findFirst({
    where: {
      stepId: firstStep.id,
      sessionId: session.id,
      channel: testChannel,
      stageEntryId: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { status: true, errorMessage: true },
  })

  return NextResponse.json({
    success: execution?.status === 'sent',
    sessionId: session.id,
    sentTo: to,
    executionStatus: execution?.status ?? 'unknown',
    error: execution?.status !== 'sent' ? (execution?.errorMessage || 'Send did not complete') : undefined,
  })
}
