import { PrismaClient } from '@prisma/client'
async function main() {
  const p = new PrismaClient()
  const sessionId = 'f86a8ddf-342a-4186-81f7-c681e0cb04e6'
  console.log('NOW UTC:', new Date().toISOString())

  console.log('\n=== ALL automation_executions for prorabserv ===')
  const all = await p.automationExecution.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, status: true, channel: true,
      sentAt: true, scheduledFor: true, errorMessage: true,
      providerMessageId: true, qstashMessageId: true,
      step: { select: { timingMode: true, delayMinutes: true } },
      automationRule: { select: { name: true, triggerType: true } },
    },
  })
  console.log(`Found ${all.length} rows`)
  for (const e of all) {
    console.log(`  ${e.status.padEnd(9)} ${e.channel.padEnd(5)} ${e.automationRule?.triggerType ?? '?'} ${e.step?.timingMode}=${e.step?.delayMinutes}m "${e.automationRule?.name}" sent=${e.sentAt?.toISOString() || '-'} scheduled=${e.scheduledFor?.toISOString() || '-'} provider=${e.providerMessageId || '-'}`)
  }

  console.log('\n=== Scheduling events for prorabserv (any meeting_*) ===')
  const events = await p.schedulingEvent.findMany({
    where: { sessionId },
    orderBy: { eventAt: 'asc' },
    select: { eventType: true, eventAt: true, metadata: true },
  })
  for (const e of events) {
    const meta = e.metadata as Record<string, unknown> | null
    console.log(`  ${e.eventAt.toISOString()}  ${e.eventType}  source=${meta?.source ?? '-'}`)
  }

  console.log('\n=== InterviewMeetings for prorabserv ===')
  const ms = await p.interviewMeeting.findMany({ where: { sessionId }, select: { id: true, scheduledStart: true, createdAt: true, meetingUri: true } })
  for (const m of ms) {
    console.log(`  ${m.id}  created=${m.createdAt.toISOString()}  start=${m.scheduledStart.toISOString()}  uri=${m.meetingUri}`)
  }

  await p.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
