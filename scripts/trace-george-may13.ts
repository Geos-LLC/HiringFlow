/**
 * Trace meeting + reminders for "george" at 2026-05-13 14:00 (any tz).
 */
import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  // Find all sessions matching "george" (name or email)
  console.log('=== Sessions matching "george" ===')
  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { candidateName: { contains: 'george', mode: 'insensitive' } },
        { candidateEmail: { contains: 'george', mode: 'insensitive' } },
      ],
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      workspaceId: true,
      candidateName: true,
      candidateEmail: true,
      candidatePhone: true,
      status: true,
      pipelineStatus: true,
      startedAt: true,
      flow: { select: { name: true } },
    },
    take: 20,
  })
  for (const s of sessions) {
    console.log(`  ${s.id}  ${s.candidateName} <${s.candidateEmail}>  flow=${s.flow?.name}  pipelineStatus=${s.pipelineStatus}  status=${s.status}  startedAt=${s.startedAt.toISOString()}`)
  }

  if (sessions.length === 0) { console.log('  no sessions'); await prisma.$disconnect(); return }

  // Find InterviewMeetings for these sessions
  console.log('\n=== InterviewMeetings for these sessions ===')
  const sessionIds = sessions.map((s) => s.id)
  const meetings = await prisma.interviewMeeting.findMany({
    where: { sessionId: { in: sessionIds } },
    orderBy: { scheduledStart: 'desc' },
    select: {
      id: true,
      sessionId: true,
      scheduledStart: true,
      scheduledEnd: true,
      meetingUri: true,
      googleCalendarEventId: true,
      meetSpaceName: true,
      confirmedAt: true,
      actualStart: true,
      actualEnd: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  for (const m of meetings) {
    const sess = sessions.find((s) => s.id === m.sessionId)
    console.log(`  ${m.id}`)
    console.log(`    session=${m.sessionId} (${sess?.candidateName})`)
    console.log(`    scheduledStart=${m.scheduledStart.toISOString()}  actualStart=${m.actualStart?.toISOString() || '-'}`)
    console.log(`    googleCalendarEventId=${m.googleCalendarEventId}  meetSpaceName=${m.meetSpaceName}  uri=${m.meetingUri}`)
    console.log(`    confirmedAt=${m.confirmedAt?.toISOString() || '-'}`)
    console.log(`    createdAt=${m.createdAt.toISOString()}  updatedAt=${m.updatedAt.toISOString()}`)
  }

  // SchedulingEvents (eventType/eventAt model)
  console.log('\n=== SchedulingEvents for these sessions ===')
  const events = await prisma.schedulingEvent.findMany({
    where: { sessionId: { in: sessionIds } },
    orderBy: { eventAt: 'desc' },
    select: { id: true, sessionId: true, eventType: true, eventAt: true, metadata: true, createdAt: true },
  })
  for (const e of events) {
    const sess = sessions.find((s) => s.id === e.sessionId)
    console.log(`  ${e.eventType}  session=${e.sessionId} (${sess?.candidateName})  at=${e.eventAt.toISOString()}  created=${e.createdAt.toISOString()}`)
    console.log(`    metadata=${JSON.stringify(e.metadata)}`)
  }

  // Look for ANY InterviewMeeting scheduled around May 13 14:00 (any tz, +/- 1 day)
  console.log('\n=== ALL InterviewMeetings between May 12 and May 14 ===')
  const range = await prisma.interviewMeeting.findMany({
    where: {
      scheduledStart: {
        gte: new Date('2026-05-12T00:00:00Z'),
        lte: new Date('2026-05-14T23:59:59Z'),
      },
    },
    orderBy: { scheduledStart: 'asc' },
    select: {
      id: true, sessionId: true, scheduledStart: true, scheduledEnd: true,
      meetingUri: true, workspaceId: true, createdAt: true,
      session: { select: { candidateName: true, candidateEmail: true } },
    },
  })
  for (const m of range) {
    console.log(`  ${m.id}  start=${m.scheduledStart.toISOString()}  session=${m.sessionId}  name=${m.session?.candidateName} email=${m.session?.candidateEmail}`)
  }

  // For each session, find AutomationExecutions for before_meeting rules
  console.log('\n=== AutomationExecutions per session (before_meeting + meeting-relative) ===')
  for (const s of sessions) {
    const execs = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: {
        id: true, status: true, channel: true,
        scheduledFor: true, sentAt: true, createdAt: true,
        errorMessage: true, qstashMessageId: true,
        step: { select: { id: true, timingMode: true, delayMinutes: true, order: true } },
        automationRule: { select: { id: true, name: true, triggerType: true, minutesBefore: true } },
      },
    })
    if (execs.length === 0) continue
    console.log(`\n  session ${s.id} (${s.candidateName})`)
    for (const e of execs) {
      const rname = e.automationRule?.name || '?'
      const trig = e.automationRule?.triggerType || '?'
      const mb = e.automationRule?.minutesBefore ?? '?'
      const tm = e.step?.timingMode || '-'
      const dm = e.step?.delayMinutes ?? '-'
      console.log(`    [${e.status}] ${trig} mb=${mb} step.timingMode=${tm} step.delay=${dm}min ch=${e.channel}`)
      console.log(`      rule="${rname}" sched=${e.scheduledFor?.toISOString() || '-'}  sent=${e.sentAt?.toISOString() || '-'}  created=${e.createdAt.toISOString()}  qstash=${e.qstashMessageId || '-'}  err=${e.errorMessage || '-'}`)
    }
  }

  // List active before_meeting rules in the relevant workspace(s)
  console.log('\n=== before_meeting + meeting-relative rules (workspaces of matched sessions) ===')
  const wsIds = Array.from(new Set(sessions.map((s) => s.workspaceId)))
  for (const wsId of wsIds) {
    const rules = await prisma.automationRule.findMany({
      where: {
        workspaceId: wsId,
        OR: [
          { triggerType: 'before_meeting' },
          { steps: { some: { timingMode: { in: ['before_meeting', 'after_meeting'] } } } },
        ],
      },
      select: {
        id: true, name: true, triggerType: true, isActive: true,
        minutesBefore: true, flowId: true,
        steps: { select: { order: true, timingMode: true, delayMinutes: true, channel: true }, orderBy: { order: 'asc' } },
      },
    })
    console.log(`\n  workspace ${wsId}`)
    for (const r of rules) {
      console.log(`    [${r.isActive ? 'on ' : 'off'}] "${r.name}"  trigger=${r.triggerType} minutesBefore=${r.minutesBefore} flowId=${r.flowId}`)
      for (const s of r.steps) {
        console.log(`        step ${s.order}: timing=${s.timingMode} delay=${s.delayMinutes}min channel=${s.channel}`)
      }
    }
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
