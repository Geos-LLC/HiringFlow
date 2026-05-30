import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

;(async () => {
  const ws = await prisma.workspace.findUnique({
    where: { id: '739bcd71-69fd-4b30-a39e-242521b7ab20' },
    select: { id: true, name: true, recallBotEnabled: true },
  })
  console.log('workspace:', ws)

  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: '577bea62-4b6e-4bbf-b410-08f1756201dc' },
    select: {
      id: true,
      scheduledStart: true,
      scheduledEnd: true,
      recallBotId: true,
      recallRecordingId: true,
      attendanceSource: true,
      recordingState: true,
      transcriptState: true,
      meetingUri: true,
      meetSpaceName: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  console.log('\nmeeting:', meeting)

  await prisma.$disconnect()
})()
