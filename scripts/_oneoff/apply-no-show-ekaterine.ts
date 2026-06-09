/**
 * Apply meeting_no_show for Ekaterine Zack (session 1f4edb8d-66f2-4486-ab0d-b5c4bdadd0ab).
 *
 * Why: Recall confirms only the host ("Kat", is_host=true) ever joined the
 * Meet. Bot.call_ended fired 5.25s before scheduledEnd, which tripped the
 * premature-gate in src/lib/recall/sync.ts:244-250 and silently suppressed
 * the no-show emission. Plus the listBotParticipants endpoint returns 404
 * now (Recall moved participants behind a download URL), so the bot path
 * never had real participant data to gate on.
 *
 * What this does:
 *   1. Verifies the current session state.
 *   2. Writes a meeting_no_show SchedulingEvent.
 *   3. Calls fireMeetingLifecycleAutomations('meeting_no_show') — the same
 *      path the webhook would have taken — which:
 *        - applyStageTrigger → moves stage to "rejected" (legacy fallback)
 *        - stamps status='lost', dispositionReason='interview_no_show',
 *          rejectionReason='No-show', lostAt, automationsHaltedAt
 *        - dispatches workspace's "No-show follow-up" rule
 */
import { prisma } from '../../src/lib/prisma'
import { fireMeetingLifecycleAutomations } from '../../src/lib/automation'
import { logSchedulingEvent } from '../../src/lib/scheduling'

const SESSION_ID = '1f4edb8d-66f2-4486-ab0d-b5c4bdadd0ab'
const MEETING_ID = 'a570087d-314b-4472-a522-c0ae41dc1d38'

async function main() {
  const before = await prisma.session.findUnique({
    where: { id: SESSION_ID },
    select: {
      candidateName: true, candidateEmail: true,
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

  if (before.status === 'lost' && before.dispositionReason === 'interview_no_show') {
    console.warn('Session is ALREADY marked as no-show — aborting to avoid double-fire.')
    process.exit(0)
  }

  const existingNoShow = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId: SESSION_ID,
      eventType: 'meeting_no_show',
      metadata: { path: ['interviewMeetingId'], equals: MEETING_ID },
    },
    select: { id: true },
  })
  if (existingNoShow) {
    console.warn('A meeting_no_show SchedulingEvent already exists:', existingNoShow.id)
  } else {
    await logSchedulingEvent({
      sessionId: SESSION_ID,
      eventType: 'meeting_no_show',
      metadata: {
        interviewMeetingId: MEETING_ID,
        at: new Date().toISOString(),
        source: 'manual_apply',
        reason: 'recall_premature_gate_2026_06_09',
        recallBotSubCode: 'call_ended_by_host',
        confirmedFromRecallApi: 'only host (Kat, is_host=true) ever joined',
      },
    })
    console.log('Wrote meeting_no_show SchedulingEvent.')
  }

  console.log('Firing fireMeetingLifecycleAutomations(meeting_no_show)...')
  await fireMeetingLifecycleAutomations(SESSION_ID, 'meeting_no_show')

  const after = await prisma.session.findUnique({
    where: { id: SESSION_ID },
    select: {
      pipelineStatus: true, status: true, dispositionReason: true,
      rejectionReason: true, rejectionReasonAt: true,
      lostAt: true, automationsHaltedAt: true, automationsHaltedReason: true,
    },
  })
  console.log('AFTER:', JSON.stringify(after, null, 2))

  const executions = await prisma.automationExecution.findMany({
    where: { sessionId: SESSION_ID, createdAt: { gte: new Date(Date.now() - 60_000) } },
    select: {
      id: true, ruleId: true, stepId: true, channel: true,
      status: true, errorMessage: true, scheduledFor: true,
    },
    orderBy: { createdAt: 'desc' },
  })
  console.log(`Recent AutomationExecution rows (${executions.length}):`)
  for (const e of executions) console.log(' ', JSON.stringify(e))

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
