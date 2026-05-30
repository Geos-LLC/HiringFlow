import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  const sessionId = '311b9fce-3169-4d74-b667-98319aa6d0da'
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'
  const flowId = '6WvURaQcK5'

  // 1. The automation rule that sent the booking invite on May 5
  const rule1 = await (prisma as any).automationRule.findUnique({
    where: { id: '6c9c973e-3d0a-4b22-bc58-93c2830b853c' },
    include: { steps: true },
  })
  console.log('=== Rule 1 (booking invite, May 5) ===')
  console.log(JSON.stringify(rule1, null, 2))
  console.log()

  // 2. The reminder rule from May 11
  const rule2 = await (prisma as any).automationRule.findUnique({
    where: { id: 'd91cf094-8cf6-45a7-a19e-89c1adf066f6' },
    include: { steps: true },
  })
  console.log('=== Rule 2 (reminders, May 11) ===')
  console.log(JSON.stringify(rule2, null, 2))
  console.log()

  // 3. Flow steps
  const steps = await prisma.$queryRawUnsafe<any[]>(`
    SELECT id, step_order, step_type, title, question_type, form_enabled
    FROM flow_steps
    WHERE flow_id = (SELECT id FROM flows WHERE slug='6WvURaQcK5' LIMIT 1)
    ORDER BY step_order ASC
  `)
  console.log(`=== Flow steps (${steps.length}) ===`)
  for (const s of steps) {
    console.log(`  [${s.step_order}] type=${s.step_type}  qtype=${s.question_type}  formEnabled=${s.form_enabled}  "${s.title}"  id=${s.id}`)
  }
  console.log()

  // 4. Pipeline stage info for this workspace
  const stages = await prisma.$queryRawUnsafe<any[]>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND (table_name ILIKE '%pipeline%' OR table_name ILIKE '%stage%')
  `)
  console.log('=== pipeline/stage tables ===')
  console.log(stages)
  console.log()

  // 5. Look at PipelineStatusChange history for this session
  const changes = await (prisma as any).pipelineStatusChange.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  }).catch((e: any) => ({ error: e.message }))
  console.log('=== Pipeline status changes for session ===')
  console.log(JSON.stringify(changes, null, 2))

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
