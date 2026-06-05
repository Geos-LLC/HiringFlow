/**
 * Regression coverage for the central automation execution guard.
 *
 * Automatic paths — guard is authoritative, every check is enforced:
 *   1. direct trigger        — canExecuteAutomationStep called inline
 *   2. delayed QStash callback — executionMode='delayed_callback'
 *   3. chained rule          — executionMode='chained'
 *   4. cron-triggered        — executionMode='cron'
 *
 * Manual path — recruiter intent overrides every check:
 *   5. manual rerun          — executionMode='manual_rerun' → always allowed.
 *      The recruiter explicitly clicked "Run automations" on the candidate
 *      detail page; the endpoint that produces manual_rerun is role-gated
 *      upstream, so the guard short-circuits to allowed:true. There is NO
 *      skipping for manual reruns — they always run and always record.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { nanoid } from 'nanoid'
import {
  canExecuteAutomationStep,
  haltSessionAutomations,
  resumeSessionAutomations,
  type ExecutionMode,
} from '../automation-guard'

const prisma = new PrismaClient()

let workspaceId: string
let userId: string
let flowId: string
let trainingId: string
let ruleId: string
let stepId: string

beforeAll(async () => {
  const userEmail = `guard-${nanoid(8)}@test.com`
  const user = await prisma.user.create({
    data: { email: userEmail, passwordHash: 'x' },
  })
  userId = user.id

  const workspace = await prisma.workspace.create({
    data: { name: 'Guard Test WS', slug: `guard-${nanoid(8)}` },
  })
  workspaceId = workspace.id

  const flow = await prisma.flow.create({
    data: { workspaceId, createdById: userId, name: 'Guard Flow', slug: `gf-${nanoid(8)}` },
  })
  flowId = flow.id

  const training = await prisma.training.create({
    data: { workspaceId, createdById: userId, title: 'Guard Training', slug: `gt-${nanoid(8)}` },
  })
  trainingId = training.id

  const emailTemplate = await prisma.emailTemplate.create({
    data: {
      workspaceId,
      createdById: userId,
      name: 'Guard Template',
      subject: 'subj',
      bodyHtml: '<p>body</p>',
    },
  })

  const rule = await prisma.automationRule.create({
    data: {
      workspaceId,
      createdById: userId,
      name: 'Guard Rule',
      triggerType: 'training_completed',
      actionType: 'send_email',
      channel: 'email',
      emailTemplateId: emailTemplate.id,
      steps: {
        create: [
          {
            order: 0,
            timingMode: 'trigger',
            delayMinutes: 0,
            channel: 'email',
            emailTemplateId: emailTemplate.id,
          },
        ],
      },
    },
    include: { steps: true },
  })
  ruleId = rule.id
  stepId = rule.steps[0].id
})

afterAll(async () => {
  await prisma.automationExecution.deleteMany({ where: { automationRuleId: ruleId } })
  await prisma.automationStep.deleteMany({ where: { ruleId } })
  await prisma.automationRule.deleteMany({ where: { id: ruleId } })
  await prisma.emailTemplate.deleteMany({ where: { workspaceId } })
  await prisma.trainingEnrollment.deleteMany({ where: { trainingId } })
  await prisma.training.deleteMany({ where: { id: trainingId } })
  await prisma.session.deleteMany({ where: { workspaceId } })
  await prisma.flow.deleteMany({ where: { id: flowId } })
  await prisma.workspace.deleteMany({ where: { id: workspaceId } })
  await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.$disconnect()
})

/**
 * Helper: load fresh DB state of the actors the guard inspects.
 */
async function loadFixture(sessionId: string) {
  const [session, rule, step] = await Promise.all([
    prisma.session.findUniqueOrThrow({ where: { id: sessionId } }),
    prisma.automationRule.findUniqueOrThrow({ where: { id: ruleId } }),
    prisma.automationStep.findUniqueOrThrow({ where: { id: stepId } }),
  ])
  return { session, rule, step }
}

// Automatic modes — every check (halt/lifecycle/stage/prereq/idempotency) is
// authoritative for these. `manual_rerun` is intentionally excluded: the
// recruiter explicitly clicked "Run automations" and the endpoint that
// produces manual_rerun is role-gated upstream, so the guard short-circuits
// to allowed:true for it. The manual_rerun bypass is covered in its own suite
// below.
const AUTO_MODES: ExecutionMode[] = [
  'immediate',
  'delayed_callback',
  'chained',
  'cron',
]

