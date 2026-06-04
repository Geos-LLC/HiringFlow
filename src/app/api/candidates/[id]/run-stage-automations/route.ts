import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized, forbidden } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { dispatchRule } from '@/lib/automation'
import { type StageTriggerEvent } from '@/lib/funnel-stages'
import { resolvePipelineForFlow, stagesFor } from '@/lib/pipelines'
import { pipelineScopeFragment } from '@/lib/automation-pipeline-scope'

// Workspace roles authorised to issue manual reruns. Manual reruns can create
// real-world sends (emails, SMS, Certn orders) and are billed; they are a
// privileged operation and a plain workspace member should not be able to
// re-fire automations against a candidate. Super admins are always allowed.
const RERUN_ADMIN_ROLES = new Set(['admin', 'owner'])

// Manually fire all automations attached (via funnel-stage triggers) to a
// given stage, for one candidate. Each stage has zero or more StageTriggers
// (event + optional targetId). For every trigger event we find active
// AutomationRules that share the same triggerType and either match the
// candidate's flowId or have no flow filter, then dispatch them through
// the SAME path a real trigger uses — `dispatchRule` queues each step at
// its own `delayMinutes` via QStash, so a rule with step 0 at +2m and
// step 1 at +3d behaves exactly like a real flow_completed event: first
// email lands in 2 minutes, follow-up lands in 3 days. NOT both at once.
//
// Pre-fix (commit ef0f230, since reverted in this endpoint): we called
// executeRule which iterates every step inline ignoring delays — that
// sent 2 emails to the same candidate within ~200ms of each other.
//
// GET returns the same matched-rule list without firing, so the UI can show
// a count / button-enabled state.

interface MatchedRule {
  id: string
  name: string
  triggerType: string
  isActive: boolean
}

async function findMatchingRules(opts: {
  workspaceId: string
  stageId: string
  flowId: string
}): Promise<{ stageExists: boolean; events: StageTriggerEvent[]; rules: MatchedRule[] }> {
  // Stages live on the flow's pipeline now. Workspaces with no pipeline yet
  // get one created on the fly from their legacy Workspace.settings.funnelStages.
  const pipeline = await resolvePipelineForFlow({
    flowId: opts.flowId,
    workspaceId: opts.workspaceId,
  })
  const stages = stagesFor(pipeline)
  const stage = stages.find((s) => s.id === opts.stageId)
  if (!stage) return { stageExists: false, events: [], rules: [] }

  const events = Array.from(new Set((stage.triggers ?? []).map((t) => t.event)))

  // A rule matches this stage when EITHER:
  //  - it's explicitly pinned (stageId === opts.stageId), OR
  //  - stageId is null AND its triggerType is one of the stage's events.
  // Explicit pins win even if the stage has no triggers configured, so a
  // recruiter can attach an automation manually without first having to
  // hook the trigger into the stage.
  const stageMatch = [
    { stageId: opts.stageId },
    ...(events.length > 0 ? [{ stageId: null, triggerType: { in: events } }] : []),
  ]

  const rules = await prisma.automationRule.findMany({
    where: {
      workspaceId: opts.workspaceId,
      isActive: true,
      AND: [
        { OR: stageMatch },
        { OR: [{ flowId: opts.flowId }, { flowId: null }] },
        // Pipeline scope: only rules pinned to this pipeline (or
        // workspace-wide, pipelineId=null) are eligible.
        pipelineScopeFragment(pipeline.id),
      ],
    },
    select: { id: true, name: true, triggerType: true, isActive: true },
    orderBy: { createdAt: 'asc' },
  })

  return { stageExists: true, events, rules }
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const stageId = request.nextUrl.searchParams.get('stageId')
  if (!stageId) return NextResponse.json({ error: 'stageId is required' }, { status: 400 })

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true, flowId: true },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { stageExists, events, rules } = await findMatchingRules({
    workspaceId: ws.workspaceId,
    stageId,
    flowId: session.flowId,
  })
  if (!stageExists) return NextResponse.json({ error: 'Stage not found' }, { status: 404 })

  return NextResponse.json({ events, rules })
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  // ruleId is optional — when set, fire only that one rule (still must be in
  // the stage's matched set, so the UI can't fire arbitrary rules through
  // this endpoint). When omitted, fall back to firing every matched rule.
  // `force=true` bypasses the duplicate-send guard so a manual rerun can
  // resend a step that already fired automatically. force REQUIRES an admin
  // or owner role (or super admin) — a plain workspace member cannot create
  // real-world sends/costs by re-triggering. force is the ONLY guard check
  // it bypasses; lifecycle/stage/prerequisite/halt checks remain
  // authoritative through the central guard (src/lib/automation-guard.ts).
  const { stageId, ruleId, force } = (await request.json().catch(() => ({}))) as {
    stageId?: string
    ruleId?: string
    force?: boolean
  }
  if (!stageId || typeof stageId !== 'string') {
    return NextResponse.json({ error: 'stageId is required' }, { status: 400 })
  }

  const isAdminLike = ws.isSuperAdmin || RERUN_ADMIN_ROLES.has(ws.role)
  if (force === true && !isAdminLike) {
    return forbidden()
  }

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true, flowId: true },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { stageExists, rules: matchedRules } = await findMatchingRules({
    workspaceId: ws.workspaceId,
    stageId,
    flowId: session.flowId,
  })
  if (!stageExists) return NextResponse.json({ error: 'Stage not found' }, { status: 404 })

  const rules = ruleId
    ? matchedRules.filter((r) => r.id === ruleId)
    : matchedRules
  if (ruleId && rules.length === 0) {
    return NextResponse.json({ error: 'Rule not found for this stage' }, { status: 404 })
  }
  if (rules.length === 0) return NextResponse.json({ fired: 0, results: [] })

  const results: Array<{ ruleId: string; name: string; ok: boolean; error?: string }> = []
  for (const rule of rules) {
    try {
      // Manual run = simulate the trigger firing now. dispatchRule routes each
      // step through dispatchStep → queueStepAtDelay, so step 0 at delay=2m
      // queues for 2m, step 1 at delay=4320m queues for 3 days. QStash
      // callback re-evaluates the guard at fire time (executionMode flips to
      // 'delayed_callback' for queued steps). Immediate steps (delay=0) still
      // get the manual_rerun bypass since they fire inline through executeStep.
      await dispatchRule(rule.id, session.id, {
        triggerType: rule.triggerType,
        executionMode: 'manual_rerun',
        actorUserId: ws.userId,
        force: force === true,
      })
      results.push({ ruleId: rule.id, name: rule.name, ok: true })
    } catch (err) {
      results.push({
        ruleId: rule.id,
        name: rule.name,
        ok: false,
        error: err instanceof Error ? err.message : 'Execution failed',
      })
    }
  }

  const fired = results.filter((r) => r.ok).length
  return NextResponse.json({ fired, results })
}
