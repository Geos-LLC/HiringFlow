import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const c = {
    workspaces: await prisma.workspace.count(),
    sessions: await prisma.session.count(),
    interviewMeetings: await prisma.interviewMeeting.count(),
    schedulingConfigs: await prisma.schedulingConfig.count(),
    automationRules: await prisma.automationRule.count(),
    automationExecutions: await prisma.automationExecution.count(),
    schedulingEvents: await prisma.schedulingEvent.count(),
  }
  console.log(JSON.stringify(c, null, 2))

  const sched = await prisma.schedulingEvent.findMany({
    where: { eventType: { in: ['meeting_scheduled', 'meeting_rescheduled', 'meeting_cancelled'] } },
    orderBy: { eventAt: 'desc' },
    take: 5,
    select: { eventType: true, eventAt: true, sessionId: true, metadata: true },
  })
  console.log('\nRecent meeting events:')
  for (const e of sched) {
    const meta = e.metadata as Record<string, unknown> | null
    console.log(`  ${e.eventType}  ${e.eventAt.toISOString()}  session=${e.sessionId}  source=${meta?.source ?? '-'}`)
  }
  await prisma.$disconnect()
}
main().catch(console.error).finally(() => process.exit(0))
