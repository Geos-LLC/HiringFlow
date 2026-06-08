/**
 * PERMANENT deletion of the "Training email after completing form" rule
 * (and its 2 inactive copies) on Spotless.
 *
 * Order matters:
 *   1. Cancel every still-queued QStash message under these rules (otherwise
 *      QStash will fire callbacks against execution rows that no longer exist,
 *      blowing up the /api/automations/run handler).
 *   2. Delete the AutomationRule rows. The schema cascades to AutomationStep
 *      (rule.steps) and AutomationExecution (rule.executions).
 *
 * Irreversible. Audit/history rows under these rules are wiped.
 */
import { PrismaClient } from '@prisma/client'
import { Client as QstashClient } from '@upstash/qstash'

const prisma = new PrismaClient()
const qstash = new QstashClient({ token: process.env.QSTASH_TOKEN! })

const RULE_IDS = [
  '8e934aa7-f432-4955-b453-76886534b54f', // Training email after completing form  (active again as of 16:27)
  '4f60859e-56cf-4fbe-84b8-630207e2c297', // (copy) inactive
  'ee1a23a9-964c-4f22-81bc-d7a7e0997643', // (copy) inactive
]

async function main() {
  const queued = await prisma.automationExecution.findMany({
    where: {
      automationRuleId: { in: RULE_IDS },
      status: 'queued',
      qstashMessageId: { not: null },
    },
    select: { id: true, qstashMessageId: true, sessionId: true, scheduledFor: true },
  })
  console.log(`Found ${queued.length} live QStash message(s) to cancel before delete.`)

  let cancelled = 0
  for (const e of queued) {
    if (!e.qstashMessageId) continue
    try {
      await qstash.messages.delete(e.qstashMessageId)
      cancelled++
      console.log(`  ✓ cancelled qstash msg ${e.qstashMessageId} (exec ${e.id.slice(0, 8)}, fires ${e.scheduledFor?.toISOString()})`)
    } catch (err) {
      console.warn(`  ✗ failed to cancel ${e.qstashMessageId}:`, (err as Error).message)
    }
  }
  console.log(`Cancelled ${cancelled}/${queued.length} QStash msgs.\n`)

  const counts = await prisma.automationExecution.groupBy({
    by: ['automationRuleId'],
    where: { automationRuleId: { in: RULE_IDS } },
    _count: true,
  })
  console.log('Executions about to be cascade-deleted:')
  for (const c of counts) console.log(`  ${c.automationRuleId}  ${c._count}`)

  const deleted = await prisma.automationRule.deleteMany({ where: { id: { in: RULE_IDS } } })
  console.log(`\nDeleted ${deleted.count} rule(s) (cascade removes steps + executions).`)

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
