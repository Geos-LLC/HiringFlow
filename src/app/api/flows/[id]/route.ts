import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getVideoUrl } from '@/lib/storage'
import { isCaptureStepsEnabledForWorkspace } from '@/lib/capture/capture-feature-flag'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const flow = await prisma.flow.findFirst({
    where: {
      id: params.id,
      workspaceId: ws.workspaceId,
    },
    include: {
      steps: {
        orderBy: { stepOrder: 'asc' },
        include: {
          video: true,
          options: {
            orderBy: { createdAt: 'asc' },
          },
        },
      },
      // Pull the workspace settings JSON so the builder can derive
      // captureStepsEnabled without a second fetch. Only the boolean is
      // returned to the client — we don't leak the full settings blob.
      workspace: { select: { settings: true } },
    },
  })

  if (!flow) {
    return NextResponse.json({ error: 'Flow not found' }, { status: 404 })
  }

  const captureStepsEnabled = isCaptureStepsEnabledForWorkspace({
    workspaceSettings: flow.workspace?.settings,
  })

  // Add video URLs. Strip the raw workspace.settings off the response and
  // surface only the derived capture flag.
  const { workspace: _ws, ...flowWithoutWorkspace } = flow
  const flowWithUrls = {
    ...flowWithoutWorkspace,
    steps: flow.steps.map((step) => ({
      ...step,
      video: step.video
        ? {
            ...step.video,
            url: getVideoUrl(step.video.storageKey),
          }
        : null,
    })),
    captureStepsEnabled,
  }

  return NextResponse.json(flowWithUrls)
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const flow = await prisma.flow.findFirst({
    where: {
      id: params.id,
      workspaceId: ws.workspaceId,
    },
  })

  if (!flow) {
    return NextResponse.json({ error: 'Flow not found' }, { status: 404 })
  }

  try {
    const body = await request.json() as {
      name?: string
      isPublished?: boolean
      startMessage?: string
      endMessage?: string
      branding?: unknown
      // Per-flow timeouts consumed by the cron stalled detector.
      // Pass `null` to clear and fall back to the platform default in
      // src/lib/candidate-status.ts (DEFAULT_TIMEOUTS).
      videoInterviewTimeoutDays?: number | null
      trainingTimeoutDays?: number | null
      noShowTimeoutHours?: number | null
      schedulingTimeoutHours?: number | null
      backgroundCheckTimeoutDays?: number | null
      // null = use workspace default pipeline. Any non-null value must
      // reference a pipeline owned by the caller's workspace.
      pipelineId?: string | null
      // Schema-view layout: { [stepId]: { x: number, y: number } }
      canvasLayout?: Record<string, { x: number; y: number }> | null
      // Plain-text job description used as the default input for AI candidate
      // evaluation. Pass null to clear and fall back to the linked Ad copy.
      positionDescription?: string | null
    }
    const { name, isPublished, startMessage, endMessage, branding,
      videoInterviewTimeoutDays, trainingTimeoutDays, noShowTimeoutHours,
      schedulingTimeoutHours, backgroundCheckTimeoutDays, pipelineId,
      canvasLayout, positionDescription } = body

    // Only allow positive integers (or null to clear). Reject other shapes
    // so a typo in the drawer doesn't write garbage to the DB.
    const validTimeout = (v: unknown): v is number | null =>
      v === null || (typeof v === 'number' && Number.isInteger(v) && v > 0)
    if (videoInterviewTimeoutDays !== undefined && !validTimeout(videoInterviewTimeoutDays)) {
      return NextResponse.json({ error: 'videoInterviewTimeoutDays must be a positive integer or null' }, { status: 400 })
    }
    if (trainingTimeoutDays !== undefined && !validTimeout(trainingTimeoutDays)) {
      return NextResponse.json({ error: 'trainingTimeoutDays must be a positive integer or null' }, { status: 400 })
    }
    if (noShowTimeoutHours !== undefined && !validTimeout(noShowTimeoutHours)) {
      return NextResponse.json({ error: 'noShowTimeoutHours must be a positive integer or null' }, { status: 400 })
    }
    if (schedulingTimeoutHours !== undefined && !validTimeout(schedulingTimeoutHours)) {
      return NextResponse.json({ error: 'schedulingTimeoutHours must be a positive integer or null' }, { status: 400 })
    }
    if (backgroundCheckTimeoutDays !== undefined && !validTimeout(backgroundCheckTimeoutDays)) {
      return NextResponse.json({ error: 'backgroundCheckTimeoutDays must be a positive integer or null' }, { status: 400 })
    }

    // Validate pipelineId against the caller's workspace before persisting.
    // Null is allowed and means "fall back to workspace default" in the
    // resolver. Any non-null value must belong to this workspace — otherwise
    // a recruiter could assign a flow to a pipeline owned by another tenant.
    if (pipelineId !== undefined && pipelineId !== null) {
      const pipeline = await prisma.pipeline.findFirst({
        where: { id: pipelineId, workspaceId: ws.workspaceId },
        select: { id: true },
      })
      if (!pipeline) {
        return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })
      }
    }

    const updated = await prisma.flow.update({
      where: { id: params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(isPublished !== undefined && { isPublished }),
        ...(startMessage !== undefined && { startMessage }),
        ...(endMessage !== undefined && { endMessage }),
        ...(branding !== undefined && { branding: branding as object }),
        ...(videoInterviewTimeoutDays !== undefined && { videoInterviewTimeoutDays }),
        ...(trainingTimeoutDays !== undefined && { trainingTimeoutDays }),
        ...(noShowTimeoutHours !== undefined && { noShowTimeoutHours }),
        ...(schedulingTimeoutHours !== undefined && { schedulingTimeoutHours }),
        ...(backgroundCheckTimeoutDays !== undefined && { backgroundCheckTimeoutDays }),
        ...(pipelineId !== undefined && { pipelineId }),
        ...(canvasLayout !== undefined && { canvasLayout: canvasLayout as object }),
        ...(positionDescription !== undefined && { positionDescription }),
      },
    })

    return NextResponse.json(updated)
  } catch (error) {
    console.error('Update flow error:', error)
    return NextResponse.json({ error: 'Failed to update flow' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const flow = await prisma.flow.findFirst({
    where: {
      id: params.id,
      workspaceId: ws.workspaceId,
    },
  })

  if (!flow) {
    return NextResponse.json({ error: 'Flow not found' }, { status: 404 })
  }

  await prisma.flow.delete({
    where: { id: params.id },
  })

  return NextResponse.json({ success: true })
}
