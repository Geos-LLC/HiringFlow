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

    // Branch-aware "advance" helper. Routing precedence:
    //   1. explicit override (e.g. firstOption.nextStepId)
    //   2. step.buttonConfig.nextStepId — the drag-to-connect link the
    //      flow builder writes onto video/info/form/submission steps so a
    //      branch leaf can specify its own next hop (or '__end__'). Without
    //      this, leaves fell through to `stepOrder + 1` and yes-branch
    //      candidates flowed into the no-branch's first step.
    //   3. next step by stepOrder
    //   4. finish session
    const buttonNextRaw = (step as { buttonConfig?: { nextStepId?: string | null } | null }).buttonConfig?.nextStepId
    const buttonNext = typeof buttonNextRaw === 'string' && buttonNextRaw.length > 0 ? buttonNextRaw : null

    const finishSession = async () => {
      const now = new Date()
      await prisma.session.update({
        where: { id: params.sessionId },
        data: { finishedAt: now, outcome: 'completed', lastActivityAt: now, lastProgressAt: now },
      })
      return NextResponse.json({ finished: true })
    }
    const advanceTo = async (nextStepId: string) => {
      const now = new Date()
      await prisma.session.update({
        where: { id: params.sessionId },
        data: { lastStepId: nextStepId, lastActivityAt: now, lastProgressAt: now },
      })
      return NextResponse.json({ nextStepId })
    }
    const advance = async (override?: string | null): Promise<NextResponse> => {
      const target = (override && override.length > 0) ? override : buttonNext
      if (target === '__end__') return finishSession()
      if (target) return advanceTo(target)
      const nextStep = await prisma.flowStep.findFirst({
        where: { flowId: session.flowId, stepOrder: { gt: step.stepOrder } },
        orderBy: { stepOrder: 'asc' },
      })
      if (nextStep) return advanceTo(nextStep.id)
      return finishSession()
    }

    // Save form data to session if provided
    if (formData) {
      const now = new Date()
      const updateData: Record<string, unknown> = { formData, lastActivityAt: now, lastProgressAt: now }
      if (formData.name) updateData.candidateName = formData.name
      if (formData.email) updateData.candidateEmail = formData.email
      if (formData.phone) updateData.candidatePhone = formData.phone
      await prisma.session.update({ where: { id: params.sessionId }, data: updateData })
    }

    // For form/info steps, just advance to next step (no options needed).
    // advance() honors buttonConfig.nextStepId so branch leaves don't fall
    // through into the sibling branch.
    if (step.stepType === 'form' || step.stepType === 'info') {
      return advance()
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

      // Determine next step: the chosen option's nextStepId wins (the fork);
      // otherwise fall back to buttonConfig and then stepOrder.
      const firstOption = options[0]
      return advance(firstOption?.nextStepId ?? null)
    }

    // Video/submission steps and any other non-question advance: route via
    // buttonConfig.nextStepId (the schema-view drag-to-connect link) first,
    // then stepOrder + 1, then finish.
    return advance()
  } catch (error) {
    console.error('Submit answer error:', error)
    return NextResponse.json({ error: 'Failed to submit answer' }, { status: 500 })
  }
}
