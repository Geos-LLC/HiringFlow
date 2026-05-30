import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const sessions = await prisma.session.findMany({
    where: { candidateEmail: 'info@spotless.homes' },
    orderBy: { startedAt: 'desc' },
    take: 5,
    select: {
      id: true, candidateName: true, candidateEmail: true, source: true,
      startedAt: true, workspaceId: true,
      flow: { select: { name: true } },
    },
  })
  console.log('Sessions for info@spotless.homes:')
  for (const s of sessions) {
    console.log(`  ${s.id}  name=${s.candidateName}  flow=${s.flow?.name}  source=${s.source}  started=${s.startedAt.toISOString()}`)
  }
  if (sessions.length === 0) { console.log('  NONE'); return }

  const sessionIds = sessions.map(s => s.id)
  const execs = await prisma.automationExecution.findMany({
    where: { sessionId: { in: sessionIds } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: {
      automationRule: { select: { name: true, triggerType: true } },
    },
  })
  console.log(`\nLast ${execs.length} AutomationExecution rows for those sessions:`)
  for (const e of execs) {
    console.log(`  sid=${e.sessionId?.slice(0,8)}  rule="${e.automationRule.name}"  trigger=${e.automationRule.triggerType}  status=${e.status}  ch=${e.channel}  sentAt=${e.sentAt?.toISOString() ?? '-'}  msgId=${e.providerMessageId ?? '-'}  deliveryStatus=${e.deliveryStatus ?? '-'}  err=${e.errorMessage ?? '-'}`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
