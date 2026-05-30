import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

;(async () => {
  const meetingId = '8e60edde-901b-49d1-8a37-47ae42f1c606'
  const driveFileId = '175PdJFzOClfOY5W3_LQWRwctKAoE3KKA' // Alyona video on Drive

  const before = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    select: { driveRecordingFileId: true, recordingState: true, recallRecordingId: true },
  })
  console.log('before:', before)

  await prisma.interviewMeeting.update({
    where: { id: meetingId },
    data: {
      driveRecordingFileId: driveFileId,
      recordingState: 'ready',
    },
  })

  await prisma.interviewMeetingArtifact.upsert({
    where: { interviewMeetingId_driveFileId: { interviewMeetingId: meetingId, driveFileId } },
    create: {
      interviewMeetingId: meetingId,
      kind: 'recording',
      driveFileId,
      fileName: 'jaj-acxe-ayr (2026-05-29 11:01 GMT-4)',
      meetSpaceName: 'spaces/3Fbuf3msaO8B',
      driveCreatedTime: new Date('2026-05-29T16:36:06.200Z'),
    },
    update: {},
  })

  const after = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    select: { driveRecordingFileId: true, recordingState: true, recallRecordingId: true },
  })
  console.log('after:', after)
  await prisma.$disconnect()
})()
