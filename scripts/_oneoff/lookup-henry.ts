import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

(async () => {
  const sessionId = 'a2c6834d-730b-4e54-ae01-97be28517252';

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      candidateName: true,
      candidateEmail: true,
      status: true,
      dispositionReason: true,
      pipelineStatus: true,
      stalledAt: true,
      lastActivityAt: true,
      startedAt: true,
      finishedAt: true,
      trainingEnrollments: {
        select: {
          id: true,
          trainingId: true,
          status: true,
          startedAt: true,
          completedAt: true,
          accessTokenId: true,
          progress: true,
        },
        orderBy: { startedAt: 'desc' },
      },
      interviewMeetings: {
        select: {
          id: true,
          scheduledStart: true,
          scheduledEnd: true,
          actualStart: true,
          actualEnd: true,
          attendanceSource: true,
          meetSpaceName: true,
          meetingCode: true,
          meetingUri: true,
          recordingState: true,
          transcriptState: true,
          recallRecordingId: true,
          recallBotId: true,
          confirmedAt: true,
          createdAt: true,
        },
        orderBy: { scheduledStart: 'desc' },
      },
      schedulingEvents: {
        select: {
          id: true,
          eventType: true,
          createdAt: true,
          metadata: true,
          eventAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
      },
      pipelineStatusChanges: {
        select: {
          id: true,
          fromStatus: true,
          toStatus: true,
          source: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
      },
      trainingAccessTokens: {
        select: {
          id: true,
          trainingId: true,
          createdAt: true,
          usedAt: true,
          expiresAt: true,
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  console.log(JSON.stringify(session, null, 2));
  await prisma.$disconnect();
})();
