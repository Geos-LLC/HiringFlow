/**
 * One-off backfill: Sugheily completed "Test job preparation" before
 * applyStageTrigger learned to auto-advance on completion. Replay the
 * training_completed event so the runtime advances her stage and fires the
 * Background check rule.
 */
import { fireTrainingCompletedAutomations } from '../src/lib/automation'
import { prisma } from '../src/lib/prisma'

async function main() {
  const sessionId = 'b6030910-2aaf-4ebe-99d9-0da98e16cd1a'
  const trainingId = '0ca261c9-02d1-43c4-be1f-69b125a3f6ad' // Test job preparation

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, workspaceId: true, flowId: true, pipelineStatus: true, candidateName: true },
  })
  if (!session) { console.error('Session not found'); process.exit(1) }

  console.log(`Before: ${session.candidateName} pipelineStatus=${session.pipelineStatus}`)

  console.log('\nReplaying training_completed (will apply stage + fire automations)...')
  await fireTrainingCompletedAutomations(sessionId, trainingId)

  const after = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { pipelineStatus: true },
  })
  console.log(`After: pipelineStatus=${after?.pipelineStatus}`)

  // Inspect what fired
  const execs = await prisma.automationExecution.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      status: true, channel: true, createdAt: true,
      automationRule: { select: { name: true } },
    },
  })
  console.log('\nLatest 5 automation executions:')
  for (const e of execs) {
    console.log(`  [${e.status}] ${e.automationRule?.name} ch=${e.channel}  created=${e.createdAt.toISOString()}`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
