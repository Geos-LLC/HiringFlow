/**
 * Look at how Spotless Homes meetings get into HiringFlow. The scheduling
 * config points at Calendly (external), so every booking flows through:
 *   Calendly → recruiter's Google Calendar → Calendar watch notification →
 *   /api/webhooks/google → processCalendarEvent → matchSession (utm_content
 *   or attendee email) → InterviewMeeting row.
 *
 * If matchSession can't tie the Calendar event to a Session, the booking
 * never registers in HiringFlow and the candidate stays at "Orientation
 * training" (stage_5) in the kanban even though they really did book.
 */
import { PrismaClient } from '@prisma/client'

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'

async function main() {
  const prisma = new PrismaClient()
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)

  const meetings = await prisma.interviewMeeting.findMany({
    where: { workspaceId: WORKSPACE_ID, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, sessionId: true, scheduledStart: true, googleCalendarEventId: true,
      schedulingConfigId: true, createdAt: true, meetingCode: true,
    },
  })

  console.log(`Spotless InterviewMeetings (last 60d): ${meetings.length}`)
  const builtIn = meetings.filter((m) => m.schedulingConfigId !== null)
  const external = meetings.filter((m) => m.schedulingConfigId === null)
  console.log(`  via built-in scheduler (schedulingConfigId set): ${builtIn.length}`)
  console.log(`  via Calendar webhook (schedulingConfigId null):  ${external.length}`)
  console.log(`  with googleCalendarEventId set:                  ${meetings.filter((m) => m.googleCalendarEventId).length}`)
  console.log()

  console.log('Last 10 meetings:')
  for (const m of meetings.slice(0, 10)) {
    const session = await prisma.session.findUnique({
      where: { id: m.sessionId },
      select: { candidateName: true, candidateEmail: true, pipelineStatus: true, status: true },
    })
    console.log(`  ${m.createdAt.toISOString()}  meeting=${m.id}  configId=${m.schedulingConfigId ?? 'null'}  gcalId=${m.googleCalendarEventId ?? 'null'}`)
    console.log(`    ${session?.candidateName} <${session?.candidateEmail}>  pipelineStatus=${session?.pipelineStatus} status=${session?.status}`)
  }

  // Look for Google Calendar events the workspace may have processed that DID
  // NOT match a session — these would be orphaned bookings. We don't store
  // unmatched calendar events, so this is approximate: candidates whose
  // training completed > 24h ago but who never got an InterviewMeeting row.
  console.log()
  console.log('=== UNMATCHED CALENDAR ACTIVITY HEURISTIC ===')
  console.log('Sessions that completed training >24h ago, clicked the scheduling link, but have no InterviewMeeting:')
  console.log('(these are the candidates who probably booked on Calendly but the calendar event did not match back)')
  console.log()

  const completed = await prisma.trainingEnrollment.findMany({
    where: { status: 'completed', session: { workspaceId: WORKSPACE_ID } },
    select: { sessionId: true, completedAt: true },
  })
  for (const c of completed) {
    if (!c.completedAt) continue
    if (Date.now() - c.completedAt.getTime() < 24 * 60 * 60_000) continue
    const meeting = await prisma.interviewMeeting.findFirst({ where: { sessionId: c.sessionId }, select: { id: true } })
    if (meeting) continue
    const clicks = await prisma.schedulingEvent.count({
      where: { sessionId: c.sessionId, eventType: 'link_clicked' },
    })
    if (clicks === 0) continue
    const session = await prisma.session.findUnique({
      where: { id: c.sessionId },
      select: { candidateName: true, candidateEmail: true, pipelineStatus: true, status: true, flow: { select: { name: true } } },
    })
    console.log(`  ${c.sessionId}  ${session?.candidateName} <${session?.candidateEmail}>`)
    console.log(`    flow="${session?.flow?.name}" pipelineStatus=${session?.pipelineStatus} status=${session?.status}`)
    console.log(`    training completed=${c.completedAt.toISOString()} clicks=${clicks}`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
