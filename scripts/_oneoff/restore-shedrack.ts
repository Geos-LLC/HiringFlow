/**
 * One-off restore for Shedrack Amadi (session 0d1f8469-2222-482f-a352-a79910c30e34).
 *
 * Why: Recall.ai bot.call_ended fired 4s after the candidate left and 7 min
 * before scheduledEnd. listBotParticipants returned no non-host (Recall hadn't
 * finalized its participant list yet), so handleBotCallEnded emitted a
 * meeting_no_show that flipped the session to lost/rejected. The fix lives
 * in src/lib/recall/sync.ts (scheduledEnd gate + fallback to stored
 * participants + attendance_uploaded participantCount).
 *
 * Restore steps:
 *   1. Clear lost/rejected/halt fields on the session.
 *   2. Delete the spurious meeting_no_show SchedulingEvent.
 *   3. Re-emit meeting_ended via fireMeetingLifecycleAutomations so stage
 *      advances correctly (and any meeting_ended-triggered automations fire).
 */
import { PrismaClient } from '@prisma/client'
import { fireMeetingLifecycleAutomations } from '../../src/lib/automation'
import { logSchedulingEvent } from '../../src/lib/scheduling'

const SESSION_ID = '0d1f8469-2222-482f-a352-a79910c30e34'
const MEETING_ID = '8a441513-f4dc-4759-bcc7-1dd0f09e72bb'

async function main() {
  const prisma = new PrismaClient()

  const before = await prisma.session.findUnique({
    where: { id: SESSION_ID },
    select: {
      pipelineStatus: true, status: true, dispositionReason: true,
      rejectionReason: true, rejectionReasonAt: true,
      lostAt: true, automationsHaltedAt: true, automationsHaltedReason: true,
    },
  })
  if (!before) {
    console.error('session not found:', SESSION_ID)
    process.exit(1)
  }
  console.log('BEFORE:', JSON.stringify(before, null, 2))

  if (before.status !== 'lost' || before.dispositionReason !== 'interview_no_show') {
    console.warn('Session is not in the expected lost/interview_no_show state — aborting to avoid clobbering.')
    process.exit(1)
  }

  const noShowEvents = await prisma.schedulingEvent.findMany({
    where: {
      sessionId: SESSION_ID,
      eventType: 'meeting_no_show',
      metadata: { path: ['interviewMeetingId'], equals: MEETING_ID },
    },
    select: { id: true, eventAt: true, metadata: true },
  })
  console.log(`Found ${noShowEvents.length} no-show SchedulingEvent(s) to delete:`)
  for (const e of noShowEvents) console.log(`  ${e.id}  ${e.eventAt.toISOString()}  ${JSON.stringify(e.metadata)}`)

  await prisma.$transaction([
    prisma.session.update({
      where: { id: SESSION_ID },
      data: {
        pipelineStatus: null,
        status: 'active',
        dispositionReason: null,
        rejectionReason: null,
        rejectionReasonAt: null,
        lostAt: null,
        automationsHaltedAt: null,
        automationsHaltedReason: null,
      },
    }),
    prisma.schedulingEvent.deleteMany({
      where: {
        sessionId: SESSION_ID,
        eventType: 'meeting_no_show',
        metadata: { path: ['interviewMeetingId'], equals: MEETING_ID },
      },
    }),
  ])

  console.log('Cleared session fields + deleted meeting_no_show event(s). Writing meeting_ended audit event + firing automations...')
  const existingEnded = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId: SESSION_ID,
      eventType: 'meeting_ended',
      metadata: { path: ['interviewMeetingId'], equals: MEETING_ID },
    },
    select: { id: true },
  })
  if (!existingEnded) {
    await logSchedulingEvent({
      sessionId: SESSION_ID,
      eventType: 'meeting_ended',
      metadata: {
        interviewMeetingId: MEETING_ID,
        at: new Date().toISOString(),
        source: 'manual_restore',
        reason: 'recall_false_no_show_2026_05_27',
      },
    })
  }
  await fireMeetingLifecycleAutomations(SESSION_ID, 'meeting_ended')

  const after = await prisma.session.findUnique({
    where: { id: SESSION_ID },
    select: {
      pipelineStatus: true, status: true, dispositionReason: true,
      rejectionReason: true, rejectionReasonAt: true,
      lostAt: true, automationsHaltedAt: true, automationsHaltedReason: true,
    },
  })
  console.log('AFTER:', JSON.stringify(after, null, 2))

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
