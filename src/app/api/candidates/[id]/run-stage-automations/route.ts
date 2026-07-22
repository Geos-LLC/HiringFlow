import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized, forbidden } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { dispatchRule } from '@/lib/automation'
import { type StageTriggerEvent } from '@/lib/funnel-stages'
import { resolvePipelineForFlow, stagesFor } from '@/lib/pipelines'
import { pipelineScopeFragment } from '@/lib/automation-pipeline-scope'
import { flowScopeFragment } from '@/lib/automation-flow-scope'

// Workspace roles authorised to issue manual reruns. Manual reruns can create
// real-world sends (emails, SMS, Certn orders) and are billed; they are a
// privileged operation and a plain workspace member should not be able to
// re-fire automations against a candidate. Super admins are always allowed.
const RERUN_ADMIN_ROLES = new Set(['admin', 'owner'])

// Manually fire automations for one candidate.
//
// Eligibility (both GET and POST) is: rule is active, in the candidate's
// workspace, and passes flow + pipeline scope for this candidate. stageId
// is now purely informational — when provided we flag each returned rule
// with `matchesStage` so the UI can group "matches current stage" vs
// "other rules" — but we no longer refuse to list or fire rules that
// don't match the stage. Recruiters wanted the Run button available at
// all times, not just when the current stage has attached triggers.
//
// Dispatch still routes through `dispatchRule`, which queues each step at
// its `delayMinutes` via QStash, so a rule with step 0 at +2m and step 1
// at +3d behaves exactly like the real trigger firing now: first email
// lands in 2 minutes, follow-up lands in 3 days. NOT both at once.
//
// Pre-fix (commit ef0f230, since reverted in this endpoint): we called
// executeRule which iterates every step inline ignoring delays — that
// sent 2 emails to the same candidate within ~200ms of each other.

interface MatchedRule {
  id: string
  name: string
  triggerType: string
  isActive: boolean
  matchesStage?: boolean
}

async function findApplicableRules(opts: {
  workspaceId: string
  flowId: string
  stageId?: string | null
}): Promise<{
  stageExists: boolean
  stageId: string | null
  events: StageTriggerEvent[]
  rules: MatchedRule[]
}> {
  // Stages live on the flow's pipeline now. Workspaces with no pipeline yet
  // get one created on the fly from their legacy Workspace.settings.funnelStages.
  const pipeline = await resolvePipelineForFlow({
    flowId: opts.flowId,
    workspaceId: opts.workspaceId,
  })

  let stage: ReturnType<typeof stagesFor>[number] | undefined
  let events: StageTriggerEvent[] = []
  let stageExists = true
  if (opts.stageId) {
    const stages = stagesFor(pipeline)
    stage = stages.find((s) => s.id === opts.stageId)
    if (!stage) {
      // Stage id supplied but not found on this pipeline — return the
      // workspace-scoped list anyway with matchesStage=false everywhere,
      // rather than 404ing. Caller only uses stageExists for context, not
      // as a hard gate.
      stageExists = false
    } else {
      events = Array.from(new Set((stage.triggers ?? []).map((t) => t.event)))
    }
  }

  const rules = await prisma.automationRule.findMany({
    where: {
      workspaceId: opts.workspaceId,
      isActive: true,
      AND: [
        flowScopeFragment(opts.flowId),
        // Pipeline scope: only rules pinned to this pipeline (or
        // workspace-wide, pipelineId=null) are eligible.
        pipelineScopeFragment(pipeline.id),
      ],
    },
    select: { id: true, name: true, triggerType: true, isActive: true, stageId: true },
    orderBy: { createdAt: 'asc' },
  })

  const eventSet = new Set(events)
  const stageIdForMatch = stage?.id ?? null
  const matched: MatchedRule[] = rules.map((r) => {
    const matchesStage = stageIdForMatch
      ? r.stageId === stageIdForMatch ||
        (r.stageId === null && eventSet.has(r.triggerType as StageTriggerEvent))
      : false
    return {
      id: r.id,
      name: r.name,
      triggerType: r.triggerType,
      isActive: r.isActive,
      matchesStage,
    }
  })

  return { stageExists, stageId: stageIdForMatch, events, rules: matched }
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  // stageId is optional now — when supplied, each rule row is annotated with
  // matchesStage so the UI can group. When absent, we return every applicable
  // workspace rule for this candidate.
  const stageId = request.nextUrl.searchParams.get('stageId')

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true, flowId: true },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { events, rules } = await findApplicableRules({
    workspaceId: ws.workspaceId,
    flowId: session.flowId,
    stageId,
  })

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

  const isAdminLike = ws.isSuperAdmin || RERUN_ADMIN_ROLES.has(ws.role)
  if (force === true && !isAdminLike) {
    return forbidden()
  }

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true, flowId: true },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { rules: applicableRules } = await findApplicableRules({
    workspaceId: ws.workspaceId,
    flowId: session.flowId,
    stageId: stageId ?? null,
  })

  // No stageId AND no ruleId is ambiguous — we don't want a caller
  // accidentally firing every workspace rule against a candidate. Require
  // at least one of them.
  if (!stageId && !ruleId) {
    return NextResponse.json({ error: 'ruleId is required when stageId is omitted' }, { status: 400 })
  }

  let rules: typeof applicableRules
  if (ruleId) {
    rules = applicableRules.filter((r) => r.id === ruleId)
    if (rules.length === 0) {
      return NextResponse.json({ error: 'Rule is not applicable to this candidate' }, { status: 404 })
    }
  } else {
    // Legacy path: stageId only → fire every rule that matches this stage.
    rules = applicableRules.filter((r) => r.matchesStage)
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
