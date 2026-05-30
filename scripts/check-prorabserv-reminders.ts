import { PrismaClient } from '@prisma/client'
async function main() {
  const p = new PrismaClient()
  console.log('NOW UTC:', new Date().toISOString())
  const sessionId = 'f86a8ddf-342a-4186-81f7-c681e0cb04e6'
  const execs = await p.automationExecution.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, status: true, channel: true, scheduledFor: true, sentAt: true,
      errorMessage: true, qstashMessageId: true, providerMessageId: true,
      step: { select: { timingMode: true, delayMinutes: true } },
      automationRule: { select: { name: true, triggerType: true } },
    },
  })
  console.log(`\n=== ${execs.length} automation_executions for prorabserv@gmail.com session ===`)
  for (const e of execs) {
    const trig = e.automationRule?.triggerType ?? '?'
    const tm = e.step?.timingMode ?? '-'
    const dm = e.step?.delayMinutes ?? '-'
    console.log(`  [${e.status.padEnd(9)}] ${trig.padEnd(20)} (${tm}=${dm}m) ${e.channel.padEnd(5)} "${e.automationRule?.name}"`)
    console.log(`     sched=${e.scheduledFor?.toISOString() || '-'}  sent=${e.sentAt?.toISOString() || '-'}`)
    console.log(`     qstash=${e.qstashMessageId ? 'yes' : 'no'}  provider=${e.providerMessageId ? 'yes' : 'no'}`)
    if (e.errorMessage) console.log(`     ERR: ${e.errorMessage}`)
  }
  await p.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
