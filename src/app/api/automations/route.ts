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

function validateSteps(steps: unknown): { ok: true; steps: Required<Pick<StepInput, 'channel'>> & StepInput[] | StepInput[] } | { ok: false; error: string } {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: 'At least one step is required' }
  }
  const normalized: StepInput[] = []
  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i] as StepInput
    if (!raw || typeof raw !== 'object') return { ok: false, error: `Step ${i + 1} is malformed` }
    const channel: 'email' | 'sms' | 'both' = raw.channel === 'sms' ? 'sms' : raw.channel === 'both' ? 'both' : 'email'
    const wantsEmail = channel === 'email' || channel === 'both'
    const wantsSms = channel === 'sms' || channel === 'both'
    if (wantsEmail && !raw.emailTemplateId) return { ok: false, error: `Step ${i + 1}: email channel requires an email template` }
    // SMS step is valid if it has either a saved-template id OR an inline body.
    // The template wins at send time; smsBody serves as a fallback for legacy
    // rows and one-off bodies typed in the editor without saving as a template.
    const hasSmsTemplate = !!raw.smsTemplateId
    const hasSmsBody = !!(raw.smsBody && raw.smsBody.trim().length > 0)
    if (wantsSms && !hasSmsTemplate && !hasSmsBody) {
      return { ok: false, error: `Step ${i + 1}: SMS channel requires a template or body` }
    }
    const delayMinutes = Number.isFinite(raw.delayMinutes) ? Math.max(0, Math.floor(raw.delayMinutes as number)) : 0
    normalized.push({
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
  return { ok: true, steps: normalized }
}

export async function GET(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  // Optional ?pipelineId= filter for the automations page picker. Empty
  // string / unset = "all pipelines"; explicit "null" = "workspace-wide
  // rules only" (pipelineId IS NULL).
  const pipelineId = request.nextUrl.searchParams.get('pipelineId')
  const where: Record<string, unknown> = {
    workspaceId: ws.workspaceId,
    // Exclude the synthetic per-workspace rule that owns Recruiter bulk
    // email executions (src/app/api/candidates/bulk-email). It's not a
    // user-managed automation — only its child executions matter, and
    // those still surface on candidate timelines.
    triggerType: { not: 'manual_bulk' },
  }
  if (pipelineId === 'null') {
    where.pipelineId = null
  } else if (pipelineId) {
    where.pipelineId = pipelineId
  }
  const rules = await prisma.automationRule.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      // Multi-flow scope. Empty array = workspace-wide (fires for every
      // flow); non-empty = restricted to those flows. Replaces the legacy
      // single-`flow` relation for reads.
      flows: {
        include: { flow: { select: { id: true, name: true } } },
      },
      pipeline: { select: { id: true, name: true, isDefault: true } },
      // Legacy per-rule fields kept for backwards compatibility with table
      // rendering during rollout. New code reads from `steps`.
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
      _count: { select: { executions: true } },
    },
  })
  return NextResponse.json(rules)
}

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const body = await request.json()
  const { name, triggerType, stageId, pipelineId, triggerAutomationId, minutesBefore, waitForRecording, steps } = body
  // Multi-flow scope. Empty / omitted = workspace-wide. Older clients may
  // still send `flowId` (single string); coerce to a single-item array so
  // existing form submissions don't regress. Prefer `flowIds` on new writes.
  const rawFlowIds: unknown = body.flowIds
  const legacyFlowId: unknown = body.flowId
  let flowIds: string[] = []
  if (Array.isArray(rawFlowIds)) {
    flowIds = rawFlowIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
  } else if (typeof legacyFlowId === 'string' && legacyFlowId) {
    flowIds = [legacyFlowId]
  }
  // Rule-level trainingId scopes which training a `training_*` rule fires for
  // ("Onboarding only" vs "any training"). Distinct from step.trainingId,
  // which is the action target (which training to send the candidate to).
  // Only meaningful for training_started / training_completed; ignored
  // server-side for other triggers but persisted as-is so the editor can
  // round-trip without surprising the recruiter.
  const triggerTrainingId: string | null =
    typeof body.trainingId === 'string' && body.trainingId ? body.trainingId : null
  if (!name || !triggerType) return NextResponse.json({ error: 'name and triggerType required' }, { status: 400 })

  // Pipeline scope: optional. Null/empty = "any pipeline" (back-compat).
  // Any non-null value must reference a pipeline owned by the caller's
  // workspace so we don't leak tenant boundaries.
  let resolvedPipelineId: string | null = null
  if (pipelineId !== undefined && pipelineId !== null && pipelineId !== '') {
    const pipeline = await prisma.pipeline.findFirst({
      where: { id: pipelineId, workspaceId: ws.workspaceId },
      select: { id: true },
    })
    if (!pipeline) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })
    resolvedPipelineId = pipeline.id
  }

  // Flow scope: every id in flowIds must reference a flow the caller owns.
  // Cross-tenant ids would let one workspace hijack another workspace's
  // dispatch. Empty set stays empty = workspace-wide.
  if (flowIds.length > 0) {
    const owned = await prisma.flow.findMany({
      where: { id: { in: flowIds }, workspaceId: ws.workspaceId },
      select: { id: true },
    })
    if (owned.length !== flowIds.length) {
      return NextResponse.json({ error: 'One or more flowIds not found in workspace' }, { status: 400 })
    }
  }

  // Steps are the canonical send config now. Reject if missing.
  const validation = validateSteps(steps)
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 })
  const stepInputs = validation.steps as StepInput[]

  if (triggerType === 'before_meeting' && (!Number.isInteger(minutesBefore) || minutesBefore <= 0)) {
    return NextResponse.json({ error: 'before_meeting rules need minutesBefore (positive integer)' }, { status: 400 })
  }

  // stage_entered rules MUST pin to a specific (pipeline, stage). Without
  // both, fireStageEnteredAutomations can never match the rule — so reject
  // at the API boundary rather than persisting a rule that can never fire.
  // We also verify the stage exists in the pipeline's normalized stages so
  // a typo doesn't make it through to the DB.
  if (triggerType === 'stage_entered') {
    if (!resolvedPipelineId) {
      return NextResponse.json({ error: 'stage_entered rules require a pipeline' }, { status: 400 })
    }
    if (typeof stageId !== 'string' || !stageId) {
      return NextResponse.json({ error: 'stage_entered rules require a stageId' }, { status: 400 })
    }
    const { normalizeStages } = await import('@/lib/funnel-stages')
    const pipelineRow = await prisma.pipeline.findUnique({
      where: { id: resolvedPipelineId },
      select: { stages: true },
    })
    const stageIds = new Set(normalizeStages(pipelineRow?.stages).map((s) => s.id))
    if (!stageIds.has(stageId)) {
      return NextResponse.json({ error: `stageId "${stageId}" is not a stage in the selected pipeline` }, { status: 400 })
    }
  }

  // For any step that points to a training, switch the training to invitation_only
  const trainingIdsToGate = stepInputs
    .filter((s) => s.nextStepType === 'training' && s.trainingId)
    .map((s) => s.trainingId as string)
  if (trainingIdsToGate.length > 0) {
    await prisma.training.updateMany({
      where: { id: { in: trainingIdsToGate }, workspaceId: ws.workspaceId },
      data: { accessMode: 'invitation_only' },
    })
  }

  // Mirror the first step's channel/template/sms/destination/nextStep onto the
  // rule's legacy columns so any read path that hasn't been migrated still
  // sees consistent data. Source of truth for the executor is the step rows.
  const firstStep = stepInputs[0]

  const rule = await prisma.automationRule.create({
    data: {
      workspaceId: ws.workspaceId, createdById: ws.userId, name, triggerType,
      // Legacy single-flow column kept in sync while the join table becomes
      // the source of truth: mirror flows[0] when exactly one flow is
      // scoped, else null. Lets a rollback to pre-join code still resolve
      // the intended flow scope for single-flow rules. Multi-flow rules
      // become workspace-wide under rollback (over-fire, not silent break).
      flowId: flowIds.length === 1 ? flowIds[0] : null,
      flows: flowIds.length > 0 ? { create: flowIds.map((fid) => ({ flowId: fid })) } : undefined,
      pipelineId: resolvedPipelineId,
      stageId: typeof stageId === 'string' && stageId ? stageId : null,
      triggerAutomationId: triggerAutomationId || null,
      channel: firstStep.channel === 'both' ? 'email' : firstStep.channel ?? 'email',
      emailTemplateId: firstStep.emailTemplateId ?? null,
      smsBody: firstStep.smsBody ?? null,
      nextStepType: firstStep.nextStepType ?? null,
      nextStepUrl: firstStep.nextStepUrl ?? null,
      trainingId: triggerTrainingId,
      schedulingConfigId: firstStep.schedulingConfigId ?? null,
      delayMinutes: firstStep.delayMinutes ?? 0,
      minutesBefore: triggerType === 'before_meeting' ? (minutesBefore as number) : null,
      waitForRecording: triggerType === 'meeting_ended' ? !!waitForRecording : false,
      emailDestination: firstStep.emailDestination ?? 'applicant',
      emailDestinationAddress: firstStep.emailDestinationAddress ?? null,
      steps: {
        create: stepInputs.map((s, i) => ({
          order: i,
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
        })),
      },
    },
    include: {
      flows: { include: { flow: { select: { id: true, name: true } } } },
      emailTemplate: { select: { id: true, name: true } },
      training: { select: { id: true, title: true, slug: true } },
      schedulingConfig: { select: { id: true, name: true, schedulingUrl: true } },
      steps: { orderBy: { order: 'asc' } },
    },
  })

  // Auto-apply to existing upcoming meetings (no-op for non-meeting triggers).
  // Past meetings are not touched.
  await autoBackfillRuleForUpcomingMeetings(rule.id).catch((err) => {
    console.error('[automations] auto-backfill on create failed:', err)
  })

  return NextResponse.json(rule)
}
