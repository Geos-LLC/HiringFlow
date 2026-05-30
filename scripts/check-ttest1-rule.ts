import { PrismaClient } from '@prisma/client'
import { detectAutomationWarnings } from '../src/lib/automation-warnings'

async function main() {
  const prisma = new PrismaClient()
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'

  const rules = await prisma.automationRule.findMany({
    where: { workspaceId, name: { contains: 'test1', mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, triggerType: true, createdAt: true, updatedAt: true,
      steps: {
        orderBy: { order: 'asc' },
        select: {
          channel: true, smsBody: true,
          emailTemplate: { select: { subject: true } },
        },
      },
    },
  })
  for (const r of rules) {
    console.log(`Rule "${r.name}" id=${r.id} trigger=${r.triggerType}`)
    console.log(`  createdAt=${r.createdAt.toISOString()} updatedAt=${r.updatedAt.toISOString()}`)
    for (const s of r.steps) {
      console.log(`  channel=${s.channel}`)
      console.log(`  sms=${JSON.stringify(s.smsBody)}`)
      console.log(`  subject=${JSON.stringify(s.emailTemplate?.subject)}`)
    }
    const warnings = detectAutomationWarnings({
      triggerType: r.triggerType,
      name: r.name,
      steps: r.steps.map((s) => ({ channel: s.channel, smsBody: s.smsBody, emailTemplate: s.emailTemplate ?? null })),
    })
    console.log(`  → warnings.length = ${warnings.length}`)
    for (const w of warnings) console.log(`    • ${w}`)
    console.log()
  }
  await prisma.$disconnect()
}
main().catch(console.error).finally(() => process.exit(0))
