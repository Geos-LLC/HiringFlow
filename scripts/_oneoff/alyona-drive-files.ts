import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

;(async () => {
  const m = await prisma.interviewMeeting.findUnique({
    where: { id: '8e60edde-901b-49d1-8a37-47ae42f1c606' },
    select: {
      id: true,
      driveRecordingFileId: true,
      driveGeminiNotesFileId: true,
      driveTranscriptFileId: true,
      recallRecordingId: true,
      recallBotId: true,
      recordingState: true,
      transcriptState: true,
      meetSpaceName: true,
      meetingCode: true,
      workspaceId: true,
    },
  })
  console.log('meeting:', m)

  const arts = await prisma.interviewMeetingArtifact.findMany({
    where: { interviewMeetingId: '8e60edde-901b-49d1-8a37-47ae42f1c606' },
  })
  console.log('\nartifacts:')
  for (const a of arts) console.log(' ', a)

  await prisma.$disconnect()
})()
