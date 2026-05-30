import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const steps = await prisma.flowStep.findMany({
    where: { flowId: '01b8a37c-eb07-4048-8648-f5d5de24feb5' },
    orderBy: { stepOrder: 'asc' },
    select: { id: true, stepOrder: true, stepType: true, questionType: true, title: true, formEnabled: true },
  })
  console.log(`Flow has ${steps.length} steps:`)
  for (const s of steps) {
    console.log(`  ${s.stepOrder}. type=${s.stepType} q=${s.questionType ?? '-'} formEnabled=${s.formEnabled} title="${(s.title ?? '?').slice(0, 60)}"`)
  }
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
