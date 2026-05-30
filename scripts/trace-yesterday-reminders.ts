/**
 * Find every AutomationExecution that was sent yesterday (2026-05-12)
 * around 8pm-ish, plus the meeting it relates to. Goal: identify which
 * meeting the user means and why the reminder fired ~17h out instead of 24h.
 */
import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  const start = new Date('2026-05-12T00:00:00Z')
  const end = new Date('2026-05-13T23:59:59Z')

  console.log('=== AutomationExecutions sent between May 12 00:00 UTC and May 13 23:59 UTC ===')
  const execs = await prisma.automationExecution.findMany({
    where: {
      sentAt: { gte: start, lte: end },
    },
    orderBy: { sentAt: 'asc' },
    select: {
      id: true,
      sessionId: true,
      channel: true,
      status: true,
      scheduledFor: true,
      sentAt: true,
      createdAt: true,
      qstashMessageId: true,
      errorMessage: true,
      step: { select: { id: true, timingMode: true, delayMinutes: true, order: true } },
      automationRule: { select: { id: true, name: true, triggerType: true, minutesBefore: true } },
    },
  })

  const sessIds = Array.from(new Set(execs.map((e) => e.sessionId).filter(Boolean) as string[]))
  const sessMap = new Map<string, { candidateName: string | null; candidateEmail: string | null; candidatePhone: string | null }>()
  if (sessIds.length > 0) {
    const ss = await prisma.session.findMany({
      where: { id: { in: sessIds } },
      select: { id: true, candidateName: true, candidateEmail: true, candidatePhone: true },
    })
    for (const s of ss) sessMap.set(s.id, { candidateName: s.candidateName, candidateEmail: s.candidateEmail, candidatePhone: s.candidatePhone })
  }

  for (const e of execs) {
    const rname = e.automationRule?.name || '?'
    const trig = e.automationRule?.triggerType || '?'
    const tm = e.step?.timingMode || '-'
    const dm = e.step?.delayMinutes ?? '-'
    const sess = e.sessionId ? sessMap.get(e.sessionId) : null
    console.log(`  sent=${e.sentAt?.toISOString()}  sched=${e.scheduledFor?.toISOString() || '-'}  status=${e.status} ch=${e.channel}  rule="${rname}" trig=${trig} step.timing=${tm} step.delay=${dm}min`)
    console.log(`     session=${e.sessionId}  name=${sess?.candidateName}  email=${sess?.candidateEmail}  phone=${sess?.candidatePhone}`)
  }

  if (sessIds.length > 0) {
    console.log('\n=== InterviewMeetings for those sessions ===')
    const meetings = await prisma.interviewMeeting.findMany({
      where: { sessionId: { in: sessIds } },
      orderBy: { scheduledStart: 'asc' },
      select: {
        id: true, sessionId: true, scheduledStart: true, scheduledEnd: true,
        createdAt: true, updatedAt: true, confirmedAt: true,
      },
    })
    for (const m of meetings) {
      const sess = sessMap.get(m.sessionId)
      console.log(`  ${m.id}  start=${m.scheduledStart.toISOString()}  session=${m.sessionId}  name=${sess?.candidateName}  created=${m.createdAt.toISOString()}  confirmed=${m.confirmedAt?.toISOString() || '-'}`)
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
