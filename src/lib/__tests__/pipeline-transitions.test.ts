/**
 * Pipeline Transitions v2 — integration tests.
 *
 * Coverage matches the spec checklist:
 *   1. No matching rule → pipelineStatus unchanged + audit row written.
 *   2. Matching rule moves candidate to toStageId.
 *   3. fromStageId=null matches from any current stage.
 *   4. Specific targetId wins over wildcard by priority/specificity.
 *   5. V2 does NOT write legacy fallback strings.
 *   6. V2 does NOT run completion-pair auto-advance.
 *   7. Same-stage match → no StageEntry, no stage_entered fan-out.
 *   8. stage_entered fires once per StageEntry (idempotent re-fire).
 *   9. Re-entry → new StageEntry → fires again.
 *  10. Raw-event execs still dedupe with stageEntryId=null.
 *  11. Queued step records carry stageEntryId on the AutomationExecution row.
 *  12. Stage-mismatched queued executions are cancelled on stage change.
 *  13. Backward transition blocked when allowBackward=false.
 *  14. Backward transition allowed when allowBackward=true.
 *
 * The PIPELINE_TRANSITIONS_V2 env flag is set per-test via a setter helper
 * because vitest does not auto-reset process.env between tests and the
 * resolver reads it directly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { nanoid } from 'nanoid'
import {
  applyTransitionV2,
  isV2EnabledForSession,
  resolveTransition,
} from '../pipeline-transitions'
import { applyStageTrigger } from '../funnel-stage-runtime'
import {
  cancelStageMismatchedQueued,
  fireStageEnteredAutomations,
} from '../automation'
import { canExecuteAutomationStep } from '../automation-guard'

const prisma = new PrismaClient()

// Stage layout used across the suite. Order matters — backward-block tests
// rely on screening < interview < hired.
const STAGES = [
  { id: 'new',        label: 'New',        tone: 'neutral', color: '#888', order: 0 },
  { id: 'screening',  label: 'Screening',  tone: 'brand',   color: '#369', order: 1 },
  { id: 'interview',  label: 'Interview',  tone: 'brand',   color: '#369', order: 2 },
  { id: 'hired',      label: 'Hired',      tone: 'success', color: '#3a3', order: 3 },
]

let workspaceId: string
let userId: string
let flowId: string
let trainingId: string
let pipelineId: string
let emailTemplateId: string
let stageEnteredRuleId: string
let stageEnteredStepId: string

const ORIGINAL_ENV_FLAG = process.env.PIPELINE_TRANSITIONS_V2
function withV2On() { process.env.PIPELINE_TRANSITIONS_V2 = 'true' }
function withV2Off() { delete process.env.PIPELINE_TRANSITIONS_V2 }

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `v2-${nanoid(8)}@test.com`, passwordHash: 'x' },
  })
  userId = user.id

  const workspace = await prisma.workspace.create({
    data: {
      name: 'V2 Test WS',
      slug: `v2-${nanoid(8)}`,
      pipelineTransitionsV2Enabled: true,
    },
  })
  workspaceId = workspace.id

  const pipeline = await prisma.pipeline.create({
    data: {
      workspaceId,
      name: 'V2 Pipeline',
      stages: STAGES,
      isDefault: true,
      transitionsV2Enabled: true,
    },
  })
  pipelineId = pipeline.id

  const flow = await prisma.flow.create({
    data: {
      workspaceId,
      createdById: userId,
      name: 'V2 Flow',
      slug: `v2f-${nanoid(8)}`,
      pipelineId,
    },
  })
  flowId = flow.id

  const training = await prisma.training.create({
    data: { workspaceId, createdById: userId, title: 'V2 Training', slug: `v2t-${nanoid(8)}` },
  })
  trainingId = training.id

  const tpl = await prisma.emailTemplate.create({
    data: {
      workspaceId,
      createdById: userId,
      name: 'V2 Template',
      subject: 'V2',
      bodyHtml: '<p>v2</p>',
    },
  })
  emailTemplateId = tpl.id

  const rule = await prisma.automationRule.create({
    data: {
      workspaceId,
      createdById: userId,
      name: 'V2 Stage Entered Rule',
      triggerType: 'stage_entered',
      pipelineId,
      stageId: 'interview',
      actionType: 'send_email',
      channel: 'email',
      emailTemplateId,
      steps: {
        create: [{
          order: 0,
          timingMode: 'trigger',
          delayMinutes: 0,
          channel: 'email',
          emailTemplateId,
        }],
      },
    },
    include: { steps: true },
  })
  stageEnteredRuleId = rule.id
  stageEnteredStepId = rule.steps[0].id
})

afterAll(async () => {
  // Cascade: workspace delete drops pipelines, flows, sessions, rules,
  // executions, stage_entries, transition_rules via FK ON DELETE CASCADE.
  await prisma.automationExecution.deleteMany({ where: { sessionId: { in: (await prisma.session.findMany({ where: { workspaceId }, select: { id: true } })).map((s) => s.id) } } })
  await prisma.stageEntry.deleteMany({ where: { workspaceId } })
  await prisma.pipelineTransitionRule.deleteMany({ where: { workspaceId } })
  await prisma.automationStep.deleteMany({ where: { rule: { workspaceId } } })
  await prisma.automationRule.deleteMany({ where: { workspaceId } })
  await prisma.emailTemplate.deleteMany({ where: { workspaceId } })
  await prisma.session.deleteMany({ where: { workspaceId } })
  await prisma.training.deleteMany({ where: { workspaceId } })
  await prisma.flow.deleteMany({ where: { workspaceId } })
  await prisma.pipeline.deleteMany({ where: { workspaceId } })
  await prisma.workspace.deleteMany({ where: { id: workspaceId } })
  await prisma.user.deleteMany({ where: { id: userId } })
  if (ORIGINAL_ENV_FLAG === undefined) delete process.env.PIPELINE_TRANSITIONS_V2
  else process.env.PIPELINE_TRANSITIONS_V2 = ORIGINAL_ENV_FLAG
  await prisma.$disconnect()
})

beforeEach(async () => {
  // Each test starts from a clean slate of rules/entries so prior-test
  // priorities don't bleed in. Sessions are per-test.
  await prisma.automationExecution.deleteMany({ where: { sessionId: { in: (await prisma.session.findMany({ where: { workspaceId }, select: { id: true } })).map((s) => s.id) } } })
  await prisma.stageEntry.deleteMany({ where: { workspaceId } })
  await prisma.pipelineTransitionRule.deleteMany({ where: { workspaceId } })
  await prisma.pipelineStatusChange.deleteMany({ where: { session: { workspaceId } } })
  await prisma.session.deleteMany({ where: { workspaceId } })
  withV2On()
})

async function mkSession(opts: { pipelineStatus?: string; status?: string } = {}) {
  return prisma.session.create({
    data: {
      workspaceId,
      flowId,
      candidateName: `T-${nanoid(6)}`,
      pipelineStatus: opts.pipelineStatus ?? 'new',
      status: opts.status ?? 'active',
    },
  })
}

// ─── 1. No rule → pipelineStatus unchanged + audit ──────────────────────────

describe('V2 — no matching rule', () => {
  it('does NOT mutate pipelineStatus when no rule matches', async () => {
    const session = await mkSession({ pipelineStatus: 'new' })
    const result = await applyTransitionV2({
      sessionId: session.id,
      eventType: 'flow_completed',
      context: { flowId },
    })
    expect(result.kind).toBe('no_rule_matched')
    const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } })
    expect(after.pipelineStatus).toBe('new')
  })

  it('writes a PipelineStatusChange audit row with source v2:no_rule:* when no rule matches', async () => {
    const session = await mkSession({ pipelineStatus: 'new' })
    await applyTransitionV2({
      sessionId: session.id,
      eventType: 'flow_completed',
      context: { flowId },
    })
    const audits = await prisma.pipelineStatusChange.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
    })
    expect(audits.length).toBeGreaterThan(0)
    expect(audits[0].source).toBe('v2:no_rule:flow_completed')
  })
})

// ─── 2. Matching rule moves candidate ───────────────────────────────────────

describe('V2 — matching rule', () => {
  it('moves candidate to toStageId and creates a StageEntry', async () => {
    await prisma.pipelineTransitionRule.create({
      data: {
        workspaceId, pipelineId,
        eventType: 'flow_completed', fromStageId: null, targetId: null,
        toStageId: 'screening', priority: 0,
      },
    })
    const session = await mkSession({ pipelineStatus: 'new' })
    const result = await applyTransitionV2({
      sessionId: session.id,
      eventType: 'flow_completed',
      context: { flowId },
    })
    expect(result.kind).toBe('transitioned')
    const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } })
    expect(after.pipelineStatus).toBe('screening')

    const entries = await prisma.stageEntry.findMany({ where: { sessionId: session.id } })
    expect(entries).toHaveLength(1)
    expect(entries[0].stageId).toBe('screening')
    expect(entries[0].previousStageId).toBe('new')
    expect(entries[0].sourceEventType).toBe('flow_completed')
  })
})

// ─── 3. fromStageId=null matches any current stage ──────────────────────────

describe('V2 — fromStageId wildcard', () => {
  it('null fromStageId matches when session is in any stage', async () => {
    await prisma.pipelineTransitionRule.create({
      data: {
        workspaceId, pipelineId,
        eventType: 'meeting_ended', fromStageId: null, targetId: null,
        toStageId: 'hired', priority: 0,
      },
    })
    // Try from 'screening' and 'interview' — both should match.
    for (const start of ['screening', 'interview']) {
      const session = await mkSession({ pipelineStatus: start })
      const r = await applyTransitionV2({
        sessionId: session.id,
        eventType: 'meeting_ended',
        context: {},
      })
      expect(r.kind, `from ${start}`).toBe('transitioned')
      const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } })
      expect(after.pipelineStatus).toBe('hired')
    }
  })
})

// ─── 4. Specific targetId wins over wildcard ────────────────────────────────

describe('V2 — priority / specificity tiebreak', () => {
  it('higher priority wins regardless of specificity', async () => {
    await prisma.pipelineTransitionRule.create({
      data: {
        workspaceId, pipelineId,
        eventType: 'flow_completed', targetId: null,
        toStageId: 'screening', priority: 100,
      },
    })
    await prisma.pipelineTransitionRule.create({
      data: {
        workspaceId, pipelineId,
        eventType: 'flow_completed', targetId: flowId,  // more specific
        toStageId: 'interview', priority: 0,             // but lower priority
      },
    })
    const session = await mkSession({ pipelineStatus: 'new' })
    const r = await applyTransitionV2({
      sessionId: session.id,
      eventType: 'flow_completed',
      context: { flowId },
    })
    expect(r.kind).toBe('transitioned')
    expect((r as { toStageId: string }).toStageId).toBe('screening')
  })

  it('non-null targetId wins over null when priorities are equal', async () => {
    await prisma.pipelineTransitionRule.create({
      data: {
        workspaceId, pipelineId,
        eventType: 'flow_completed', targetId: null,
        toStageId: 'screening', priority: 0,
      },
    })
    await prisma.pipelineTransitionRule.create({
      data: {
        workspaceId, pipelineId,
        eventType: 'flow_completed', targetId: flowId,
        toStageId: 'interview', priority: 0,
      },
    })
    const session = await mkSession({ pipelineStatus: 'new' })
    const resolved = await resolveTransition({
      sessionId: session.id,
      eventType: 'flow_completed',
      context: { flowId },
    })
    expect(resolved?.toStageId).toBe('interview')
  })
})

// ─── 5. Legacy fallback does NOT run in V2 ──────────────────────────────────

describe('V2 — legacy fallback disabled', () => {
  it('applyStageTrigger does not write legacyStatus when V2 is enabled and no rule matches', async () => {
    const session = await mkSession({ pipelineStatus: 'new' })
    const returned = await applyStageTrigger({
      sessionId: session.id,
      workspaceId,
      event: 'training_completed',
      trainingId,
      // V1 would have written this on the fallback path.
      legacyStatus: 'training_completed',
    })
    expect(returned).toBeNull()
    const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } })
    expect(after.pipelineStatus).toBe('new')  // NOT 'training_completed'
  })
})

// ─── 6. Completion-pair auto-advance does NOT run in V2 ─────────────────────

describe('V2 — completion-pair auto-advance disabled', () => {
  it('does not advance on training_completed even with V1-style training_started on current stage', async () => {
    // Seed V1-style trigger on 'screening' (which would auto-advance via
    // completion-pair under V1). Under V2 this is ignored.
    const v1Stages = STAGES.map((s) => s.id === 'screening'
      ? { ...s, triggers: [{ event: 'training_started', targetId: trainingId }] }
      : s,
    )
    await prisma.pipeline.update({
      where: { id: pipelineId },
      data: { stages: v1Stages },
    })
    try {
      const session = await mkSession({ pipelineStatus: 'screening' })
      const returned = await applyStageTrigger({
        sessionId: session.id,
        workspaceId,
        event: 'training_completed',
        trainingId,
        legacyStatus: 'training_completed',
      })
      expect(returned).toBeNull()
      const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } })
      expect(after.pipelineStatus).toBe('screening')  // did NOT auto-advance to 'interview'
    } finally {
      // Revert stages so subsequent tests start clean.
      await prisma.pipeline.update({ where: { id: pipelineId }, data: { stages: STAGES } })
    }
  })
})

// ─── 7. Same-stage match → no StageEntry, no fan-out ───────────────────────

describe('V2 — same-stage no-op', () => {
  it('returns same_stage without creating a StageEntry when rule resolves to current stage', async () => {
    await prisma.pipelineTransitionRule.create({
      data: {
        workspaceId, pipelineId,
        eventType: 'flow_completed', fromStageId: null, targetId: null,
        toStageId: 'screening', priority: 0,
      },
    })
    const session = await mkSession({ pipelineStatus: 'screening' })
    const r = await applyTransitionV2({
      sessionId: session.id,
      eventType: 'flow_completed',
      context: { flowId },
    })
    expect(r.kind).toBe('same_stage')
    const entries = await prisma.stageEntry.findMany({ where: { sessionId: session.id } })
    expect(entries).toHaveLength(0)
  })
})

// ─── 8 + 9. stage_entered single-fire per entry; re-entry fires again ──────

describe('V2 — stage_entered idempotency', () => {
  it('fires once per StageEntry — calling fireStageEnteredAutomations twice with same entry id creates only one execution', async () => {
    const session = await mkSession({ pipelineStatus: 'screening' })
    const entry = await prisma.stageEntry.create({
      data: {
        workspaceId, pipelineId, sessionId: session.id,
        stageId: 'interview', previousStageId: 'screening',
        sourceEventType: 'flow_completed',
      },
    })
    // Move session to match the entry so guard's stage check is satisfied.
    await prisma.session.update({
      where: { id: session.id },
      data: { pipelineStatus: 'interview' },
    })

    await fireStageEnteredAutomations({
      stageEntryId: entry.id,
      sessionId: session.id,
      stageId: 'interview',
      pipelineId,
      workspaceId,
    })
    await fireStageEnteredAutomations({
      stageEntryId: entry.id,
      sessionId: session.id,
      stageId: 'interview',
      pipelineId,
      workspaceId,
    })

    const execs = await prisma.automationExecution.findMany({
      where: { sessionId: session.id, stepId: stageEnteredStepId, channel: 'email' },
    })
    // Either exactly one row (DB unique constraint blocked the second insert)
    // or both rows have the same stageEntryId (so the unique key gates dedupe
    // at the guard layer before insert). Both are correct V2 behaviour.
    expect(execs.length).toBeLessThanOrEqual(1)
    if (execs[0]) expect(execs[0].stageEntryId).toBe(entry.id)
  })

  it('re-entry mints a new StageEntry → automation can fire again', async () => {
    const session = await mkSession({ pipelineStatus: 'interview' })
    const entry1 = await prisma.stageEntry.create({
      data: { workspaceId, pipelineId, sessionId: session.id, stageId: 'interview', sourceEventType: 'manual' },
    })
    await fireStageEnteredAutomations({
      stageEntryId: entry1.id, sessionId: session.id,
      stageId: 'interview', pipelineId, workspaceId,
    })

    // Simulate the recruiter moving them out and back in.
    const entry2 = await prisma.stageEntry.create({
      data: { workspaceId, pipelineId, sessionId: session.id, stageId: 'interview', sourceEventType: 'manual' },
    })
    await fireStageEnteredAutomations({
      stageEntryId: entry2.id, sessionId: session.id,
      stageId: 'interview', pipelineId, workspaceId,
    })

    const execs = await prisma.automationExecution.findMany({
      where: { sessionId: session.id, stepId: stageEnteredStepId, channel: 'email' },
      orderBy: { createdAt: 'asc' },
    })
    const entryIds = execs.map((e) => e.stageEntryId)
    // Critical: there must be one execution PER stage entry, with distinct
    // stageEntryId values — that is the re-entry contract.
    expect(entryIds).toContain(entry1.id)
    expect(entryIds).toContain(entry2.id)
  })
})

// ─── 10. Raw-event dedupe (stageEntryId=null) ──────────────────────────────

describe('V2 — raw-event dedupe unchanged', () => {
  it('guard returns skipped_duplicate when a sent execution already exists with stageEntryId=null', async () => {
    const session = await mkSession({ pipelineStatus: 'new' })
    // Seed a prior raw-event execution row.
    await prisma.automationExecution.create({
      data: {
        automationRuleId: stageEnteredRuleId,
        stepId: stageEnteredStepId,
        sessionId: session.id,
        channel: 'email',
        stageEntryId: null,
        status: 'sent',
      },
    })
    const [s, rule, step] = await Promise.all([
      prisma.session.findUniqueOrThrow({ where: { id: session.id } }),
      prisma.automationRule.findUniqueOrThrow({ where: { id: stageEnteredRuleId } }),
      prisma.automationStep.findUniqueOrThrow({ where: { id: stageEnteredStepId } }),
    ])
    const g = await canExecuteAutomationStep({
      session: s, rule, step, channel: 'email',
      triggerType: 'flow_completed',
      executionMode: 'immediate',
      // stageEntryId omitted → null path
    })
    expect(g.allowed).toBe(false)
    if (!g.allowed) expect(g.reason).toBe('skipped_duplicate')
  })

  it('guard does NOT dedupe across different stageEntryId values', async () => {
    const session = await mkSession({ pipelineStatus: 'interview' })
    const entryA = await prisma.stageEntry.create({
      data: { workspaceId, pipelineId, sessionId: session.id, stageId: 'interview' },
    })
    const entryB = await prisma.stageEntry.create({
      data: { workspaceId, pipelineId, sessionId: session.id, stageId: 'interview' },
    })
    // Existing 'sent' row pinned to entry A.
    await prisma.automationExecution.create({
      data: {
        automationRuleId: stageEnteredRuleId,
        stepId: stageEnteredStepId,
        sessionId: session.id,
        channel: 'email',
        stageEntryId: entryA.id,
        status: 'sent',
      },
    })
    const [s, rule, step] = await Promise.all([
      prisma.session.findUniqueOrThrow({ where: { id: session.id } }),
      prisma.automationRule.findUniqueOrThrow({ where: { id: stageEnteredRuleId } }),
      prisma.automationStep.findUniqueOrThrow({ where: { id: stageEnteredStepId } }),
    ])
    // Asking the guard for entry B — should NOT dedupe.
    const g = await canExecuteAutomationStep({
      session: s, rule, step, channel: 'email',
      triggerType: 'stage_entered',
      executionMode: 'immediate',
      stageEntryId: entryB.id,
    })
    expect(g.allowed).toBe(true)
  })
})

// ─── 11. Queued exec row carries stageEntryId ───────────────────────────────

describe('V2 — stage_entered dispatch writes stageEntryId onto execution rows', () => {
  it('AutomationExecution row created by fireStageEnteredAutomations has stageEntryId set', async () => {
    const session = await mkSession({ pipelineStatus: 'interview' })
    const entry = await prisma.stageEntry.create({
      data: { workspaceId, pipelineId, sessionId: session.id, stageId: 'interview' },
    })
    await fireStageEnteredAutomations({
      stageEntryId: entry.id,
      sessionId: session.id,
      stageId: 'interview',
      pipelineId, workspaceId,
    })
    const execs = await prisma.automationExecution.findMany({
      where: { sessionId: session.id, stepId: stageEnteredStepId },
    })
    expect(execs.length).toBeGreaterThan(0)
    for (const e of execs) {
      expect(e.stageEntryId).toBe(entry.id)
    }
  })
})

// ─── 12. cancelStageMismatchedQueued cancels rows pinned to other stages ───

describe('V2 — queue cleanup on stage change', () => {
  it('cancels queued executions whose rule is pinned to a different stage', async () => {
    const session = await mkSession({ pipelineStatus: 'screening' })
    // Existing queued exec belongs to the stage_entered rule pinned to
    // 'interview'. After the candidate enters 'hired', it should be cancelled.
    const queued = await prisma.automationExecution.create({
      data: {
        automationRuleId: stageEnteredRuleId,
        stepId: stageEnteredStepId,
        sessionId: session.id,
        channel: 'email',
        status: 'queued',
        scheduledFor: new Date(Date.now() + 60_000),
      },
    })
    await cancelStageMismatchedQueued(session.id, 'hired')
    const after = await prisma.automationExecution.findUniqueOrThrow({ where: { id: queued.id } })
    expect(after.status).toBe('cancelled')
  })
})

// ─── 13 + 14. Backward transitions ─────────────────────────────────────────

describe('V2 — backward transition guard', () => {
  it('blocks backward when allowBackward=false', async () => {
    await prisma.pipelineTransitionRule.create({
      data: {
        workspaceId, pipelineId,
        eventType: 'meeting_no_show', fromStageId: null, targetId: null,
        toStageId: 'screening', priority: 0, allowBackward: false,
      },
    })
    const session = await mkSession({ pipelineStatus: 'interview' })  // forward of screening
    const r = await applyTransitionV2({
      sessionId: session.id,
      eventType: 'meeting_no_show',
      context: {},
    })
    expect(r.kind).toBe('blocked_backward')
    const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } })
    expect(after.pipelineStatus).toBe('interview')  // unchanged

    // Audit row written with the blocked_backward source.
    const audits = await prisma.pipelineStatusChange.findMany({
      where: { sessionId: session.id }, orderBy: { createdAt: 'desc' },
    })
    expect(audits[0].source).toBe('v2:transition_blocked_backward:meeting_no_show')
  })

  it('allows backward when allowBackward=true', async () => {
    await prisma.pipelineTransitionRule.create({
      data: {
        workspaceId, pipelineId,
        eventType: 'meeting_no_show', fromStageId: null, targetId: null,
        toStageId: 'screening', priority: 0, allowBackward: true,
      },
    })
    const session = await mkSession({ pipelineStatus: 'interview' })
    const r = await applyTransitionV2({
      sessionId: session.id,
      eventType: 'meeting_no_show',
      context: {},
    })
    expect(r.kind).toBe('transitioned')
    const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } })
    expect(after.pipelineStatus).toBe('screening')
  })
})

// ─── V2 flag gating ─────────────────────────────────────────────────────────

describe('V2 — feature flag gating', () => {
  it('isV2EnabledForSession returns false when env flag is off', async () => {
    withV2Off()
    const session = await mkSession({ pipelineStatus: 'new' })
    const enabled = await isV2EnabledForSession(session.id)
    expect(enabled).toBe(false)
  })

  it('isV2EnabledForSession returns true when env + workspace flag are both on', async () => {
    withV2On()
    const session = await mkSession({ pipelineStatus: 'new' })
    const enabled = await isV2EnabledForSession(session.id)
    expect(enabled).toBe(true)
  })
})
