import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  const sessions = await prisma.session.findMany({
    where: { candidateEmail: { equals: 'mrmrarman@gmail.com', mode: 'insensitive' } },
    orderBy: { startedAt: 'desc' },
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Found ${sessions.length} session(s) for mrmrarman@gmail.com\n`)

  for (const s of sessions) {
    console.log('='.repeat(80))
    console.log(`Session ${s.id}`)
    console.log(`  ${s.candidateName} <${s.candidateEmail}>`)
    console.log(`  flowId=${s.flowId} pipelineStatus=${s.pipelineStatus} status=${s.status} outcome=${s.outcome ?? '-'}`)
    console.log(`  startedAt=${s.startedAt.toISOString()} finishedAt=${s.finishedAt?.toISOString() ?? '-'} lastActivityAt=${s.lastActivityAt?.toISOString() ?? '-'}`)
    console.log()

    const captures = await prisma.captureResponse.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
    })
    console.log(`CaptureResponses (${captures.length}):`)
    for (const c of captures) {
      console.log(`  ${c.createdAt.toISOString()} mode=${c.mode} status=${c.status} duration=${c.durationSec ?? '-'}s`)
    }
    console.log()

    const events = await prisma.schedulingEvent.findMany({
      where: { sessionId: s.id },
      orderBy: { eventAt: 'asc' },
      select: { eventType: true, eventAt: true, metadata: true },
    })
    console.log(`SchedulingEvents (${events.length}):`)
    for (const e of events) {
      const meta = e.metadata as Record<string, unknown> | null
      console.log(`  ${e.eventAt.toISOString()} ${e.eventType}${meta ? ' meta=' + JSON.stringify(meta).slice(0, 200) : ''}`)
    }
    console.log()

    const executions = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
      include: {
        automationRule: { select: { id: true, name: true, triggerType: true, stageId: true, isActive: true } },
        step: { select: { channel: true, nextStepType: true, trainingId: true, emailDestination: true, delayMinutes: true } },
      },
    })
    console.log(`AutomationExecutions (${executions.length}):`)
    for (const e of executions) {
      const r = e.automationRule
      console.log(`  ${e.createdAt.toISOString()} [${e.status}${e.skipReason ? ' / ' + e.skipReason : ''}] "${r?.name}" trig=${r?.triggerType} stage=${r?.stageId ?? '-'} active=${r?.isActive}`)
      console.log(`    step: ch=${e.step?.channel} type=${e.step?.nextStepType} email→${e.step?.emailDestination} delay=${e.step?.delayMinutes ?? '-'}m`)
      console.log(`    exec: channel=${e.channel ?? '-'} mode=${e.executionMode ?? '-'} sentAt=${e.sentAt?.toISOString() ?? '-'} delivery=${e.deliveryStatus ?? '-'} deliveryAt=${e.deliveryStatusAt?.toISOString() ?? '-'}`)
    }
    console.log()
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
