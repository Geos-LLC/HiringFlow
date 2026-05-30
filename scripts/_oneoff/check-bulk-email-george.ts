import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  // Bulk email creates AutomationExecution rows under the synthetic
  // workspace-wide "Recruiter bulk email" rule (triggerType='manual_bulk').
  // Find recent ones to see what happened with the George send.
  const recent = await prisma.automationExecution.findMany({
    where: {
      automationRule: { triggerType: 'manual_bulk' },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: {
      automationRule: { select: { name: true, workspace: { select: { name: true } } } },
    },
  })

  const sessionIds = Array.from(new Set(recent.map(e => e.sessionId).filter((x): x is string => !!x)))
  const sessions = await prisma.session.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, candidateName: true, candidateEmail: true, source: true, flow: { select: { name: true } } },
  })
  const sBy = new Map(sessions.map(s => [s.id, s]))

  console.log(`Last ${recent.length} bulk-email AutomationExecution rows (any workspace):`)
  for (const e of recent) {
    const s = e.sessionId ? sBy.get(e.sessionId) : null
    console.log(`  ws="${e.automationRule.workspace.name}"  to=${s?.candidateEmail ?? '?'}  name=${s?.candidateName ?? '?'}  flow=${s?.flow?.name ?? '?'}  status=${e.status}  createdAt=${e.createdAt.toISOString()}  sentAt=${e.sentAt?.toISOString() ?? '-'}  msgId=${e.providerMessageId ?? '-'}  delivery=${e.deliveryStatus ?? 'pending'}  err=${e.errorMessage ?? '-'}`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
