/**
 * Stop the "Training email after completing form" rule from producing
 * any more `skipped_wrong_stage` rows on candidate timelines.
 *
 * Action:
 *   1. Deactivate the main rule + its 2 inactive copies (defence-in-depth).
 *   2. Cancel any AutomationExecution still in `queued` status under those
 *      rules so QStash callbacks that have not yet fired do not produce
 *      a fresh skip row when they land.
 *
 * Reversible: flip isActive back to true. Cancelled executions stay cancelled.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const RULE_IDS = [
  '8e934aa7-f432-4955-b453-76886534b54f', // Training email after completing form  (active)
  '4f60859e-56cf-4fbe-84b8-630207e2c297', // (copy) inactive
  'ee1a23a9-964c-4f22-81bc-d7a7e0997643', // (copy) inactive
]

async function main() {
  const before = await prisma.automationRule.findMany({
    where: { id: { in: RULE_IDS } },
    select: { id: true, name: true, isActive: true },
  })
  console.log('Before:')
  for (const r of before) console.log(`  ${r.id}  isActive=${r.isActive}  ${r.name}`)

  const deactivated = await prisma.automationRule.updateMany({
    where: { id: { in: RULE_IDS } },
    data: { isActive: false },
  })
  console.log(`\nDeactivated ${deactivated.count} rule(s).`)

  const queuedCount = await prisma.automationExecution.count({
    where: { automationRuleId: { in: RULE_IDS }, status: 'queued' },
  })
  const cancelled = await prisma.automationExecution.updateMany({
    where: { automationRuleId: { in: RULE_IDS }, status: 'queued' },
    data: { status: 'cancelled', skipReason: 'rule deactivated 2026-06-04' },
  })
  console.log(`Cancelled ${cancelled.count}/${queuedCount} queued execution(s) under those rules.`)

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
