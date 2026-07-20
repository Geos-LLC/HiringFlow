/**
 * Multi-flow rule scoping — regression coverage for the AutomationRuleFlow
 * join table. Verifies that:
 *   1. A rule with an empty flows[] set (workspace-wide) fires for every
 *      flow's flow_completed event.
 *   2. A rule with a non-empty flows[] fires ONLY for candidates whose flow
 *      is in the set — sessions from other flows produce no execution row.
 *   3. A rule scoped to multiple flows fires for each of them.
 *
 * These three cases exercise the flowScopeFragment predicate used by
 * dispatchRulesForTrigger and the reconciler. Pre-refactor coverage lived
 * under the single-column semantics (rule.flowId === session.flowId OR
 * rule.flowId IS NULL); the new join lets one rule scope to many flows,
 * which the tests below cover.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { nanoid } from 'nanoid'
import { prisma } from '../prisma'

let workspaceId: string
let userId: string
let flowA: string
let flowB: string
let flowC: string
let templateId: string
let wideRuleId: string
let scopedRuleId: string
let multiScopedRuleId: string

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `flow-scope-${nanoid(8)}@test.com`, passwordHash: 'x' },
  })
  userId = user.id
  const workspace = await prisma.workspace.create({
    data: { name: 'Flow Scope WS', slug: `flow-scope-${nanoid(8)}` },
  })
  workspaceId = workspace.id
  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: 'owner' },
  })
  const [fa, fb, fc] = await Promise.all([
    prisma.flow.create({
      data: { workspaceId, createdById: userId, name: 'Flow A', slug: `fa-${nanoid(6)}`, isPublished: true },
    }),
    prisma.flow.create({
      data: { workspaceId, createdById: userId, name: 'Flow B', slug: `fb-${nanoid(6)}`, isPublished: true },
    }),
    prisma.flow.create({
      data: { workspaceId, createdById: userId, name: 'Flow C', slug: `fc-${nanoid(6)}`, isPublished: true },
    }),
  ])
  flowA = fa.id
  flowB = fb.id
  flowC = fc.id

  const template = await prisma.emailTemplate.create({
    data: {
      workspaceId,
      createdById: userId,
      name: 'Flow Scope Template',
      subject: 'Test',
      bodyHtml: '<p>Hi {{candidate_name}}</p>',
      bodyText: 'Hi {{candidate_name}}',
    },
  })
  templateId = template.id

  // Rule 1: workspace-wide (no flows[] entries).
  const wide = await prisma.automationRule.create({
    data: {
      workspaceId, createdById: userId, name: 'Wide flow_completed',
      triggerType: 'flow_completed', actionType: 'send_email', channel: 'email',
      emailTemplateId: templateId, isActive: true,
      steps: { create: [{ order: 0, timingMode: 'trigger', delayMinutes: 0, channel: 'email', emailTemplateId: templateId }] },
    },
  })
  wideRuleId = wide.id

  // Rule 2: scoped to Flow A only.
  const scoped = await prisma.automationRule.create({
    data: {
      workspaceId, createdById: userId, name: 'Scoped to A',
      triggerType: 'flow_completed', actionType: 'send_email', channel: 'email',
      emailTemplateId: templateId, isActive: true,
      flows: { create: [{ flowId: flowA }] },
      steps: { create: [{ order: 0, timingMode: 'trigger', delayMinutes: 0, channel: 'email', emailTemplateId: templateId }] },
    },
  })
  scopedRuleId = scoped.id

  // Rule 3: scoped to Flow A + Flow B (the case single-flowId schema could
  // not express without cloning the rule).
  const multi = await prisma.automationRule.create({
    data: {
      workspaceId, createdById: userId, name: 'Scoped to A+B',
      triggerType: 'flow_completed', actionType: 'send_email', channel: 'email',
      emailTemplateId: templateId, isActive: true,
      flows: { create: [{ flowId: flowA }, { flowId: flowB }] },
      steps: { create: [{ order: 0, timingMode: 'trigger', delayMinutes: 0, channel: 'email', emailTemplateId: templateId }] },
    },
  })
  multiScopedRuleId = multi.id
})

afterAll(async () => {
  const ruleIds = [wideRuleId, scopedRuleId, multiScopedRuleId]
  await prisma.automationExecution.deleteMany({ where: { automationRuleId: { in: ruleIds } } })
  await prisma.automationStep.deleteMany({ where: { ruleId: { in: ruleIds } } })
  await prisma.automationRuleFlow.deleteMany({ where: { ruleId: { in: ruleIds } } })
  await prisma.automationRule.deleteMany({ where: { id: { in: ruleIds } } })
  await prisma.automationEvent.deleteMany({ where: { workspaceId } })
  await prisma.emailTemplate.deleteMany({ where: { id: templateId } })
  await prisma.session.deleteMany({ where: { workspaceId } })
  await prisma.flow.deleteMany({ where: { id: { in: [flowA, flowB, flowC] } } })
  await prisma.workspaceMember.deleteMany({ where: { workspaceId } })
  await prisma.workspace.deleteMany({ where: { id: workspaceId } })
  await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.$disconnect()
})

async function waitFor<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await fn()
  while (Date.now() < deadline) {
    if (predicate(last)) return last
    await new Promise((r) => setTimeout(r, 50))
    last = await fn()
  }
  return last
}

async function completeSessionInFlow(flowId: string, name: string): Promise<string> {
  const session = await prisma.session.create({
    data: { workspaceId, flowId, candidateName: name, candidateEmail: `${name}@t.com`, status: 'active' },
  })
  await prisma.session.update({
    where: { id: session.id },
    data: { finishedAt: new Date(), outcome: 'completed' },
  })
  return session.id
}

describe('AutomationRule multi-flow scoping', () => {
  it('workspace-wide rule (empty flows[]) fires for every flow', async () => {
    const sessionId = await completeSessionInFlow(flowC, `wide-${nanoid(4)}`)
    await waitFor(
      () => prisma.automationExecution.count({ where: { sessionId, automationRuleId: wideRuleId } }),
      (c) => c > 0,
    )
    const wideCount = await prisma.automationExecution.count({
      where: { sessionId, automationRuleId: wideRuleId },
    })
    expect(wideCount).toBe(1)
    // Scoped rules must NOT fire for Flow C (not in either scope set).
    const scopedCount = await prisma.automationExecution.count({
      where: { sessionId, automationRuleId: scopedRuleId },
    })
    const multiCount = await prisma.automationExecution.count({
      where: { sessionId, automationRuleId: multiScopedRuleId },
    })
    expect(scopedCount).toBe(0)
    expect(multiCount).toBe(0)
  })

  it('single-flow-scoped rule fires only for its scoped flow', async () => {
    const sessionA = await completeSessionInFlow(flowA, `a-${nanoid(4)}`)
    await waitFor(
      () => prisma.automationExecution.count({ where: { sessionId: sessionA, automationRuleId: scopedRuleId } }),
      (c) => c > 0,
    )
    const scopedFireCount = await prisma.automationExecution.count({
      where: { sessionId: sessionA, automationRuleId: scopedRuleId },
    })
    expect(scopedFireCount).toBe(1)
    // Same session should also trigger the workspace-wide rule.
    const wideAlsoCount = await prisma.automationExecution.count({
      where: { sessionId: sessionA, automationRuleId: wideRuleId },
    })
    expect(wideAlsoCount).toBe(1)
  })

  it('multi-flow-scoped rule fires for every listed flow but skips unlisted ones', async () => {
    const [sessionA, sessionB, sessionC] = await Promise.all([
      completeSessionInFlow(flowA, `multi-a-${nanoid(4)}`),
      completeSessionInFlow(flowB, `multi-b-${nanoid(4)}`),
      completeSessionInFlow(flowC, `multi-c-${nanoid(4)}`),
    ])
    await waitFor(
      () =>
        prisma.automationExecution.count({
          where: {
            automationRuleId: multiScopedRuleId,
            sessionId: { in: [sessionA, sessionB] },
          },
        }),
      (c) => c >= 2,
    )
    const [countA, countB, countC] = await Promise.all([
      prisma.automationExecution.count({
        where: { automationRuleId: multiScopedRuleId, sessionId: sessionA },
      }),
      prisma.automationExecution.count({
        where: { automationRuleId: multiScopedRuleId, sessionId: sessionB },
      }),
      prisma.automationExecution.count({
        where: { automationRuleId: multiScopedRuleId, sessionId: sessionC },
      }),
    ])
    expect(countA).toBe(1)
    expect(countB).toBe(1)
    expect(countC).toBe(0)
  })
})
