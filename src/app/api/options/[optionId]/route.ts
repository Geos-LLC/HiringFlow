import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { optionId: string } }
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const option = await prisma.stepOption.findFirst({
    where: { id: params.optionId },
    include: {
      step: {
        include: {
          flow: true,
        },
      },
    },
  })

  if (!option || option.step.flow.workspaceId !== ws.workspaceId) {
    return NextResponse.json({ error: 'Option not found' }, { status: 404 })
  }

  try {
    const body = await request.json()
    const { optionText, nextStepId } = body

    // If nextStepId is provided, verify it belongs to the same flow
    if (nextStepId) {
      const nextStep = await prisma.flowStep.findFirst({
        where: {
          id: nextStepId,
          flowId: option.step.flowId,
        },
      })

      if (!nextStep) {
        return NextResponse.json(
          { error: 'Next step must be in the same flow' },
          { status: 400 }
        )
      }
    }

    const updated = await prisma.stepOption.update({
      where: { id: params.optionId },
      data: {
        ...(optionText !== undefined && { optionText }),
        ...(nextStepId !== undefined && { nextStepId: nextStepId || null }),
      },
    })

    return NextResponse.json(updated)
  } catch (error) {
    console.error('Update option error:', error)
    return NextResponse.json({ error: 'Failed to update option' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { optionId: string } }
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const option = await prisma.stepOption.findFirst({
    where: { id: params.optionId },
    include: {
      step: {
        include: {
          flow: true,
        },
      },
    },
  })

  if (!option || option.step.flow.workspaceId !== ws.workspaceId) {
    return NextResponse.json({ error: 'Option not found' }, { status: 404 })
  }

  await prisma.stepOption.delete({
    where: { id: params.optionId },
  })

  return NextResponse.json({ success: true })
}
