import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getVideoUrl } from '@/lib/storage'
import { validateCaptureConfig } from '@/lib/capture/capture-config'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { stepId: string } }
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const step = await prisma.flowStep.findFirst({
    where: { id: params.stepId },
    include: {
      flow: true,
    },
  })

  if (!step || step.flow.workspaceId !== ws.workspaceId) {
    return NextResponse.json({ error: 'Step not found' }, { status: 404 })
  }

  try {
    const body = await request.json()
    const { title, videoId, questionText, stepOrder, stepType, questionType, formEnabled, formConfig, infoContent, buttonConfig, combinedWithId, captionsEnabled, captionStyle, captureConfig, trainingId, schedulingConfigId } = body

    // Validate captureConfig before write. Allow null to explicitly clear.
    let captureConfigPatch: { captureConfig: unknown } | null = null
    if (captureConfig !== undefined) {
      if (captureConfig === null) {
        captureConfigPatch = { captureConfig: null }
      } else {
        const parsed = validateCaptureConfig(captureConfig)
        if (!parsed.ok) {
          return NextResponse.json(
            { error: 'Invalid captureConfig', issues: parsed.errors },
            { status: 400 }
          )
        }
        captureConfigPatch = { captureConfig: parsed.value }
      }
    }

    // Validate trainingId belongs to caller's workspace. Allow null to
    // explicitly clear (recruiter unlinks the training from the step).
    if (trainingId !== undefined && trainingId !== null) {
      const training = await prisma.training.findFirst({
        where: { id: trainingId, workspaceId: ws.workspaceId },
        select: { id: true },
      })
      if (!training) {
        return NextResponse.json({ error: 'Training not found' }, { status: 404 })
      }
    }

    // Same workspace-scope check for schedulingConfigId.
    if (schedulingConfigId !== undefined && schedulingConfigId !== null) {
      const config = await prisma.schedulingConfig.findFirst({
        where: { id: schedulingConfigId, workspaceId: ws.workspaceId },
        select: { id: true },
      })
      if (!config) {
        return NextResponse.json({ error: 'Scheduling config not found' }, { status: 404 })
      }
    }

    const updated = await prisma.flowStep.update({
      where: { id: params.stepId },
      data: {
        ...(title !== undefined && { title }),
        ...(videoId !== undefined && { videoId: videoId || null }),
        ...(questionText !== undefined && { questionText: questionText || null }),
        ...(stepOrder !== undefined && { stepOrder }),
        ...(stepType !== undefined && { stepType }),
        ...(questionType !== undefined && { questionType }),
        ...(formEnabled !== undefined && { formEnabled }),
        ...(formConfig !== undefined && { formConfig }),
        ...(infoContent !== undefined && { infoContent }),
        ...(buttonConfig !== undefined && { buttonConfig }),
        ...(combinedWithId !== undefined && { combinedWithId: combinedWithId || null }),
        ...(captionsEnabled !== undefined && { captionsEnabled }),
        ...(captionStyle !== undefined && { captionStyle }),
        ...(captureConfigPatch !== null && { captureConfig: captureConfigPatch.captureConfig as any }),
        ...(trainingId !== undefined && { trainingId: trainingId || null }),
        ...(schedulingConfigId !== undefined && { schedulingConfigId: schedulingConfigId || null }),
      },
      include: {
        video: true,
        options: true,
      },
    })

    return NextResponse.json({
      ...updated,
      video: updated.video
        ? {
            ...updated.video,
            url: getVideoUrl(updated.video.storageKey),
          }
        : null,
    })
  } catch (error) {
    console.error('Update step error:', error)
    return NextResponse.json({ error: 'Failed to update step' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { stepId: string } }
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const step = await prisma.flowStep.findFirst({
    where: { id: params.stepId },
    include: {
      flow: true,
    },
  })

  if (!step || step.flow.workspaceId !== ws.workspaceId) {
    return NextResponse.json({ error: 'Step not found' }, { status: 404 })
  }

  await prisma.flowStep.delete({
    where: { id: params.stepId },
  })

  return NextResponse.json({ success: true })
}
