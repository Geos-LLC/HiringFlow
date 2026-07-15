import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getVideoUrl } from '@/lib/storage'
import { tryParseCaptureConfig } from '@/lib/capture/capture-config'
import { isCaptureStepsEnabledForWorkspace } from '@/lib/capture/capture-feature-flag'
import { createAccessToken, buildTrainingLink } from '@/lib/training-access'
import { issueBookingToken } from '@/lib/scheduling/booking-links'
import { getAppUrl } from '@/lib/google'

export async function GET(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  const session = await prisma.session.findUnique({
    where: { id: params.sessionId },
    include: {
      flow: true,
      // Pull workspace.settings so the response can advertise whether the
      // capture feature is on for this tenant. The candidate UI uses this
      // boolean (rather than the global env flag) to decide whether to
      // render the recorder or the graceful-unavailable notice.
      workspace: { select: { settings: true } },
      lastStep: {
        include: {
          video: true,
          options: {
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  })

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  // Allow access if flow is published OR if this is a preview session (already authenticated at creation)
  // Session creation already validates ownership for unpublished flows

  // Session is finished
  if (session.finishedAt) {
    return NextResponse.json({ finished: true })
  }

  // No current step (shouldn't happen normally)
  if (!session.lastStep) {
    return NextResponse.json({ finished: true })
  }

  const step = session.lastStep

  // Count total steps and get all step IDs for progress navigation
  const allSteps = await prisma.flowStep.findMany({
    where: { flowId: session.flowId },
    orderBy: { stepOrder: 'asc' },
    select: { id: true, stepOrder: true, combinedWithId: true },
  })
  const totalSteps = allSteps.length
  const currentStepOrder = step.stepOrder

  // Check if this step has a combined partner
  let combinedStep = null
  const combinedWithId = (step as any).combinedWithId as string | null
  if (combinedWithId) {
    const partner = await prisma.flowStep.findUnique({
      where: { id: combinedWithId },
      include: { video: true, options: { orderBy: { createdAt: 'asc' } } },
    })
    if (partner) {
      combinedStep = {
        stepId: partner.id,
        title: partner.title,
        videoUrl: partner.video ? getVideoUrl(partner.video.storageKey) : null,
        questionText: partner.questionText,
        stepType: partner.stepType,
        questionType: partner.questionType,
        infoContent: (partner as any).infoContent || null,
        captionsEnabled: partner.captionsEnabled,
        segments: partner.captionsEnabled && partner.video ? (partner.video as any).segments || [] : [],
        formEnabled: partner.formEnabled || partner.stepType === 'form',
        formConfig: partner.formConfig,
        options: partner.options.map((o) => ({
          optionId: o.id,
          text: o.optionText,
          nextStepId: o.nextStepId,
        })),
      }
    }
  }

  // Also check if another step combines WITH this step
  if (!combinedStep) {
    const reversePartner = await prisma.flowStep.findFirst({
      where: { combinedWithId: step.id },
      include: { video: true, options: { orderBy: { createdAt: 'asc' } } },
    })
    if (reversePartner) {
      combinedStep = {
        stepId: reversePartner.id,
        title: reversePartner.title,
        videoUrl: reversePartner.video ? getVideoUrl(reversePartner.video.storageKey) : null,
        questionText: reversePartner.questionText,
        stepType: reversePartner.stepType,
        questionType: reversePartner.questionType,
        infoContent: (reversePartner as any).infoContent || null,
        captionsEnabled: reversePartner.captionsEnabled,
        segments: reversePartner.captionsEnabled && reversePartner.video ? (reversePartner.video as any).segments || [] : [],
        formEnabled: reversePartner.formEnabled || reversePartner.stepType === 'form',
        formConfig: reversePartner.formConfig,
        options: reversePartner.options.map((o) => ({
          optionId: o.id,
          text: o.optionText,
          nextStepId: o.nextStepId,
        })),
      }
    }
  }

  // Parse the capture config through the validator so the client only ever
  // receives a known shape (or null). Anything malformed in DB is treated as
  // "not a capture step" by isCaptureStep and falls through to the legacy
  // behaviour, preserving non-regression on older rows.
  const captureConfig =
    step.stepType === 'capture' ? tryParseCaptureConfig((step as any).captureConfig) : null

  // Composite gate: global env + workspace opt-in. Client renders the
  // recorder only when this is true.
  const captureStepsEnabled = isCaptureStepsEnabledForWorkspace({
    workspaceSettings: session.workspace?.settings,
  })

  // Training step: resolve the linked training, mint (or reuse) a per-
  // candidate access token, and surface completion status so the client
  // can poll for completion + auto-advance.
  let training: {
    id: string
    title: string
    slug: string
    description: string | null
    // Full standalone URL — retained for the eventual "open in a new tab"
    // fallback and for share/log surfaces. The embedded viewer uses
    // { slug, accessToken } instead so it doesn't have to parse the URL.
    url: string
    accessToken: string
    completed: boolean
  } | null = null
  const stepTrainingId = (step as unknown as { trainingId?: string | null }).trainingId ?? null
  if (step.stepType === 'training' && stepTrainingId) {
    const t = await prisma.training.findUnique({
      where: { id: stepTrainingId },
      select: { id: true, title: true, slug: true, description: true },
    })
    if (t) {
      const { token } = await createAccessToken({
        sessionId: session.id,
        trainingId: t.id,
        sourceRefId: step.id,
      })
      const enrollment = await prisma.trainingEnrollment.findFirst({
        where: { sessionId: session.id, trainingId: t.id },
        select: { completedAt: true },
      })
      training = {
        id: t.id,
        title: t.title,
        slug: t.slug,
        description: t.description,
        url: buildTrainingLink(t.slug, token),
        accessToken: token,
        completed: !!enrollment?.completedAt,
      }
    }
  }

  // Scheduling step: resolve the linked config, mint a signed booking
  // token, look up any existing (non-cancelled) meeting, and hand back a
  // single actionUrl the client can just window.open on click. Reschedule
  // is only supported for the built-in scheduler; external providers own
  // reschedule themselves.
  let scheduling: {
    id: string
    name: string
    useBuiltInScheduler: boolean
    actionUrl: string
    existingMeeting: {
      id: string
      scheduledStart: string
      scheduledEnd: string
      meetingUri: string | null
      confirmed: boolean
    } | null
    booked: boolean
  } | null = null
  const stepSchedulingConfigId = (step as unknown as { schedulingConfigId?: string | null }).schedulingConfigId ?? null
  if (step.stepType === 'scheduling' && stepSchedulingConfigId) {
    const config = await prisma.schedulingConfig.findUnique({
      where: { id: stepSchedulingConfigId },
      select: { id: true, name: true, isActive: true, useBuiltInScheduler: true, schedulingUrl: true },
    })
    if (config && config.isActive) {
      const meeting = await prisma.interviewMeeting.findFirst({
        where: {
          sessionId: session.id,
          schedulingConfigId: config.id,
          cancelledAt: null,
        },
        orderBy: { scheduledStart: 'desc' },
        select: { id: true, scheduledStart: true, scheduledEnd: true, meetingUri: true, confirmedAt: true },
      })

      // `next` param is picked up by BookingClient's success state to
      // auto-redirect the candidate back into the flow after they book,
      // instead of stranding them on the /book success screen in a
      // separate tab. `advance=1` on the flow session URL is picked up
      // by the flow player to fire /answer immediately, so the
      // candidate lands on the NEXT step (usually the end screen)
      // without any extra click.
      // Same-origin only — BookingClient validates before redirecting.
      // Skipped for external providers because Calendly/Cal.com don't
      // respect our `next` param.
      const flowReturnPath = session.flow?.slug
        ? `/f/${session.flow.slug}/s/${session.id}?advance=1`
        : null

      // Book URL — signed token for built-in, prefilled external URL
      // otherwise. Same shape /api/public/schedule/redirect produces,
      // but built directly so the client doesn't need an extra roundtrip
      // (which would also log a fake `link_clicked` event every render).
      const buildBookUrl = () => {
        if (config.useBuiltInScheduler) {
          const token = issueBookingToken({
            sessionId: session.id,
            configId: config.id,
            purpose: 'book',
            daysFromNow: 30,
          })
          const nextQs = flowReturnPath ? `&next=${encodeURIComponent(flowReturnPath)}` : ''
          return `${getAppUrl()}/book/${config.id}?t=${encodeURIComponent(token)}${nextQs}`
        }
        // External provider — prefill name/email + tag utm_content with
        // sessionId so webhooks / Calendar sync can attribute the booking.
        try {
          const url = new URL(config.schedulingUrl)
          if (session.candidateName) url.searchParams.set('name', session.candidateName)
          if (session.candidateEmail) url.searchParams.set('email', session.candidateEmail)
          url.searchParams.set('utm_content', session.id)
          url.searchParams.set('utm_source', 'hirefunnel')
          return url.toString()
        } catch {
          return config.schedulingUrl
        }
      }

      let actionUrl: string
      if (meeting && config.useBuiltInScheduler) {
        const token = issueBookingToken({
          sessionId: session.id,
          configId: config.id,
          purpose: 'reschedule',
          daysFromNow: 30,
        })
        const nextQs = flowReturnPath ? `&next=${encodeURIComponent(flowReturnPath)}` : ''
        actionUrl = `${getAppUrl()}/book/${config.id}/reschedule?t=${encodeURIComponent(token)}${nextQs}`
      } else {
        actionUrl = buildBookUrl()
      }

      scheduling = {
        id: config.id,
        name: config.name,
        useBuiltInScheduler: config.useBuiltInScheduler,
        actionUrl,
        existingMeeting: meeting
          ? {
              id: meeting.id,
              scheduledStart: meeting.scheduledStart.toISOString(),
              scheduledEnd: meeting.scheduledEnd.toISOString(),
              meetingUri: meeting.meetingUri,
              confirmed: !!meeting.confirmedAt,
            }
          : null,
        booked: !!meeting,
      }
    }
  }

  return NextResponse.json({
    stepId: step.id,
    title: step.title,
    videoUrl: step.video ? getVideoUrl(step.video.storageKey) : null,
    questionText: step.questionText,
    stepType: step.stepType,
    questionType: step.questionType,
    infoContent: (step as Record<string, unknown>).infoContent || null,
    captionsEnabled: step.captionsEnabled,
    captionStyle: step.captionStyle,
    segments: step.captionsEnabled && step.video ? (step.video as any).segments || [] : [],
    formEnabled: step.formEnabled || step.stepType === 'form',
    formConfig: step.formConfig,
    captureConfig,
    captureStepsEnabled,
    training,
    scheduling,
    progress: { current: currentStepOrder + 1, total: totalSteps },
    stepIds: allSteps.map(s => s.id),
    combinedStep,
    options: step.options.map((o) => ({
      optionId: o.id,
      text: o.optionText,
      nextStepId: o.nextStepId,
    })),
  })
}
