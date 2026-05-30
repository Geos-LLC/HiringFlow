import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const ruleId = '63160fd1-7b55-401f-8a31-2d477278fd4b'

  const r = await prisma.automationRule.findUnique({
    where: { id: ruleId },
    select: {
      id: true, name: true, triggerType: true, stageId: true, pipelineId: true,
      isActive: true, flowId: true, trainingId: true, updatedAt: true, createdAt: true,
    },
  })
  console.log('Rule:', JSON.stringify(r, null, 2))

  const steps = await prisma.automationStep.findMany({
    where: { ruleId },
    orderBy: { order: 'asc' },
    select: {
      id: true, order: true, channel: true, delayMinutes: true, timingMode: true,
      emailDestination: true, emailTemplateId: true, nextStepType: true, trainingId: true,
    },
  })
  console.log('Steps:', JSON.stringify(steps, null, 2))

  // Also list ALL active rules in the workspace whose triggerType is recording_ready or flow_completed
  const rules = await prisma.automationRule.findMany({
    where: {
      workspaceId: '739bcd71-69fd-4b30-a39e-242521b7ab20',
      isActive: true,
      triggerType: { in: ['recording_ready', 'flow_completed', 'flow_passed'] },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, triggerType: true, stageId: true, pipelineId: true, flowId: true, trainingId: true },
  })
  console.log()
  console.log(`All active recording/flow rules in workspace (${rules.length}):`)
  for (const x of rules) {
    console.log(`  ${x.id} "${x.name}" trig=${x.triggerType} flow=${x.flowId ?? 'ANY'} train=${x.trainingId ?? '-'} stage=${x.stageId ?? '-'} pipe=${x.pipelineId ?? 'ANY'}`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
