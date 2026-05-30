import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const email = 'sayapingeorgiy@gmail.com'

  const sessions = await prisma.session.findMany({
    where: { candidateEmail: email },
    orderBy: { startedAt: 'desc' },
    take: 5,
    select: {
      id: true, candidateName: true, candidateEmail: true, candidatePhone: true,
      source: true, pipelineStatus: true, startedAt: true,
      flow: { select: { name: true } },
      workspace: { select: { id: true, name: true, timezone: true } },
    },
  })
  console.log(`=== Sessions for ${email} (latest 5) ===`)
  for (const s of sessions) {
    console.log(`  ${s.id}  ${s.startedAt.toISOString()}  flow="${s.flow?.name}"  source=${s.source ?? '-'}  status=${s.pipelineStatus}  ws="${s.workspace.name}"`)
  }
  if (sessions.length === 0) { return }
  const sid = sessions[0].id

  console.log(`\n=== Most recent session: ${sid} ===`)
  console.log(`  ${sessions[0].candidateName} <${sessions[0].candidateEmail}>  ${sessions[0].candidatePhone}`)

  const meetings = await prisma.interviewMeeting.findMany({
    where: { sessionId: sid },
    orderBy: { createdAt: 'desc' },
    select: { id: true, scheduledStart: true, scheduledEnd: true, meetingUri: true, recordingState: true, createdAt: true },
  })
  console.log(`\nInterview meetings: ${meetings.length}`)
  for (const m of meetings) {
    console.log(`  ${m.id}  start=${m.scheduledStart.toISOString()}  uri=${m.meetingUri}`)
  }

  const events = await prisma.schedulingEvent.findMany({
    where: { sessionId: sid },
    orderBy: { eventAt: 'desc' },
    take: 10,
    select: { eventType: true, eventAt: true, metadata: true },
  })
  console.log(`\nScheduling events:`)
  for (const e of events) {
    const meta = e.metadata as Record<string, unknown> | null
    console.log(`  ${e.eventAt.toISOString()}  ${e.eventType}  source=${meta?.source ?? '-'}`)
  }

  console.log(`\n=== Automation executions for this session ===`)
  const execs = await prisma.automationExecution.findMany({
    where: { sessionId: sid },
    orderBy: { createdAt: 'asc' },
    select: {
      status: true, channel: true, scheduledFor: true, sentAt: true,
      errorMessage: true, qstashMessageId: true,
      step: { select: { timingMode: true, delayMinutes: true } },
      automationRule: { select: { name: true, triggerType: true } },
    },
  })
  if (execs.length === 0) { console.log('  (none)'); }
  for (const e of execs) {
    const trig = e.automationRule?.triggerType ?? '?'
    const tm = e.step?.timingMode ?? '-'
    const dm = e.step?.delayMinutes ?? '-'
    console.log(`  [${e.status}] ${trig} (${tm}=${dm}m) ${e.channel} "${e.automationRule?.name}" sched=${e.scheduledFor?.toISOString() || '-'} sent=${e.sentAt?.toISOString() || '-'} qstash=${e.qstashMessageId ? 'yes' : 'no'} err=${e.errorMessage ? e.errorMessage.substring(0, 90) : '-'}`)
  }

  await prisma.$disconnect()
}
main().catch(console.error).finally(() => process.exit(0))
