import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const sessionId = 'ae7bc9cd-4707-4d93-bc70-ceab5a65b513'

  const s = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true, candidateName: true,
      pipelineStatus: true, status: true,
      flowId: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
    },
  })
  console.log('SESSION', JSON.stringify(s, null, 2))
  console.log()

  const audit = await prisma.pipelineStatusChange.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, fromStatus: true, toStatus: true, source: true, triggeredBy: true, metadata: true },
  })
  console.log(`PipelineStatusChange audit (${audit.length}):`)
  for (const a of audit) {
    console.log(`  ${a.createdAt.toISOString()}  ${a.fromStatus ?? '∅'} -> ${a.toStatus}  src=${a.source} by=${a.triggeredBy ?? '-'}  meta=${a.metadata ? JSON.stringify(a.metadata).slice(0, 120) : '-'}`)
  }
  console.log()

  // Sanity: are there events the timeline would draw from?
  const [se, ae, te, im, bc] = await Promise.all([
    prisma.schedulingEvent.count({ where: { sessionId } }),
    prisma.automationExecution.count({ where: { sessionId } }),
    prisma.trainingEnrollment.count({ where: { sessionId } }),
    prisma.interviewMeeting.count({ where: { sessionId } }),
    prisma.backgroundCheck.count({ where: { sessionId } }),
  ])
  console.log(`Counts: schedulingEvents=${se} automationExecutions=${ae} trainingEnrollments=${te} interviewMeetings=${im} backgroundChecks=${bc}`)

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
