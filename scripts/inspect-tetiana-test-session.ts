/**
 * Inspect the session 02a8c19c-... ("Test: tetianakarpova58") and meeting
 * 4984bc20-... at May 13 14:00 UTC. Verify pipelineStatus, candidate fields,
 * whether anything would make the Schedule / Candidates pages hide it.
 */
import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const sessionId = '02a8c19c-777f-499d-a238-58f5831ccc3b'
  const meetingId = '4984bc20-ed55-45a2-b57e-a724cddef9eb'

  console.log('=== Session ===')
  const s = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true, workspaceId: true, flowId: true,
      candidateName: true, candidateEmail: true, candidatePhone: true,
      status: true, pipelineStatus: true, outcome: true,
      dispositionReason: true, automationsHaltedAt: true, automationsHaltedReason: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
      hiredAt: true, lostAt: true, stalledAt: true,
      addedManually: true, rejectionReason: true,
      flow: { select: { name: true } },
    },
  })
  console.log(JSON.stringify(s, null, 2))

  console.log('\n=== InterviewMeeting ===')
  const m = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true, workspaceId: true, sessionId: true, scheduledStart: true,
      scheduledEnd: true, meetingUri: true, meetingCode: true,
      googleCalendarEventId: true, meetSpaceName: true,
      confirmedAt: true, actualStart: true, actualEnd: true,
      createdAt: true, updatedAt: true,
      schedulingConfigId: true,
    },
  })
  console.log(JSON.stringify(m, null, 2))

  console.log('\n=== Same-workspace upcoming meetings ===')
  const ws = s?.workspaceId
  if (ws) {
    const upcoming = await prisma.interviewMeeting.findMany({
      where: {
        workspaceId: ws,
        scheduledStart: { gte: new Date() },
      },
      orderBy: { scheduledStart: 'asc' },
      select: { id: true, sessionId: true, scheduledStart: true },
    })
    for (const u of upcoming) {
      console.log(`  ${u.id}  start=${u.scheduledStart.toISOString()}  session=${u.sessionId}`)
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
