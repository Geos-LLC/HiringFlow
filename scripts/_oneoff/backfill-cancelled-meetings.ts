/**
 * Backfill `InterviewMeeting.cancelledAt` for any meeting that has a
 * `meeting_cancelled` SchedulingEvent in its session's history but is
 * still active in the DB. Idempotent.
 */

import { prisma } from '../../src/lib/prisma'

async function main() {
  // For every meeting_cancelled SchedulingEvent in the last 90 days,
  // find the matching InterviewMeeting and stamp cancelledAt if not set.
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const events = await prisma.schedulingEvent.findMany({
    where: { eventType: 'meeting_cancelled', createdAt: { gte: cutoff } },
    select: {
      id: true,
      sessionId: true,
      createdAt: true,
      metadata: true,
      session: { select: { workspaceId: true, candidateName: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`meeting_cancelled events (last 90d): ${events.length}`)

  let stamped = 0
  let alreadyCancelled = 0
  let noMatchingMeeting = 0
  for (const e of events) {
    const meta = (e.metadata || {}) as Record<string, unknown>
    const gcalEventId = typeof meta.googleEventId === 'string' ? meta.googleEventId : null
    const interviewMeetingId = typeof meta.interviewMeetingId === 'string' ? meta.interviewMeetingId : null

    let where: any = null
    if (interviewMeetingId) {
      where = { id: interviewMeetingId }
    } else if (gcalEventId) {
      where = { workspaceId: e.session.workspaceId, googleCalendarEventId: gcalEventId }
    } else {
      // Last resort: most recent active meeting on this session before the cancel event.
      where = {
        sessionId: e.sessionId,
        scheduledStart: { lt: e.createdAt },
        cancelledAt: null,
      }
    }

    const meeting = await prisma.interviewMeeting.findFirst({
      where,
      orderBy: { scheduledStart: 'desc' },
      select: { id: true, cancelledAt: true, scheduledStart: true },
    })
    if (!meeting) {
      noMatchingMeeting++
      continue
    }
    if (meeting.cancelledAt) {
      alreadyCancelled++
      continue
    }
    await prisma.interviewMeeting.update({
      where: { id: meeting.id },
      data: { cancelledAt: e.createdAt },
    })
    stamped++
    console.log(`  stamped meeting=${meeting.id} candidate=${e.session.candidateName} cancelledAt=${e.createdAt.toISOString()}`)
  }
  console.log(`\nstamped: ${stamped}   alreadyCancelled: ${alreadyCancelled}   noMatchingMeeting: ${noMatchingMeeting}`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
