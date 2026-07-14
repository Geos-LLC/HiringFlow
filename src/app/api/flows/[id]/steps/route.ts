import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { validateCaptureConfig } from '@/lib/capture/capture-config'

export async function POST(
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
    const body = await request.json()
    const { title, videoId, questionText, stepType, questionType, formEnabled, formConfig, infoContent, buttonConfig, captureConfig, trainingId, options } = body

    // Validate captureConfig through the Zod schema before persisting. This
    // is the only path that writes the column; the schema's tryParseCaptureConfig
    // protects reads, but writes must be hard-rejected so malformed configs
    // never reach the DB.
    let validatedCaptureConfig: unknown = undefined
    if (captureConfig !== undefined && captureConfig !== null) {
      const parsed = validateCaptureConfig(captureConfig)
      if (!parsed.ok) {
        return NextResponse.json(
          { error: 'Invalid captureConfig', issues: parsed.errors },
          { status: 400 }
        )
      }
      validatedCaptureConfig = parsed.value
    }

    // Validate trainingId belongs to caller's workspace before persisting so
    // a recruiter can't reference a training from another tenant.
    if (trainingId !== undefined && trainingId !== null) {
      const training = await prisma.training.findFirst({
        where: { id: trainingId, workspaceId: ws.workspaceId },
        select: { id: true },
      })
      if (!training) {
        return NextResponse.json({ error: 'Training not found' }, { status: 404 })
      }
    }

    // Get current max step order
    const maxOrder = await prisma.flowStep.aggregate({
      where: { flowId: params.id },
      _max: { stepOrder: true },
    })

    const step = await prisma.flowStep.create({
      data: {
        flowId: params.id,
        title: title || 'New Step',
        videoId: videoId || null,
        questionText: questionText || null,
        stepType: stepType || 'question',
        questionType: questionType || 'single',
        stepOrder: (maxOrder._max.stepOrder ?? -1) + 1,
        ...(formEnabled !== undefined && { formEnabled }),
        ...(formConfig !== undefined && { formConfig }),
        ...(infoContent !== undefined && { infoContent }),
        ...(buttonConfig !== undefined && { buttonConfig }),
        ...(validatedCaptureConfig !== undefined && { captureConfig: validatedCaptureConfig as any }),
        ...(trainingId !== undefined && { trainingId: trainingId || null }),
        // Create answer options if provided
        ...(options && Array.isArray(options) && options.length > 0 && {
          options: {
            create: options.map((opt: string | { text: string; nextStepId?: string | null }) => ({
              optionText: typeof opt === 'string' ? opt : opt.text,
              ...(typeof opt === 'object' && opt.nextStepId ? { nextStepId: opt.nextStepId } : {}),
            })),
          },
        }),
      },
      include: {
        video: true,
        options: true,
      },
    })

    return NextResponse.json(step)
  } catch (error) {
    console.error('Create step error:', error)
    return NextResponse.json({ error: 'Failed to create step' }, { status: 500 })
  }
}
