/**
 * Diagnose why before-meeting reminders didn't fire.
 * Looks at:
 *   - automation rules with before_meeting / meeting_started / etc.
 *   - latest InterviewMeeting + linked AutomationExecutions
 *   - QStash messageId presence
 */

import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  console.log('=== Workspaces ===')
  const ws = await prisma.workspace.findFirst({ select: { id: true, name: true, timezone: true } })
  if (!ws) { console.log('no workspace'); return }
  console.log(`${ws.id} ${ws.name} (${ws.timezone})`)

  console.log('\n=== Automation rules (all triggers) ===')
  const rules = await prisma.automationRule.findMany({
    where: { workspaceId: ws.id },
    select: {
      id: true, name: true, triggerType: true, channel: true, isActive: true,
      steps: {
        select: { id: true, order: true, channel: true, timingMode: true, delayMinutes: true, emailTemplateId: true, smsBody: true },
        orderBy: { order: 'asc' },
      },
    },
  })
  if (rules.length === 0) console.log('  (no rules)')
  for (const r of rules) {
    console.log(`  [${r.isActive ? 'on ' : 'off'}] ${r.name}  trigger=${r.triggerType}  channel=${r.channel}`)
    for (const s of r.steps) {
      console.log(`     step ${s.order}: channel=${s.channel} timing=${s.timingMode} delayMin=${s.delayMinutes} email=${s.emailTemplateId ? 'yes' : 'no'} sms=${s.smsBody ? 'yes' : 'no'}`)
    }
  }

  console.log('\n=== Latest 3 InterviewMeetings ===')
  const meetings = await prisma.interviewMeeting.findMany({
    where: { workspaceId: ws.id },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { id: true, sessionId: true, scheduledStart: true, meetingUri: true, createdAt: true },
  })
  for (const m of meetings) {
    console.log(`  ${m.id}  start=${m.scheduledStart.toISOString()}  session=${m.sessionId}`)
  }

  if (meetings.length === 0) { return }

  console.log('\n=== AutomationExecutions for recent meetings ===')
  for (const m of meetings) {
    console.log(`\n  meeting ${m.id} (start ${m.scheduledStart.toISOString()})`)
    const execs = await prisma.automationExecution.findMany({
      where: { sessionId: m.sessionId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true, status: true, channel: true, scheduledFor: true, sentAt: true,
        errorMessage: true, qstashMessageId: true, createdAt: true,
        step: { select: { timingMode: true, delayMinutes: true } },
        automationRule: { select: { name: true, triggerType: true } },
      },
    })
    if (execs.length === 0) console.log('    (no executions queued)')
    for (const e of execs) {
      const ruleName = e.automationRule?.name || '?'
      const trig = e.automationRule?.triggerType || '?'
      const tm = e.step?.timingMode || '?'
      const dm = e.step?.delayMinutes ?? '?'
      console.log(`    [${e.status}] ${trig} (${tm}=${dm}min) rule="${ruleName}" sched=${e.scheduledFor?.toISOString() || '-'} sent=${e.sentAt?.toISOString() || '-'} qstash=${e.qstashMessageId ? 'yes' : 'no'} err=${e.errorMessage || '-'}`)
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
