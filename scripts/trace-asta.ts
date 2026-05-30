import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const email = 'asta.dobrotina@gmail.com'

  const sessions = await prisma.session.findMany({
    where: { candidateEmail: { equals: email, mode: 'insensitive' } },
    select: {
      id: true,
      workspaceId: true,
      candidateName: true,
      candidatePhone: true,
      startedAt: true,
      finishedAt: true,
      outcome: true,
      pipelineStatus: true,
      status: true,
      dispositionReason: true,
      automationsHaltedAt: true,
      automationsHaltedReason: true,
      flow: { select: { name: true, slug: true } },
    },
    orderBy: { startedAt: 'desc' },
  })

  console.log(`\n=== Sessions for ${email} (${sessions.length}) ===`)
  for (const s of sessions) {
    console.log(`\n  session ${s.id}`)
    console.log(`    workspace=${s.workspaceId}`)
    console.log(`    flow=${s.flow?.name} (${s.flow?.slug})`)
    console.log(`    name=${s.candidateName}  phone=${s.candidatePhone}`)
    console.log(`    started=${s.startedAt.toISOString()}  finished=${s.finishedAt?.toISOString()}`)
    console.log(`    outcome=${s.outcome}  pipelineStatus=${s.pipelineStatus}  status=${s.status}`)
    console.log(`    dispositionReason=${s.dispositionReason}`)
    console.log(`    haltedAt=${s.automationsHaltedAt?.toISOString()}  haltedReason=${s.automationsHaltedReason}`)
  }

  for (const s of sessions) {
    console.log(`\n=== AutomationExecutions for session ${s.id} ===`)
    const execs = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      include: {
        automationRule: { select: { name: true, triggerType: true } },
        step: { select: { order: true, channel: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    for (const e of execs) {
      console.log(
        `  ${e.createdAt.toISOString()} rule="${e.automationRule.name}" trig=${e.automationRule.triggerType} ` +
          `step.order=${e.step?.order} channel=${e.channel} status=${e.status} sentAt=${e.sentAt?.toISOString() ?? '-'} ` +
          `skipReason=${e.skipReason ?? '-'} executionMode=${e.executionMode ?? '-'} ` +
          `triggeredBy=${e.triggeredByUserId ?? '-'}`,
      )
      if (e.errorMessage) console.log(`     errorMessage=${e.errorMessage.slice(0, 200)}`)
    }
  }
}
main().catch(console.error).finally(() => prisma.$disconnect())
