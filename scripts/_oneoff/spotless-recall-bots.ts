import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

;(async () => {
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, recallBotEnabled: true, updatedAt: true, createdAt: true },
  })
  console.log('workspace:', ws)

  // All meetings for this workspace, sorted by createdAt
  const meetings = await prisma.interviewMeeting.findMany({
    where: { session: { workspaceId } },
    select: {
      id: true,
      sessionId: true,
      scheduledStart: true,
      recallBotId: true,
      attendanceSource: true,
      createdAt: true,
      session: { select: { candidateName: true, candidateEmail: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 30,
  })

  console.log(`\n${meetings.length} most recent meetings in Spotless workspace:`)
  for (const m of meetings) {
    console.log(`  created=${m.createdAt.toISOString()} scheduledStart=${m.scheduledStart?.toISOString()} botId=${m.recallBotId || '(none)'} src=${m.attendanceSource} ${m.session.candidateName} <${m.session.candidateEmail}>`)
  }

  await prisma.$disconnect()
})()
