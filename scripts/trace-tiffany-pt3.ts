import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  // Look up the AutomationStepExecution for the May 5 invite_sent
  const exec = await (prisma as any).automationExecution.findUnique({
    where: { id: '4748f710-3d05-47c3-a579-cbb3df119870' },
  })
  console.log('=== AutomationStepExecution (May 5 invite_sent) ===')
  console.log(JSON.stringify(exec, null, 2))
  console.log()

  // All executions for this session, time-sorted
  const all = await (prisma as any).automationExecution.findMany({
    where: { sessionId: '311b9fce-3169-4d74-b667-98319aa6d0da' },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`=== All AutomationStepExecutions for Tiffany (${all.length}) ===`)
  for (const e of all) {
    console.log(`  ${e.createdAt.toISOString()}  rule=${e.automationRuleId}  stepId=${e.stepId}  status=${e.status}  channel=${e.channel}  sent=${e.sentAt?.toISOString?.() ?? '-'}  err=${e.errorMessage ?? '-'}`)
  }
  console.log()

  // Training enrollment full record (audit fields)
  const enr = await prisma.trainingEnrollment.findUnique({
    where: { id: 'bc8d64b7-a726-43c5-abd5-047d4dc632c5' },
  })
  console.log('=== TrainingEnrollment full ===')
  console.log(JSON.stringify(enr, null, 2))
  console.log()

  // Look at session timeline log if exists
  const tables = await prisma.$queryRawUnsafe<any[]>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND (
      table_name ILIKE '%log%' OR table_name ILIKE '%event%' OR table_name ILIKE '%execution%'
    )
  `)
  console.log('=== Tables (log/event/execution) ===')
  console.log(tables)

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
