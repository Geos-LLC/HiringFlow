import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { saveCandidateVideoFile } from '@/lib/storage'
import { fireFlowRecordingReadyAutomations } from '@/lib/automation'
import { emitAutomationEvent, eventKeys } from '@/lib/automation-emit'

// `flow_completed` automations are fired by the Prisma `$use` lifecycle
// middleware (src/lib/lifecycle-middleware.ts) when this route writes
// `finishedAt` + `outcome` to Session. Calling `fireAutomations` explicitly
// here was racing the middleware path through `executeStep` (the guard's
// idempotency check only blocks `status='sent'` rows, so two near-simultaneous
// pending rows both pass and both send). `recording_ready` stays explicit
// because the middleware only tracks CaptureResponse, not CandidateSubmission.

export async function POST(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  try {
    const formData = await request.formData()
    const stepId = formData.get('stepId') as string
    const textMessage = formData.get('textMessage') as string | null
    const video = formData.get('video') as File | null

    if (!stepId) {
      return NextResponse.json(
        { error: 'stepId is required' },
        { status: 400 }
      )
    }

    if (!textMessage && !video) {
      return NextResponse.json(
        { error: 'Either textMessage or video is required' },
        { status: 400 }
      )
    }

    const session = await prisma.session.findUnique({
      where: { id: params.sessionId },
      include: {
        flow: true,
      },
    })

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    if (session.finishedAt) {
      return NextResponse.json({ error: 'Session already finished' }, { status: 400 })
    }

    // Verify the step exists and is a submission type
    const step = await prisma.flowStep.findUnique({
      where: { id: stepId },
    })

    if (!step) {
      return NextResponse.json({ error: 'Step not found' }, { status: 404 })
    }

    if (step.stepType !== 'submission') {
      return NextResponse.json(
        { error: 'This step does not accept submissions' },
        { status: 400 }
      )
    }

    // Prepare submission data
    let videoData: {
      videoStorageKey: string
      videoFilename: string
      videoMimeType: string
      videoSizeBytes: number
    } | null = null

    if (video && video.size > 0) {
      const saved = await saveCandidateVideoFile(video)
      videoData = {
        videoStorageKey: saved.storageKey,
        videoFilename: saved.filename,
        videoMimeType: saved.mimeType,
        videoSizeBytes: saved.sizeBytes,
      }
    }

    // Upsert the submission (allows re-submission). Capture the id so the
    // recording_ready event below has a stable, non-nullable key component
    // — re-submitting against the same step keeps the same id, so the
    // AutomationEvent insert dedups instead of producing a second send.
    const submission = await prisma.candidateSubmission.upsert({
      where: {
        sessionId_stepId: {
          sessionId: params.sessionId,
          stepId: stepId,
        },
      },
      create: {
        sessionId: params.sessionId,
        stepId: stepId,
        textMessage: textMessage || null,
        ...(videoData || {}),
      },
      update: {
        textMessage: textMessage || null,
        ...(videoData || {}),
      },
      select: { id: true },
    })

    // Terminal detection: don't finish the session if this submission
    // step is part of a combined chain (i.e. a Video answer companion
    // to a question). Chain companions are mid-flow — the chain's
    // leader carries the forward wiring, not the companion, so a
    // buttonConfig check on the companion incorrectly reports "no
    // forward wiring" and marks the session complete. The /answer call
    // the client fires next handles real flow termination.
    {
      const now = new Date()
      const isChainMember =
        !!step.combinedWithId ||
        !!(await prisma.flowStep.findFirst({
          where: { flowId: session.flow.id, combinedWithId: stepId },
          select: { id: true },
        }))
      const btn = (step.buttonConfig as { nextStepId?: string | null } | null)?.nextStepId
      const hasForwardWiring = !!btn && btn !== '__end__'
      const isTerminal = !isChainMember && !hasForwardWiring
      await prisma.session.update({
        where: { id: params.sessionId },
        data: {
          lastStepId: stepId,
          ...(isTerminal ? { finishedAt: now, outcome: 'completed' } : {}),
          lastActivityAt: now,
          lastProgressAt: now,
        },
      })
    }

    // Additionally fire `recording_ready` rules when the submission carried
    // a video/audio recording. CandidateSubmission is not tracked by the
    // lifecycle middleware (it watches CaptureResponse instead), so this
    // is the only emit site for flow video recordings. Routed through
    // emitAutomationEvent so the (workspaceId, eventKey) constraint dedups
    // against any future emitter (e.g. an admin re-process endpoint).
    if (videoData) {
      await emitAutomationEvent({
        workspaceId: session.workspaceId,
        sessionId: params.sessionId,
        triggerType: 'recording_ready',
        eventKey: eventKeys.recordingReadyFlow(params.sessionId, submission.id),
        source: 'public_endpoint',
        payload: { candidateSubmissionId: submission.id, stepId },
        dispatch: () => fireFlowRecordingReadyAutomations(params.sessionId, { executionMode: 'public_trigger' }),
      })
    }

    return NextResponse.json({ finished: true })
  } catch (error) {
    console.error('Submit submission error:', error)
    return NextResponse.json(
      { error: 'Failed to submit response' },
      { status: 500 }
    )
  }
}
