/**
 * For Spotless Homes workspace: find sessions that completed training
 * (the gate to scheduling) but never booked a meeting. This is what the
 * user most likely means by "clicked the scheduling link but didn't book"
 * — they probably DID get the invite (post-training) but didn't follow
 * through, OR something in the booking flow broke for them.
 */
import { PrismaClient } from '@prisma/client'

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'

async function main() {
  const prisma = new PrismaClient()

  // Training enrollments that completed in this workspace
  const completed = await prisma.trainingEnrollment.findMany({
    where: {
      status: 'completed',
      session: { workspaceId: WORKSPACE_ID },
    },
    select: {
      id: true, sessionId: true, completedAt: true,
      training: { select: { title: true } },
    },
    orderBy: { completedAt: 'desc' },
  })
  console.log(`Completed training enrollments: ${completed.length}\n`)

  const sessionIds = [...new Set(completed.map((c) => c.sessionId))]

  // Sessions that have at least one InterviewMeeting (booked)
  const booked = await prisma.interviewMeeting.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { sessionId: true },
  })
  const bookedSet = new Set(booked.map((b) => b.sessionId))

  // Sessions that have meeting_scheduled event but no InterviewMeeting (edge case)
  const scheduledEvents = await prisma.schedulingEvent.findMany({
    where: { sessionId: { in: sessionIds }, eventType: 'meeting_scheduled' },
    select: { sessionId: true },
  })
  for (const e of scheduledEvents) bookedSet.add(e.sessionId)

  const unbooked = sessionIds.filter((id) => !bookedSet.has(id))
  console.log(`Of ${sessionIds.length} sessions that completed training:`)
  console.log(`  ${bookedSet.size} booked an interview`)
  console.log(`  ${unbooked.length} did NOT book\n`)

  console.log('=== COMPLETED TRAINING BUT NO BOOKING ===')
  for (const sid of unbooked) {
    const session = await prisma.session.findUnique({
      where: { id: sid },
      select: {
        candidateName: true, candidateEmail: true, candidatePhone: true,
        pipelineStatus: true, status: true, dispositionReason: true,
        automationsHaltedAt: true, automationsHaltedReason: true,
        flow: { select: { name: true } },
      },
    })
    const enroll = completed.find((c) => c.sessionId === sid)!
    const events = await prisma.schedulingEvent.findMany({
      where: { sessionId: sid, eventType: { in: ['invite_sent', 'link_clicked', 'meeting_scheduled', 'meeting_cancelled'] } },
      orderBy: { eventAt: 'asc' },
      select: { eventType: true, eventAt: true, schedulingConfigId: true },
    })
    const clicks = events.filter((e) => e.eventType === 'link_clicked').length
    const invites = events.filter((e) => e.eventType === 'invite_sent').length
    const sinceTraining = enroll.completedAt ? (Date.now() - enroll.completedAt.getTime()) / 36e5 : null
    console.log(`\n  ${sid}  ${session?.candidateName} <${session?.candidateEmail}> ${session?.candidatePhone ?? ''}`)
    console.log(`    flow="${session?.flow?.name}" pipelineStatus=${session?.pipelineStatus} status=${session?.status} dispo=${session?.dispositionReason ?? '-'}`)
    console.log(`    training "${enroll.training.title}" completed=${enroll.completedAt?.toISOString() ?? '-'} (${sinceTraining?.toFixed(1) ?? '?'}h ago)`)
    console.log(`    halted=${session?.automationsHaltedAt?.toISOString() ?? '-'} (${session?.automationsHaltedReason ?? '-'})`)
    console.log(`    invites=${invites} clicks=${clicks}`)
    for (const ev of events) {
      console.log(`      ${ev.eventAt.toISOString()} ${ev.eventType}`)
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