describe('canExecuteAutomationStep — halt kill-switch', () => {
  it('blocks every execution mode when session.automationsHaltedAt is set', async () => {
    const session = await prisma.session.create({
      data: {
        workspaceId, flowId,
        candidateName: 'Halt Test',
        status: 'active',
      },
    })
    await prisma.trainingEnrollment.create({
      data: {
        trainingId,
        sessionId: session.id,
        userEmail: 'halt@test.com',
        completedAt: new Date(),
      },
    })
    await haltSessionAutomations({ sessionId: session.id, reason: 'manual:test' })

    const { session: s, rule, step } = await loadFixture(session.id)
    for (const mode of AUTO_MODES) {
      const result = await canExecuteAutomationStep({
        session: s, rule, step, channel: 'email',
        triggerType: 'training_completed',
        triggerContext: { trainingId },
        executionMode: mode,
      })
      expect(result.allowed, `mode=${mode}`).toBe(false)
      if (!result.allowed) {
        expect(result.reason, `mode=${mode}`).toBe('skipped_cancelled')
      }
    }
  })

  it('manual_rerun bypasses the halt check (recruiter explicitly clicked Run)', async () => {
    const session = await prisma.session.create({
      data: { workspaceId, flowId, candidateName: 'Halt Force', status: 'active' },
    })
    await prisma.trainingEnrollment.create({
      data: { trainingId, sessionId: session.id, userEmail: 'haltforce@test.com', completedAt: new Date() },
    })
    await haltSessionAutomations({ sessionId: session.id, reason: 'manual' })

    const { session: s, rule, step } = await loadFixture(session.id)
    const result = await canExecuteAutomationStep({
      session: s, rule, step, channel: 'email',
      triggerType: 'training_completed',
      triggerContext: { trainingId },
      executionMode: 'manual_rerun',
    })
    expect(result.allowed).toBe(true)
  })

  it('resumeSessionAutomations clears the halt and the guard passes again', async () => {
    const session = await prisma.session.create({
      data: { workspaceId, flowId, candidateName: 'Halt Resume', status: 'active' },
    })
    await prisma.trainingEnrollment.create({
      data: { trainingId, sessionId: session.id, userEmail: 'resume@test.com', completedAt: new Date() },
    })
    await haltSessionAutomations({ sessionId: session.id, reason: 'manual' })
    await resumeSessionAutomations(session.id)

    const { session: s, rule, step } = await loadFixture(session.id)
    const result = await canExecuteAutomationStep({
      session: s, rule, step, channel: 'email',
      triggerType: 'training_completed',
      triggerContext: { trainingId },
      executionMode: 'immediate',
    })
    expect(result.allowed).toBe(true)
  })
})

describe('canExecuteAutomationStep — lifecycle status', () => {
  it.each(['stalled', 'lost', 'hired'])(
    'blocks status=%s through every execution mode',
    async (badStatus) => {
      const session = await prisma.session.create({
        data: { workspaceId, flowId, candidateName: `Status ${badStatus}`, status: badStatus },
      })
      await prisma.trainingEnrollment.create({
        data: { trainingId, sessionId: session.id, userEmail: `${badStatus}@test.com`, completedAt: new Date() },
      })

      const { session: s, rule, step } = await loadFixture(session.id)
      for (const mode of AUTO_MODES) {
        const result = await canExecuteAutomationStep({
          session: s, rule, step, channel: 'email',
          triggerType: 'training_completed',
          triggerContext: { trainingId },
          executionMode: mode,
        })
        expect(result.allowed, `status=${badStatus} mode=${mode}`).toBe(false)
        if (!result.allowed) {
          expect(result.reason).toBe('skipped_wrong_status')
        }
      }
    },
  )

  it('honours rule.allowedForStatuses when set in code', async () => {
    const session = await prisma.session.create({
      data: { workspaceId, flowId, candidateName: 'AllowedLost', status: 'lost' },
    })
    await prisma.trainingEnrollment.create({
      data: { trainingId, sessionId: session.id, userEmail: 'allowed@test.com', completedAt: new Date() },
    })
    await prisma.automationRule.update({
      where: { id: ruleId },
      data: { allowedForStatuses: ['lost'] },
    })

    const { session: s, rule, step } = await loadFixture(session.id)
    const result = await canExecuteAutomationStep({
      session: s, rule, step, channel: 'email',
      triggerType: 'training_completed',
      triggerContext: { trainingId },
      executionMode: 'immediate',
    })
    expect(result.allowed).toBe(true)

    // Reset for subsequent tests
    await prisma.automationRule.update({
      where: { id: ruleId },
      data: { allowedForStatuses: [] },
    })
  })
})

