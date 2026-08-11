import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { optionId: string } }
) {
  logger.info('flow_schema_option_patch_start', { optionId: params.optionId })
  const ws = await getWorkspaceSession()
  if (!ws) {
    logger.warn('flow_schema_option_patch_unauthorized', { optionId: params.optionId })
    return unauthorized()
  }

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
    logger.warn('flow_schema_option_patch_not_found', {
      optionId: params.optionId,
      workspaceId: ws.workspaceId,
      optionExists: !!option,
      optionWorkspaceId: option?.step.flow.workspaceId,
    })
    return NextResponse.json({ error: 'Option not found' }, { status: 404 })
  }

  try {
    const body = await request.json()
    const { optionText, nextStepId } = body
    logger.info('flow_schema_option_patch_body', {
      optionId: params.optionId,
      workspaceId: ws.workspaceId,
      flowId: option.step.flowId,
      priorNextStepId: option.nextStepId,
      nextStepIdSet: nextStepId !== undefined,
      newNextStepId: nextStepId ?? null,
      optionTextSet: optionText !== undefined,
    })

    // If nextStepId is provided, verify it belongs to the same flow
    if (nextStepId) {
      const nextStep = await prisma.flowStep.findFirst({
        where: {
          id: nextStepId,
          flowId: option.step.flowId,
        },
      })

      if (!nextStep) {
        logger.warn('flow_schema_option_patch_next_step_mismatch', {
          optionId: params.optionId,
          nextStepId,
          flowId: option.step.flowId,
        })
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

    logger.info('flow_schema_option_patch_ok', {
      optionId: params.optionId,
      newNextStepId: updated.nextStepId,
    })
    return NextResponse.json(updated)
  } catch (error) {
    logger.error('flow_schema_option_patch_failed', {
      optionId: params.optionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Failed to update option' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { optionId: string } }
) {
  logger.info('flow_schema_option_delete_start', { optionId: params.optionId })
  const ws = await getWorkspaceSession()
  if (!ws) {
    logger.warn('flow_schema_option_delete_unauthorized', { optionId: params.optionId })
    return unauthorized()
  }

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
    logger.warn('flow_schema_option_delete_not_found', {
      optionId: params.optionId,
      workspaceId: ws.workspaceId,
      optionExists: !!option,
      optionWorkspaceId: option?.step.flow.workspaceId,
    })
    return NextResponse.json({ error: 'Option not found' }, { status: 404 })
  }

  try {
    await prisma.stepOption.delete({
      where: { id: params.optionId },
    })
    logger.info('flow_schema_option_delete_ok', { optionId: params.optionId })
    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error('flow_schema_option_delete_failed', {
      optionId: params.optionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Failed to delete option' }, { status: 500 })
  }
}
