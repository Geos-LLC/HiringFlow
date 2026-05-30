import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const sessions = await prisma.session.findMany({
    where: { candidateEmail: { equals: 'vitaliicheliadnik@gmail.com', mode: 'insensitive' } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, candidateName: true, startedAt: true, workspaceId: true },
  })
  console.log(`Found ${sessions.length} session(s)`)
  for (const s of sessions) {
    console.log(`\n=== Session ${s.id} (started ${s.startedAt.toISOString()}) ===`)
    const events = await prisma.schedulingEvent.findMany({
      where: { sessionId: s.id },
      orderBy: { eventAt: 'desc' },
    })
    console.log(`SchedulingEvents: ${events.length}`)
    for (const e of events) {
      const meta = (e.metadata as Record<string, unknown> | null) || {}
      console.log(`  ${e.eventAt.toISOString()} type=${e.eventType} meetingUrl=${meta.meetingUrl ?? '<none>'} scheduledAt=${meta.scheduledAt ?? '<none>'} source=${meta.source ?? '<none>'}`)
    }
    const meetings = await prisma.interviewMeeting.findMany({
      where: { sessionId: s.id },
      orderBy: { scheduledStart: 'desc' },
    })
    console.log(`InterviewMeetings: ${meetings.length}`)
    for (const m of meetings) {
      console.log(`  ${m.id} start=${m.scheduledStart.toISOString()} uri=${m.meetingUri} bot=${m.recallBotId ?? '-'} state=${m.recordingState}`)
    }
  }
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
