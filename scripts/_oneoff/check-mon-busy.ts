/**
 * Find InterviewMeeting rows that would block Mon Jun 1 9-1pm for the
 * Spotless Homes workspace. The preview-conflicts panel pulls these rows
 * into the busy set as a backstop, so a phantom row from a rescheduled
 * interview the user deleted from Google still blocks the slot.
 */

import { prisma } from '../../src/lib/prisma'

async function main() {
  const ws = await prisma.workspace.findFirst({
    where: { name: { contains: 'Spotless', mode: 'insensitive' } },
    select: { id: true, name: true, timezone: true },
  })
  if (!ws) {
    console.error('workspace not found')
    process.exit(1)
  }
  console.log(`workspace: ${ws.name} (id=${ws.id}) tz=${ws.timezone}`)

  // Mon Jun 1 2026 00:00 → Fri Jun 5 2026 23:59 in workspace tz.
  // Use a wide UTC window to catch anything close.
  const from = new Date('2026-06-01T00:00:00Z')
  const to = new Date('2026-06-06T23:59:59Z')

  const meetings = await prisma.interviewMeeting.findMany({
    where: {
      workspaceId: ws.id,
      scheduledStart: { gte: from, lt: to },
    },
    select: {
      id: true,
      scheduledStart: true,
      scheduledEnd: true,
      meetingUri: true,
      meetingCode: true,
      googleCalendarEventId: true,
      createdAt: true,
      updatedAt: true,
      spaceAdoptedFromReschedule: true,
      sessionId: true,
      session: { select: { candidateName: true, candidateEmail: true } },
    },
    orderBy: { scheduledStart: 'asc' },
  })

  console.log(`\nInterviewMeeting rows in window (Jun 1–6): ${meetings.length}`)
  for (const m of meetings) {
    console.log(`\n  id:        ${m.id}`)
    console.log(`  start:     ${m.scheduledStart.toISOString()}`)
    console.log(`  end:       ${m.scheduledEnd.toISOString()}`)
    console.log(`  candidate: ${m.session?.candidateName} <${m.session?.candidateEmail}>`)
    console.log(`  meetUri:   ${m.meetingUri}`)
    console.log(`  meetCode:  ${m.meetingCode}`)
    console.log(`  gcalEvent: ${m.googleCalendarEventId}`)
    console.log(`  created:   ${m.createdAt.toISOString()}`)
    console.log(`  updated:   ${m.updatedAt.toISOString()}`)
    console.log(`  rescheduledAdopted: ${m.spaceAdoptedFromReschedule}`)
  }

  // Also pull SchedulingEvent rows that might indicate rescheduling/cancellation
  // so we can see if a meeting was moved elsewhere but a row remained.
  console.log('\n--- Recent SchedulingEvents (last 7 days) for this workspace ---')
  const events = await prisma.schedulingEvent.findMany({
    where: {
      session: { workspaceId: ws.id },
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    select: {
      id: true,
      eventType: true,
      createdAt: true,
      metadata: true,
      session: { select: { candidateName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 30,
  })
  for (const e of events) {
    console.log(`  ${e.createdAt.toISOString()}  ${e.eventType.padEnd(22)}  ${e.session?.candidateName}  ${JSON.stringify(e.metadata)?.slice(0, 120)}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
