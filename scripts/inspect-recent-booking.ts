import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  // Find the most recent built-in-scheduler meeting and trace its workspace,
  // rules, and reminder executions.
  const recentEvent = await prisma.schedulingEvent.findFirst({
    where: { eventType: 'meeting_scheduled' },
    orderBy: { eventAt: 'desc' },
    select: { sessionId: true, metadata: true, eventAt: true },
  })
  if (!recentEvent) { console.log('no events'); return }

  const meta = recentEvent.metadata as Record<string, unknown> | null
  console.log(`Most recent meeting_scheduled: ${recentEvent.eventAt.toISOString()}`)
  console.log(`  source: ${meta?.source ?? '-'}`)
  console.log(`  meeting URL: ${meta?.meetingUrl ?? '-'}`)
  console.log(`  scheduled for: ${meta?.scheduledAt ?? '-'}`)

  const session = await prisma.session.findUnique({
    where: { id: recentEvent.sessionId },
    select: {
      id: true, candidateName: true, candidateEmail: true,
      workspace: { select: { id: true, name: true, timezone: true } },
    },
  })
  if (!session) { console.log('session gone'); return }

  console.log(`\nWorkspace: ${session.workspace.name} (${session.workspace.id})  TZ ${session.workspace.timezone}`)
  console.log(`Candidate: ${session.candidateName} <${session.candidateEmail}>`)

  console.log(`\n=== Automation rules in this workspace ===`)
  const rules = await prisma.automationRule.findMany({
    where: { workspaceId: session.workspace.id },
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
    console.log(`  [${r.isActive ? 'on ' : 'off'}] ${r.name}  trigger=${r.triggerType}`)
    for (const s of r.steps) {
      console.log(`     step ${s.order}: ${s.channel}  timing=${s.timingMode} delay=${s.delayMinutes}min  email=${s.emailTemplateId ? 'yes' : 'no'} sms=${s.smsBody ? 'yes' : 'no'}`)
    }
  }

  console.log(`\n=== AutomationExecutions for this session ===`)
  const execs = await prisma.automationExecution.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, status: true, channel: true, scheduledFor: true, sentAt: true,
      errorMessage: true, qstashMessageId: true,
      step: { select: { timingMode: true, delayMinutes: true } },
      automationRule: { select: { name: true, triggerType: true } },
    },
  })
  if (execs.length === 0) console.log('  (no executions)')
  for (const e of execs) {
    const ruleName = e.automationRule?.name || '?'
    const trig = e.automationRule?.triggerType || '?'
    const tm = e.step?.timingMode || '-'
    const dm = e.step?.delayMinutes ?? '-'
    console.log(`  [${e.status}] ${trig} (${tm}=${dm}m) "${ruleName}" sched=${e.scheduledFor?.toISOString() || '-'} sent=${e.sentAt?.toISOString() || '-'} qstash=${e.qstashMessageId ? 'yes' : 'no'} err=${e.errorMessage ? e.errorMessage.substring(0, 80) : '-'}`)
  }
  await prisma.$disconnect()
}
main().catch(console.error).finally(() => process.exit(0))
