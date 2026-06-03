/**
 * Regression: a single public-flow completion must produce exactly ONE
 * AutomationExecution row per (rule, step, channel).
 *
 * Pre-fix (observed in prod for session d941e227 on 2026-06-01):
 *   - The candidate POSTed to `/api/public/sessions/[id]/answer` or
 *     `/api/public/sessions/[id]/submit`.
 *   - Both routes did:
 *       (1) `prisma.session.update({finishedAt, outcome})` — picked up by
 *           the lifecycle middleware → `fireAutomations` (executionMode='public_trigger').
 *       (2) `await fireAutomations(sessionId, 'completed', ...)` — explicit
 *           call (executionMode='immediate' or 'public_trigger').
 *   - Both paths converged at `executeStep`. The central guard's idempotency
 *     check only blocks `status='sent'` rows; concurrent 'pending' rows both
 *     passed, both rendered, both sent. Result: 2 execution rows per rule per
 *     flow completion, e.g. 2 "Flow Completed follow-up — SMS sent" lines on
 *     the candidate timeline.
 *
 * Post-fix:
 *   - The lifecycle middleware is the SINGLE caller for flow_completed on
 *     these routes. The explicit `fireAutomations` calls were removed from
 *     `answer/route.ts` and `submit/route.ts` (mirrors the same pattern
 *     applied to `training_completed` for `/api/public/trainings/[slug]/progress`
 *     in commit b9db914 on 2026-05-27).
 *
 * This test imports the project's `prisma` (which has the lifecycle
 * middleware attached via `attachLifecycleMiddleware`) and writes
 * `finishedAt` + `outcome` directly, simulating what the public flow routes
 * do. It then polls for the AutomationExecution row(s) and asserts exactly
 * one is produced.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { nanoid } from 'nanoid'
import { prisma } from '../prisma'

let workspaceId: string
let userId: string
let flowId: string
let templateId: string
let ruleId: string
let stepId: string

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `flow-single-${nanoid(8)}@test.com`, passwordHash: 'x' },
  })
  userId = user.id

  const workspace = await prisma.workspace.create({
    data: { name: 'Flow Single Fire WS', slug: `flow-single-${nanoid(8)}` },
  })
  workspaceId = workspace.id

  const flow = await prisma.flow.create({
    data: {
      workspaceId,
      createdById: userId,
      name: 'Flow Single Fire',
      slug: `fsf-${nanoid(8)}`,
    },
  })
  flowId = flow.id

  const template = await prisma.emailTemplate.create({
    data: {
      workspaceId,
      createdById: userId,
      name: 'Flow Single Template',
      subject: 'subj',
      bodyHtml: '<p>hi</p>',
    },
  })
  templateId = template.id

  const rule = await prisma.automationRule.create({
    data: {
      workspaceId,
      createdById: userId,
      name: 'Flow Completed Single-Fire Rule',
      triggerType: 'flow_completed',
      actionType: 'send_email',
      channel: 'email',
      emailTemplateId: templateId,
      // flowId left null so dispatchRulesForTrigger matches without us
      // having to wire pipeline lookups for the test workspace.
      isActive: true,
      steps: {
        create: [
          {
            order: 0,
            timingMode: 'trigger',
            delayMinutes: 0,
            channel: 'email',
            emailTemplateId: templateId,
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
  await prisma.emailTemplate.deleteMany({ where: { id: templateId } })
  await prisma.session.deleteMany({ where: { workspaceId } })
  await prisma.flow.deleteMany({ where: { id: flowId } })
  await prisma.workspace.deleteMany({ where: { id: workspaceId } })
  await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.$disconnect()
})

/**
 * The lifecycle middleware's `handle()` runs as fire-and-forget — the
 * Promise is not awaited by the originating Prisma write. Poll the DB
 * until the execution row appears (or the budget elapses).
 */
async function waitForExecutionRow(sessionId: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = await prisma.automationExecution.count({
      where: { sessionId, automationRuleId: ruleId },
    })
    if (count > 0) return count
    await new Promise((r) => setTimeout(r, 50))
  }
  return prisma.automationExecution.count({
    where: { sessionId, automationRuleId: ruleId },
  })
}

describe('flow_completed — single execution row per (rule, step, channel)', () => {
  it('writing finishedAt+outcome via the project Prisma client (which has the lifecycle middleware) produces exactly one AutomationExecution row', async () => {
    const session = await prisma.session.create({
      data: {
        workspaceId,
        flowId,
        candidateName: 'Single Fire',
        candidateEmail: 'single-fire@test.com',
        status: 'active',
      },
    })

    // Simulate the public flow route's terminal write — exactly what
    // answer/route.ts and submit/route.ts now do after their fix (no
    // explicit `await fireAutomations(...)` follows this).
    await prisma.session.update({
      where: { id: session.id },
      data: { finishedAt: new Date(), outcome: 'completed' },
    })

    const finalCount = await waitForExecutionRow(session.id)
    expect(finalCount, 'expected exactly one execution row for the flow_completed rule').toBe(1)

    const rows = await prisma.automationExecution.findMany({
      where: { sessionId: session.id, automationRuleId: ruleId },
      select: { id: true, stepId: true, channel: true, executionMode: true, status: true },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].stepId).toBe(stepId)
    expect(rows[0].channel).toBe('email')
    // The middleware is the only caller now; its executionMode is
    // 'public_trigger'. If a second caller is reintroduced with a different
    // executionMode (the pre-fix bug was 'immediate' + 'public_trigger' both
    // present), this assertion catches it because there would be two rows.
    expect(rows[0].executionMode).toBe('public_trigger')
  })

  it('writing finishedAt+outcome twice in the same session does NOT produce a second execution row (idempotency holds even if the middleware re-fires on a no-op update)', async () => {
    const session = await prisma.session.create({
      data: {
        workspaceId,
        flowId,
        candidateName: 'Single Fire Re-update',
        candidateEmail: 'single-fire-re@test.com',
        status: 'active',
      },
    })

    const now = new Date()
    await prisma.session.update({
      where: { id: session.id },
      data: { finishedAt: now, outcome: 'completed' },
    })
    await waitForExecutionRow(session.id)

    // Second write with the same value — the middleware re-fires (it
    // doesn't gate on no-op writes). The guard's `status='sent'`
    // idempotency check is what protects us here.
    await prisma.session.update({
      where: { id: session.id },
      data: { finishedAt: now, outcome: 'completed' },
    })
    // Give the second fire-and-forget a chance to land or be blocked.
    await new Promise((r) => setTimeout(r, 800))

    const count = await prisma.automationExecution.count({
      where: { sessionId: session.id, automationRuleId: ruleId },
    })
    expect(count).toBe(1)
  })
})
