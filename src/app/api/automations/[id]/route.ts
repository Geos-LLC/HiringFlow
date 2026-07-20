import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { autoBackfillRuleForUpcomingMeetings } from '@/lib/automation'

interface StepInput {
  order?: number
  delayMinutes?: number
  timingMode?: 'trigger' | 'before_meeting' | 'after_meeting'
  channel?: 'email' | 'sms' | 'both'
  emailTemplateId?: string | null
  smsTemplateId?: string | null
  smsBody?: string | null
  emailDestination?: 'applicant' | 'company' | 'specific'
  emailDestinationAddress?: string | null
  smsDestination?: 'applicant' | 'company' | 'specific'
  smsDestinationNumber?: string | null
  nextStepType?: string | null
  nextStepUrl?: string | null
  trainingId?: string | null
  schedulingConfigId?: string | null
}

function validateSteps(steps: unknown): { ok: true; steps: StepInput[] } | { ok: false; error: string } {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: 'At least one step is required' }
  }
  const out: StepInput[] = []
  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i] as StepInput
    if (!raw || typeof raw !== 'object') return { ok: false, error: `Step ${i + 1} is malformed` }
    const channel: 'email' | 'sms' | 'both' = raw.channel === 'sms' ? 'sms' : raw.channel === 'both' ? 'both' : 'email'
    const wantsEmail = channel === 'email' || channel === 'both'
    const wantsSms = channel === 'sms' || channel === 'both'
    if (wantsEmail && !raw.emailTemplateId) return { ok: false, error: `Step ${i + 1}: email channel requires an email template` }
    const hasSmsTemplate = !!raw.smsTemplateId
    const hasSmsBody = !!(raw.smsBody && raw.smsBody.trim().length > 0)
    if (wantsSms && !hasSmsTemplate && !hasSmsBody) {
      return { ok: false, error: `Step ${i + 1}: SMS channel requires a template or body` }
    }
    const delayMinutes = Number.isFinite(raw.delayMinutes) ? Math.max(0, Math.floor(raw.delayMinutes as number)) : 0
    out.push({
      order: i,
      delayMinutes,
      timingMode: (raw.timingMode === 'before_meeting' || raw.timingMode === 'after_meeting') ? raw.timingMode : 'trigger',
      channel,
      emailTemplateId: wantsEmail ? raw.emailTemplateId ?? null : null,
      smsTemplateId: wantsSms ? raw.smsTemplateId ?? null : null,
      smsBody: wantsSms ? raw.smsBody ?? null : null,
      emailDestination: raw.emailDestination ?? 'applicant',
      emailDestinationAddress: raw.emailDestination === 'specific' ? (raw.emailDestinationAddress || null) : null,
      smsDestination: raw.smsDestination ?? 'applicant',
      smsDestinationNumber: raw.smsDestination === 'specific' ? (raw.smsDestinationNumber || null) : null,
      nextStepType: raw.nextStepType || null,
      nextStepUrl: raw.nextStepUrl || null,
      trainingId: raw.trainingId || null,
      schedulingConfigId: raw.schedulingConfigId || null,
    })
  }
  return { ok: true, steps: out }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const rule = await prisma.automationRule.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await request.json()

  // Flow scope update: caller may pass `flowIds: string[]` to replace the
  // rule's flow scope, or omit the field to leave it untouched. Empty array
  // = workspace-wide (fires for every flow). Legacy `flowId` (single string)
  // is accepted for older clients — coerced to a single-item array.
  let flowIdsUpdate: string[] | null = null
  if (Array.isArray(body.flowIds)) {
    flowIdsUpdate = (body.flowIds as unknown[]).filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    )
  } else if (body.flowId !== undefined) {
    flowIdsUpdate = typeof body.flowId === 'string' && body.flowId ? [body.flowId] : []
  }
  if (flowIdsUpdate && flowIdsUpdate.length > 0) {
    const owned = await prisma.flow.findMany({
      where: { id: { in: flowIdsUpdate }, workspaceId: ws.workspaceId },
      select: { id: true },
    })
    if (owned.length !== flowIdsUpdate.length) {
      return NextResponse.json({ error: 'One or more flowIds not found in workspace' }, { status: 400 })
    }
  }

  // Pipeline scope (added 2026-05-13). Null/empty = "any pipeline"
  // (workspace-wide rule). Non-null values must reference a pipeline in
  // this workspace — guard the FK lookup against cross-tenant assignment.
  let pipelineUpdate: { pipelineId: string | null } | null = null
  if (body.pipelineId !== undefined) {
    if (body.pipelineId === null || body.pipelineId === '') {
      pipelineUpdate = { pipelineId: null }
    } else if (typeof body.pipelineId === 'string') {
      const pipeline = await prisma.pipeline.findFirst({
        where: { id: body.pipelineId, workspaceId: ws.workspaceId },
        select: { id: true },
      })
      if (!pipeline) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })
      pipelineUpdate = { pipelineId: pipeline.id }
    }
  }

  // If `steps` was sent, replace the rule's full step set. We don't try to
  // diff per-step in the API — the editor always submits the whole sequence.
  // Pending QStash messages keyed off the OLD step IDs become orphans; the
  // executor's "step not found" branch turns them into no-ops.
  let validatedSteps: StepInput[] | null = null
  if (body.steps !== undefined) {
    const v = validateSteps(body.steps)
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
    validatedSteps = v.steps
  }

  // stage_entered validation — applied to the EFFECTIVE post-update values
  // (body overrides existing). Mirrors the POST handler so a PATCH cannot
  // leave a rule in a state the create endpoint would have rejected.
  const effectiveTrigger = typeof body.triggerType === 'string' ? body.triggerType : rule.triggerType
  if (effectiveTrigger === 'stage_entered') {
    const effectivePipelineId = pipelineUpdate ? pipelineUpdate.pipelineId : rule.pipelineId
    const effectiveStageId = typeof body.stageId === 'string' && body.stageId
      ? body.stageId
      : (body.stageId === null || body.stageId === '' ? null : rule.stageId)
    if (!effectivePipelineId) {
      return NextResponse.json({ error: 'stage_entered rules require a pipeline' }, { status: 400 })
    }
    if (!effectiveStageId) {
      return NextResponse.json({ error: 'stage_entered rules require a stageId' }, { status: 400 })
    }
    const { normalizeStages } = await import('@/lib/funnel-stages')
    const pipelineRow = await prisma.pipeline.findUnique({
      where: { id: effectivePipelineId },
      select: { stages: true },
    })
    const stageIds = new Set(normalizeStages(pipelineRow?.stages).map((s) => s.id))
    if (!stageIds.has(effectiveStageId)) {
      return NextResponse.json({ error: `stageId "${effectiveStageId}" is not a stage in the selected pipeline` }, { status: 400 })
    }
  }

  // For any step that points to a training, switch the training to invitation_only
  if (validatedSteps) {
    const trainingIds = validatedSteps
      .filter((s) => s.nextStepType === 'training' && s.trainingId)
      .map((s) => s.trainingId as string)
    if (trainingIds.length > 0) {
      await prisma.training.updateMany({
        where: { id: { in: trainingIds }, workspaceId: ws.workspaceId },
        data: { accessMode: 'invitation_only' },
      })
    }
  }

  // Apply rule-level fields + (optionally) replace steps in a single transaction.
  await prisma.$transaction(async (tx) => {
    const firstStep = validatedSteps?.[0]
    await tx.automationRule.update({
      where: { id: params.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.triggerType !== undefined && { triggerType: body.triggerType }),
        // Legacy single-flow column: keep in sync with the join. Mirror
        // flows[0] when the new scope is a single flow, else null.
        // Multi-flow scopes clear the legacy column (rollback would treat
        // them as workspace-wide — over-fire, not silent break).
        ...(flowIdsUpdate !== null && {
          flowId: flowIdsUpdate.length === 1 ? flowIdsUpdate[0] : null,
        }),
        ...(pipelineUpdate && pipelineUpdate),
        // trainingId is the trigger filter for training_* rules (which
        // training fires this rule). Independent from step.trainingId
        // (the action target). Persisted regardless of trigger so the
        // editor round-trips cleanly; only the dispatcher reads it, and
        // only for training-* triggers.
        ...(body.trainingId !== undefined && {
          trainingId: typeof body.trainingId === 'string' && body.trainingId ? body.trainingId : null,
        }),
        ...(body.stageId !== undefined && {
          stageId: typeof body.stageId === 'string' && body.stageId ? body.stageId : null,
        }),
        ...(body.triggerAutomationId !== undefined && { triggerAutomationId: body.triggerAutomationId || null }),
        ...(body.minutesBefore !== undefined && {
          minutesBefore: Number.isInteger(body.minutesBefore) && body.minutesBefore > 0 ? body.minutesBefore : null,
        }),
        ...(body.waitForRecording !== undefined && { waitForRecording: !!body.waitForRecording }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        // Mirror the first step's send config onto the legacy rule columns so
        // any read path not yet on `steps` keeps working until the columns
        // are dropped in a follow-up PR.
        ...(firstStep && {
          channel: firstStep.channel === 'both' ? 'email' : firstStep.channel ?? 'email',
          emailTemplateId: firstStep.emailTemplateId ?? null,
          smsBody: firstStep.smsBody ?? null,
          nextStepType: firstStep.nextStepType ?? null,
          nextStepUrl: firstStep.nextStepUrl ?? null,
          schedulingConfigId: firstStep.schedulingConfigId ?? null,
          delayMinutes: firstStep.delayMinutes ?? 0,
          emailDestination: firstStep.emailDestination ?? 'applicant',
          emailDestinationAddress: firstStep.emailDestinationAddress ?? null,
        }),
      },
    })
    if (flowIdsUpdate !== null) {
      // Replace the rule's flow scope wholesale. Wipe-and-recreate is safe
      // here — the join rows carry no downstream references (unlike
      // AutomationStep, which is upserted by order to preserve step ids for
      // AutomationExecution history).
      await tx.automationRuleFlow.deleteMany({ where: { ruleId: params.id } })
      if (flowIdsUpdate.length > 0) {
        await tx.automationRuleFlow.createMany({
          data: flowIdsUpdate.map((fid) => ({ ruleId: params.id, flowId: fid })),
        })
      }
    }
    if (validatedSteps) {
      // Upsert-by-order rather than wipe-and-recreate: preserves stepIds for
      // existing positions so AutomationExecution rows linked to those steps
      // keep their stepId (and therefore their full history). Only steps at
      // tail orders that no longer exist in the input get deleted; the
      // schema's onDelete: SetNull on AutomationExecution.step ensures any
      // such delete doesn't cascade away execution rows either.
      const existingSteps = await tx.automationStep.findMany({
        where: { ruleId: params.id },
        orderBy: { order: 'asc' },
        select: { id: true, order: true },
      })
      const existingByOrder = new Map(existingSteps.map((s) => [s.order, s.id]))
      for (let i = 0; i < validatedSteps.length; i++) {
        const s = validatedSteps[i]
        const stepData = {
          delayMinutes: s.delayMinutes ?? 0,
          timingMode: s.timingMode ?? 'trigger',
          channel: s.channel ?? 'email',
          emailTemplateId: s.emailTemplateId ?? null,
          smsTemplateId: s.smsTemplateId ?? null,
          smsBody: s.smsBody ?? null,
          emailDestination: s.emailDestination ?? 'applicant',
          emailDestinationAddress: s.emailDestinationAddress ?? null,
          smsDestination: s.smsDestination ?? 'applicant',
          smsDestinationNumber: s.smsDestinationNumber ?? null,
          nextStepType: s.nextStepType ?? null,
          nextStepUrl: s.nextStepUrl ?? null,
          trainingId: s.trainingId ?? null,
          schedulingConfigId: s.schedulingConfigId ?? null,
        }
        const existingId = existingByOrder.get(i)
        if (existingId) {
          await tx.automationStep.update({ where: { id: existingId }, data: stepData })
        } else {
          await tx.automationStep.create({
            data: { ruleId: params.id, order: i, ...stepData },
          })
        }
      }
      // Delete any tail steps the recruiter removed.
      const ordersToKeep = validatedSteps.map((_, i) => i)
      await tx.automationStep.deleteMany({
        where: { ruleId: params.id, order: { notIn: ordersToKeep } },
      })
    }
  })

  const updated = await prisma.automationRule.findUnique({
    where: { id: params.id },
    include: {
      flows: { include: { flow: { select: { id: true, name: true } } } },
      pipeline: { select: { id: true, name: true, isDefault: true } },
      emailTemplate: { select: { id: true, name: true, subject: true } },
      training: { select: { id: true, title: true, slug: true } },
      schedulingConfig: { select: { id: true, name: true, schedulingUrl: true } },
      steps: {
        orderBy: { order: 'asc' },
        include: {
          emailTemplate: { select: { id: true, name: true, subject: true } },
          smsTemplate: { select: { id: true, name: true, body: true } },
          training: { select: { id: true, title: true, slug: true } },
          schedulingConfig: { select: { id: true, name: true, schedulingUrl: true } },
        },
      },
    },
  })

  // Auto-apply to existing upcoming meetings (no-op for non-meeting triggers).
  // Cancels any pending executions for this rule first so old QStash jobs
  // from a prior step config don't fire alongside the new ones.
  await autoBackfillRuleForUpcomingMeetings(params.id).catch((err) => {
    console.error('[automations] auto-backfill on update failed:', err)
  })

  return NextResponse.json(updated)
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const rule = await prisma.automationRule.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await prisma.automationRule.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
