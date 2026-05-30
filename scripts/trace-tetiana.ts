import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const email = 'tetianakarpova58@gmail.com'
  const phone = '+19542269620'

  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { candidateEmail: { equals: email, mode: 'insensitive' } },
        { candidatePhone: phone },
      ],
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, candidateName: true, candidateEmail: true, candidatePhone: true,
      pipelineStatus: true, status: true, dispositionReason: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
      workspace: { select: { id: true, name: true, timezone: true } },
      flow: { select: { id: true, name: true, slug: true } },
    },
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Found ${sessions.length} session(s) matching ${email} OR ${phone}\n`)

  for (const s of sessions) {
    console.log('='.repeat(80))
    console.log(`Session ${s.id}`)
    console.log(`  ${s.candidateName} <${s.candidateEmail}>  phone=${s.candidatePhone ?? '-'}`)
    console.log(`  workspace: ${s.workspace.name} (${s.workspace.id}) tz=${s.workspace.timezone}`)
    console.log(`  flow: ${s.flow?.name ?? '-'} (slug=${s.flow?.slug ?? '-'})`)
    console.log(`  pipelineStatus (stage): ${s.pipelineStatus}`)
    console.log(`  status: ${s.status}`)
    console.log(`  startedAt=${s.startedAt.toISOString()}  lastActivity=${s.lastActivityAt?.toISOString() ?? '-'}\n`)

    const meetings = await prisma.interviewMeeting.findMany({
      where: { sessionId: s.id },
      orderBy: { scheduledStart: 'asc' },
    })
    console.log(`InterviewMeetings (${meetings.length}):`)
    for (const m of meetings) {
      console.log(`  ${m.id}`)
      console.log(`    scheduled=${m.scheduledStart.toISOString()} → ${m.scheduledEnd.toISOString()}`)
      console.log(`    actual=${m.actualStart?.toISOString() ?? '-'} → ${m.actualEnd?.toISOString() ?? '-'}`)
      console.log(`    confirmed=${m.confirmedAt?.toISOString() ?? '-'}`)
      console.log(`    createdAt=${m.createdAt.toISOString()}`)
      console.log(`    meetingUri=${m.meetingUri}`)
      console.log(`    meetSpaceName=${m.meetSpaceName ?? '-'}  meetingCode=${m.meetingCode ?? '-'}`)
      console.log(`    calendarEventId=${m.calendarEventId ?? '-'}`)
      console.log(`    driveRecordingFileId=${m.driveRecordingFileId ?? '-'}`)
      console.log(`    driveGeminiNotesFileId=${m.driveGeminiNotesFileId ?? '-'}`)
      console.log(`    attendanceSheetFileId=${m.attendanceSheetFileId ?? '-'}`)
      console.log(`    spaceAdoptedFromReschedule=${(m as any).spaceAdoptedFromReschedule ?? '-'}`)
      console.log(`    cancelledAt=${(m as any).cancelledAt?.toISOString() ?? '-'}`)
    }
    console.log()

    const events = await prisma.schedulingEvent.findMany({
      where: { sessionId: s.id },
      orderBy: { eventAt: 'asc' },
      select: { id: true, eventType: true, eventAt: true, metadata: true },
    })
    console.log(`SchedulingEvents (${events.length}):`)
    for (const e of events) {
      const meta = e.metadata as Record<string, unknown> | null
      const metaStr = meta ? ` meta=${JSON.stringify(meta).slice(0, 300)}` : ''
      console.log(`  ${e.eventAt.toISOString()}  ${e.eventType}${metaStr}`)
    }
    console.log()
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
