import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const sessionId = '6862cb98-2cab-49d1-942b-8bedaf9c723c'
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'
  const flowId = '0a71728f-d344-45b8-9918-63d67a170147'

  // Detailed rule scope
  const meetingScheduledRules = await prisma.automationRule.findMany({
    where: { workspaceId, triggerType: 'meeting_scheduled' },
  })
  console.log('meeting_scheduled rules:\n')
  for (const r of meetingScheduledRules as any[]) {
    console.log(`  ${JSON.stringify({ id: r.id, name: r.name, isActive: r.isActive, flowId: r.flowId, pipelineId: r.pipelineId, trainingId: r.trainingId, createdAt: r.createdAt, updatedAt: r.updatedAt })}`)
  }

  // Flow + pipeline
  const flow = await prisma.flow.findUnique({ where: { id: flowId }, select: { id: true, name: true, pipelineId: true } })
  console.log(`\nFlow: ${JSON.stringify(flow)}`)

  // All SchedulingEvents in full
  const events = await prisma.schedulingEvent.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`\nSchedulingEvents (${events.length}):`)
  for (const e of events as any[]) {
    console.log(`  ${JSON.stringify({ id: e.id, type: e.type, kind: e.kind, eventType: e.eventType, source: e.source, createdAt: e.createdAt, schedulingConfigId: e.schedulingConfigId, metadata: e.metadata })}`)
  }

  // ProcessedWorkspaceEvent or similar to detect external Google Calendar bookings
  try {
    const processed = await prisma.processedWorkspaceEvent.findMany({
      where: { metadata: { path: ['sessionId'], equals: sessionId } as any },
      orderBy: { createdAt: 'asc' },
    }).catch(() => [])
    console.log(`\nProcessedWorkspaceEvent (${processed.length})`)
  } catch (e) {}

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
