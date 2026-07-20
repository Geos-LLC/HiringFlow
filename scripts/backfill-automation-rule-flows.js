/**
 * One-off backfill: for every AutomationRule with flowId != null, insert a
 * matching row in AutomationRuleFlow so the new join table matches the
 * legacy single-flow scope. Rules with flowId=null already mean
 * "workspace-wide"; those get no join rows (empty set = workspace-wide
 * under the new semantics).
 *
 * Idempotent — re-runs skip rules that already have flows populated.
 * Usage: node scripts/backfill-automation-rule-flows.js
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const rules = await prisma.automationRule.findMany({
    where: { flowId: { not: null } },
    select: { id: true, flowId: true, name: true, workspaceId: true, flows: { select: { flowId: true } } },
  })
  console.log(`Found ${rules.length} rules with flowId set`)

  let inserted = 0
  let skipped = 0
  for (const r of rules) {
    if (r.flows.some((f) => f.flowId === r.flowId)) {
      skipped++
      continue
    }
    try {
      await prisma.automationRuleFlow.create({
        data: { ruleId: r.id, flowId: r.flowId },
      })
      inserted++
      console.log(`  + ${r.id} (${r.name}) → flow ${r.flowId}`)
    } catch (err) {
      console.error(`  ! ${r.id} failed:`, err.message)
    }
  }
  console.log(`\nDone: inserted=${inserted}, skipped=${skipped}, workspace-wide (flowId=null, no action)=?`)

  const wsWide = await prisma.automationRule.count({ where: { flowId: null } })
  console.log(`Rules with flowId=null (workspace-wide, unchanged): ${wsWide}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
