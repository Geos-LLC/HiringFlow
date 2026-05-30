import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const sessionId = '6862cb98-2cab-49d1-942b-8bedaf9c723c'
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'

  // All rules for the workspace
  const rules = await prisma.automationRule.findMany({
    where: { workspaceId },
    include: { steps: true },
    orderBy: [{ flowId: 'asc' }, { triggerType: 'asc' }],
  })
  console.log(`Workspace rules (${rules.length}):\n`)
  for (const r of rules as any[]) {
    console.log(`  Rule "${r.name}"  trigger=${r.triggerType}  active=${r.isActive}  flowId=${r.flowId ?? 'ANY'}`)
    for (const s of r.steps) {
      console.log(`    step.order=${s.order} type=${s.nextStepType} delayMin=${s.delayMinutes} channel=${s.channel} schedConfId=${s.schedulingConfigId ?? '-'} trainingId=${s.trainingId ?? '-'} emailTemplateId=${s.emailTemplateId ?? '-'} emailDest=${s.emailDestination ?? '-'}`)
    }
  }

  // Scheduling events
  const schedEvents = await prisma.schedulingEvent.findMany({
    where: { sessionId },
    orderBy: { id: 'asc' },
  })
  console.log(`\nSchedulingEvents for session (${schedEvents.length}):`)
  for (const e of schedEvents as any[]) {
    console.log(`  ${JSON.stringify({ id: e.id, kind: e.kind, type: e.type, at: e.at, createdAt: e.createdAt, source: e.source, schedulingConfigId: e.schedulingConfigId })}`)
  }

  // Interview meetings — full detail
  const meetings = await prisma.interviewMeeting.findMany({
    where: { sessionId },
    orderBy: { scheduledStart: 'asc' },
  })
  console.log(`\nInterviewMeetings detail (${meetings.length}):`)
  for (const m of meetings as any[]) {
    console.log(`  ${JSON.stringify(m, null, 2)}`)
  }

  // Look for any executions of meeting-related rules workspace-wide that involve this session
  const meetingExecs = await prisma.automationExecution.findMany({
    where: {
      sessionId,
      automationRule: { triggerType: { in: ['meeting_scheduled', 'meeting_rescheduled', 'before_meeting', 'meeting_started', 'meeting_ended', 'meeting_no_show'] } },
    },
    include: { automationRule: true, step: true },
  })
  console.log(`\nMeeting-related executions for session (${meetingExecs.length}):`)
  for (const e of meetingExecs as any[]) {
    console.log(`  rule="${e.automationRule.name}" trigger=${e.automationRule.triggerType} status=${e.status} skipReason=${e.skipReason} channel=${e.channel} sentAt=${e.sentAt}`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