describe('canExecuteAutomationStep — prerequisite (training_completed)', () => {
  it('blocks training_completed when enrollment has no completedAt — every mode', async () => {
    const session = await prisma.session.create({
      data: { workspaceId, flowId, candidateName: 'NoComplete', status: 'active' },
    })
    await prisma.trainingEnrollment.create({
      data: { trainingId, sessionId: session.id, userEmail: 'no@test.com' },
    })

    const { session: s, rule, step } = await loadFixture(session.id)
    for (const mode of AUTO_MODES) {
      const result = await canExecuteAutomationStep({
        session: s, rule, step, channel: 'email',
        triggerType: 'training_completed',
        triggerContext: { trainingId },
        executionMode: mode,
      })
      expect(result.allowed, `mode=${mode}`).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe('skipped_missing_prerequisite')
      }
    }
  })

  it('allows training_completed when a real completed enrollment exists', async () => {
    const session = await prisma.session.create({
      data: { workspaceId, flowId, candidateName: 'WithComplete', status: 'active' },
    })
    await prisma.trainingEnrollment.create({
      data: { trainingId, sessionId: session.id, userEmail: 'with@test.com', completedAt: new Date() },
    })

    const { session: s, rule, step } = await loadFixture(session.id)
    const result = await canExecuteAutomationStep({
      session: s, rule, step, channel: 'email',
      triggerType: 'training_completed',
      triggerContext: { trainingId },
      executionMode: 'immediate',
    })
    expect(result.allowed).toBe(true)
  })

  it('manual_rerun bypasses the prerequisite (recruiter explicitly clicked Run)', async () => {
    const session = await prisma.session.create({
      data: { workspaceId, flowId, candidateName: 'ForcePrereq', status: 'active' },
    })
    await prisma.trainingEnrollment.create({
      data: { trainingId, sessionId: session.id, userEmail: 'forceprereq@test.com' },
    })

    const { session: s, rule, step } = await loadFixture(session.id)
    const result = await canExecuteAutomationStep({
      session: s, rule, step, channel: 'email',
      triggerType: 'training_completed',
      triggerContext: { trainingId },
      executionMode: 'manual_rerun',
    })
    expect(result.allowed).toBe(true)
  })
})

describe('canExecuteAutomationStep — stage independence (gate removed 2026-06-04)', () => {
  // Policy: automations and pipeline stages are independent concerns.
  // rule.stageId is metadata only; it never blocks dispatch. These tests
  // pin the rule to a stage the session is NOT on, across every execution
  // mode, and assert the guard still allows the send.
  it.each([
    'immediate', 'chained', 'cron', 'public_trigger', 'debug', 'delayed_callback',
  ] as ExecutionMode[])(
    'allows %s when rule.stageId does not match session.pipelineStatus',
    async (mode) => {
      await prisma.automationRule.update({
        where: { id: ruleId },
        data: { stageId: 'stage_3' },
      })
      const session = await prisma.session.create({
        data: { workspaceId, flowId, candidateName: `StageIndep-${mode}`, status: 'active', pipelineStatus: 'stage_7' },
      })
      await prisma.trainingEnrollment.create({
        data: { trainingId, sessionId: session.id, userEmail: `stage-indep-${mode}@test.com`, completedAt: new Date() },
      })

      const { session: s, rule, step } = await loadFixture(session.id)
      const result = await canExecuteAutomationStep({
        session: s, rule, step, channel: 'email',
        triggerType: 'training_completed',
        triggerContext: { trainingId },
        executionMode: mode,
      })
      expect(result.allowed, `mode=${mode}`).toBe(true)

      await prisma.automationRule.update({ where: { id: ruleId }, data: { stageId: null } })
    },
  )
})

describe('canExecuteAutomationStep — idempotency', () => {
  let session: { id: string }
  beforeEach(async () => {
    session = await prisma.session.create({
      data: { workspaceId, flowId, candidateName: 'Idem', status: 'active' },
    })
    await prisma.trainingEnrollment.create({
      data: { trainingId, sessionId: session.id, userEmail: 'idem@test.com', completedAt: new Date() },
    })
    await prisma.automationExecution.create({
      data: {
        automationRuleId: ruleId,
        stepId,
        sessionId: session.id,
        channel: 'email',
        status: 'sent',
        sentAt: new Date(),
      },
    })
  })

  it('blocks duplicate sends from auto paths (immediate / delayed / chained / cron)', async () => {
    const { session: s, rule, step } = await loadFixture(session.id)
    for (const mode of ['immediate', 'delayed_callback', 'chained', 'cron'] as ExecutionMode[]) {
      const result = await canExecuteAutomationStep({
        session: s, rule, step, channel: 'email',
        triggerType: 'training_completed',
        triggerContext: { trainingId },
        executionMode: mode,
      })
      expect(result.allowed, `mode=${mode}`).toBe(false)
      if (!result.allowed) expect(result.reason).toBe('skipped_duplicate')
    }
  })

  it('allows duplicate sends from manual_rerun (no force required)', async () => {
    const { session: s, rule, step } = await loadFixture(session.id)
    const result = await canExecuteAutomationStep({
      session: s, rule, step, channel: 'email',
      triggerType: 'training_completed',
      triggerContext: { trainingId },
      executionMode: 'manual_rerun',
    })
    expect(result.allowed).toBe(true)
  })

  it('rejects force from non-manual modes (cron cannot bypass duplicate)', async () => {
    const { session: s, rule, step } = await loadFixture(session.id)
    const result = await canExecuteAutomationStep({
      session: s, rule, step, channel: 'email',
      triggerType: 'training_completed',
      triggerContext: { trainingId },
      executionMode: 'cron',
      force: true, // pretending — guard ignores force for non-manual modes
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toBe('skipped_duplicate')
  })
})
