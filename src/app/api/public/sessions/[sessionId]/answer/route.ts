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
    // Chain-collapse: when the submitted step is part of a combinedWithId
    // chain (e.g., text-Q + audio companion + video companion rendered as
    // one card with 3 answer methods), a single submission from ANY member
    // should advance PAST the entire chain to the tail's exit target — not
    // step through the sibling companions one at a time. Walk forward from
    // the submitted step to find the tail, then read its exit wiring.
    const chainSeen = new Set<string>([step.id])
    let tailStep = step
    let cursor: string | null | undefined = (step as any).combinedWithId
    while (cursor && !chainSeen.has(cursor)) {
      chainSeen.add(cursor)
      const next = await prisma.flowStep.findUnique({ where: { id: cursor } })
      if (!next) break
      tailStep = next
      cursor = (next as any).combinedWithId
    }
    const buttonNextRaw = (tailStep as { buttonConfig?: { nextStepId?: string | null } | null }).buttonConfig?.nextStepId
    const buttonNext = typeof buttonNextRaw === 'string' && buttonNextRaw.length > 0 ? buttonNextRaw : null
    // Legacy wiring: some video/submission steps were built by adding an
    // "option" with nextStepId set to the target, instead of using the
    // buttonConfig.nextStepId (the newer drag-to-connect field). Read the
    // FIRST option with a valid nextStepId (on the TAIL) as an implicit
    // Continue target so those legacy flows still route correctly.
    const stepOptions = await prisma.stepOption.findMany({
      where: { stepId: tailStep.id, nextStepId: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { nextStepId: true },
    })
    const optionContinueTarget = stepOptions.find((o) => o.nextStepId && o.nextStepId.length > 0)?.nextStepId ?? null

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
      // Precedence: explicit override (from a selected option) > buttonConfig
      // (drag-to-connect Continue link) > implicit option-target (legacy
      // wiring on video/submission steps).
      const target = (override && override.length > 0)
        ? override
        : (buttonNext ?? optionContinueTarget)
      if (target === '__end__') return finishSession()
      if (target) return advanceTo(target)
      // Fall back to next by stepOrder, but SKIP the immediate next step
      // if it's a sibling of the current step under a shared fork parent
      // (e.g., stepping off "YES-answer video" shouldn't land on the
      // sibling "NO-answer video"). Walk forward one at a time — each
      // candidate is checked against fork-sibling status independently.
      const allSteps = await prisma.flowStep.findMany({
        where: { flowId: session.flowId },
        select: { id: true, stepOrder: true, buttonConfig: true, options: { select: { nextStepId: true } } },
        orderBy: { stepOrder: 'asc' },
      })
      // Fork-parent lookup: which step(s) route to the tail? Uses tailStep
      // so a submission from any chain member evaluates the fork context
      // of the chain's tail (the semantic "exit" of the combined card).
      // Also skip past every chain member so we don't step through the
      // sibling companions.
      const parentTargets = new Set<string>(chainSeen)
      parentTargets.delete(tailStep.id) // don't skip the tail itself when computing
      for (const x of allSteps) {
        if (x.id === tailStep.id) continue
        const targets: string[] = []
        for (const o of x.options) if (o.nextStepId && o.nextStepId !== '__end__') targets.push(o.nextStepId)
        const btn = (x.buttonConfig as { nextStepId?: string | null } | null)?.nextStepId
        if (btn && btn !== '__end__') targets.push(btn)
        if (targets.includes(tailStep.id)) {
          for (const t of targets) if (t !== tailStep.id) parentTargets.add(t)
        }
      }
      for (const cand of allSteps) {
        // Anchor stepOrder walk at the TAIL so we don't accidentally land
        // on a chain member that sits between the current step and the
        // tail (would repeat the same combined card).
        if (cand.stepOrder <= tailStep.stepOrder) continue
        if (parentTargets.has(cand.id)) continue // sibling branch under same fork OR chain member
        return advanceTo(cand.id)
      }
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

    // Training steps hard-gate on completion. The candidate can hit Continue
    // (or the client-side poller can fire an advance) at any time, but we
    // won't move past this step until TrainingEnrollment.completedAt is
    // written by /api/public/trainings/[slug]/progress. This is the sole
    // enforcement point — the client never bypasses it.
    //
    // Distinguish two "no completedAt" cases:
    //   1. Enrollment exists, completedAt is null → real candidate in
    //      progress. 409 gates advance until they finish.
    //   2. No enrollment row at all → preview mode (startAtSection skips
    //      enrollment creation when preview=true) or a broken state.
    //      Preview stranding was the "Training complete — loading next
    //      step…" bug: markCompleted fires onComplete which POSTs here,
    //      and we'd 409 forever because there's nothing to complete.
    //      Advance in this case so the recruiter can walk through the
    //      flow. Real candidates always have an enrollment by the time
    //      they hit Complete (Start button creates it), so this branch
    //      never strands a real candidate.
    if (step.stepType === 'training') {
      const stepTrainingId = (step as unknown as { trainingId?: string | null }).trainingId ?? null
      if (!stepTrainingId) {
        return advance()
      }
      const enrollment = await prisma.trainingEnrollment.findFirst({
        where: { sessionId: params.sessionId, trainingId: stepTrainingId },
        select: { completedAt: true },
      })
      if (enrollment && !enrollment.completedAt) {
        return NextResponse.json(
          { error: 'Training not completed yet', trainingIncomplete: true },
          { status: 409 }
        )
      }
      return advance()
    }

    // Scheduling steps: same shape as training. Advance requires an
    // InterviewMeeting row for this session + config with cancelledAt=null.
    // Cancelled meetings shouldn't count (matches the FreeBusy fix from
    // 2026-05-30). Missing config = misconfigured, don't strand the candidate.
    if (step.stepType === 'scheduling') {
      const stepSchedulingConfigId = (step as unknown as { schedulingConfigId?: string | null }).schedulingConfigId ?? null
      if (!stepSchedulingConfigId) {
        return advance()
      }
      const meeting = await prisma.interviewMeeting.findFirst({
        where: {
          sessionId: params.sessionId,
          schedulingConfigId: stepSchedulingConfigId,
          cancelledAt: null,
        },
        select: { id: true },
      })
      if (!meeting) {
        return NextResponse.json(
          { error: 'Meeting not booked yet', schedulingIncomplete: true },
          { status: 409 }
        )
      }
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
