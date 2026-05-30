import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const meeting = await prisma.interviewMeeting.findFirst({
    where: { meetingCode: 'xcr-paay-dfi' },
    include: {
      session: { select: { id: true, candidateName: true, candidateEmail: true, candidatePhone: true, status: true, pipelineStatus: true, workspaceId: true } },
    },
  })
  if (!meeting) {
    console.log('NO MEETING FOUND for code xcr-paay-dfi')
    return
  }
  console.log('=== InterviewMeeting ===')
  console.log({
    id: meeting.id,
    meetingCode: meeting.meetingCode,
    meetingUrl: meeting.meetingUrl,
    scheduledStart: meeting.scheduledStart,
    scheduledEnd: meeting.scheduledEnd,
    actualStart: meeting.actualStart,
    actualEnd: meeting.actualEnd,
    confirmedAt: meeting.confirmedAt,
    recordingState: meeting.recordingState,
    driveRecordingFileId: meeting.driveRecordingFileId,
    workspaceId: meeting.workspaceId,
    sessionId: meeting.sessionId,
    candidate: meeting.session,
  })
  console.log('\n=== participants[] ===')
  console.log(JSON.stringify(meeting.participants, null, 2))

  const integ = await prisma.googleIntegration.findUnique({
    where: { workspaceId: meeting.workspaceId },
    select: { googleEmail: true, googleDisplayName: true },
  })
  console.log('\n=== host integration ===')
  console.log(integ)

  const events = await prisma.schedulingEvent.findMany({
    where: { sessionId: meeting.sessionId },
    orderBy: { createdAt: 'asc' },
    select: { eventType: true, createdAt: true, metadata: true },
  })
  console.log('\n=== SchedulingEvents (count=' + events.length + ') ===')
  for (const e of events) {
    console.log(e.createdAt.toISOString(), e.eventType, JSON.stringify(e.metadata))
  }

  const artifacts = await prisma.interviewMeetingArtifact.findMany({
    where: { interviewMeetingId: meeting.id },
    orderBy: { createdAt: 'asc' },
  })
  console.log('\n=== Artifacts (count=' + artifacts.length + ') ===')
  for (const a of artifacts) console.log(a)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
