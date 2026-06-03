import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// `flow_completed` automations are fired by the Prisma `$use` lifecycle
// middleware (src/lib/lifecycle-middleware.ts) when this route writes
// `finishedAt` + `outcome` to Session. Calling `fireAutomations` explicitly
// here was racing the middleware path through `executeStep` (the guard's
// idempotency check only blocks `status='sent'` rows, so two near-simultaneous
// pending rows both pass and both send). Same pattern as the
// `training_completed` race fix in /api/public/trainings/[slug]/progress.

export async function POST(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  try {
    const body = await request.json()
    const { stepId, optionId, optionIds, formData, textAnswer, jumpTo } = body

    // Support progress bar navigation — jump to specific step
    if (jumpTo) {
      await prisma.session.update({ where: { id: params.sessionId }, data: { lastStepId: jumpTo, lastActivityAt: new Date() } })
      return NextResponse.json({ nextStepId: jumpTo })
    }

    // Support both single optionId and array optionIds
    const selectedOptionIds: string[] = optionIds || (optionId ? [optionId] : [])

    if (!stepId) {
      return NextResponse.json({ error: 'stepId is required' }, { status: 400 })
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

    // Get the step to check its question type
    const step = await prisma.flowStep.findUnique({
      where: { id: stepId },
    })

    if (!step) {
      return NextResponse.json({ error: 'Step not found' }, { status: 404 })
    }

    // Save form data to session if provided
    if (formData) {
      const updateData: Record<string, unknown> = { formData, lastActivityAt: new Date() }
      if (formData.name) updateData.candidateName = formData.name
      if (formData.email) updateData.candidateEmail = formData.email
      if (formData.phone) updateData.candidatePhone = formData.phone
      await prisma.session.update({ where: { id: params.sessionId }, data: updateData })
    }

    // For form/info steps, just advance to next step (no options needed)
    if (step.stepType === 'form' || step.stepType === 'info') {
      // Find next step by stepOrder
      const nextStep = await prisma.flowStep.findFirst({
        where: { flowId: session.flowId, stepOrder: { gt: step.stepOrder } },
        orderBy: { stepOrder: 'asc' },
      })
      if (nextStep) {
        await prisma.session.update({ where: { id: params.sessionId }, data: { lastStepId: nextStep.id, lastActivityAt: new Date() } })
        return NextResponse.json({ nextStepId: nextStep.id })
      } else {
        const now = new Date()
        await prisma.session.update({ where: { id: params.sessionId }, data: { finishedAt: now, outcome: 'completed', lastActivityAt: now } })
        return NextResponse.json({ finished: true })
      }
    }

    // For text answer questions, save as submission
    if (step.questionType === 'text' && textAnswer) {
      await prisma.candidateSubmission.upsert({
        where: { sessionId_stepId: { sessionId: params.sessionId, stepId } },
        create: { sessionId: params.sessionId, stepId, textMessage: textAnswer },
        update: { textMessage: textAnswer },
      })
    }

    // For question steps with options
    if (selectedOptionIds.length > 0) {
      // Verify all options belong to the step
      const options = await prisma.stepOption.findMany({
        where: { id: { in: selectedOptionIds }, stepId },
      })
      if (options.length !== selectedOptionIds.length) {
        return NextResponse.json({ error: 'Invalid option(s)' }, { status: 400 })
      }

      // Delete existing answers for this step
      await prisma.sessionAnswer.deleteMany({
        where: { sessionId: params.sessionId, stepId },
      })

      // Create answer(s)
      await prisma.sessionAnswer.createMany({
        data: selectedOptionIds.map((oid) => ({
          sessionId: params.sessionId,
          stepId,
          optionId: oid,
        })),
      })

      // Determine next step
      const firstOption = options[0]
      const nextStepId = firstOption?.nextStepId

      if (nextStepId) {
        await prisma.session.update({ where: { id: params.sessionId }, data: { lastStepId: nextStepId, lastActivityAt: new Date() } })
        return NextResponse.json({ nextStepId })
      }
    }

    // End of flow — find next step by order or finish
    const nextStep = await prisma.flowStep.findFirst({
      where: { flowId: session.flowId, stepOrder: { gt: step.stepOrder } },
      orderBy: { stepOrder: 'asc' },
    })
    if (nextStep) {
      await prisma.session.update({ where: { id: params.sessionId }, data: { lastStepId: nextStep.id, lastActivityAt: new Date() } })
      return NextResponse.json({ nextStepId: nextStep.id })
    }

    // Truly end of flow
    const now = new Date()
    await prisma.session.update({
      where: { id: params.sessionId },
      data: { finishedAt: now, outcome: 'completed', lastActivityAt: now },
    })
    return NextResponse.json({ finished: true })
  } catch (error) {
    console.error('Submit answer error:', error)
    return NextResponse.json({ error: 'Failed to submit answer' }, { status: 500 })
  }
}
