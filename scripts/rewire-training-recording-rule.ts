/**
 * Rewire the "Training email after completing recording" rule for the
 * Dispatcher pipeline from triggerType='recording_ready' (which is a Google
 * Meet recording event, not a flow voice-recording event) to 'flow_completed'
 * so it fires when the candidate finishes the voice-recording flow.
 */
import { PrismaClient } from '@prisma/client'

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'
const DISPATCHER_PIPELINE_ID = '9aa5ea9d-4e18-420f-b25c-215b477ed302'

async function main() {
  const prisma = new PrismaClient()

  const rule = await prisma.automationRule.findFirst({
    where: {
      workspaceId: WORKSPACE_ID,
      pipelineId: DISPATCHER_PIPELINE_ID,
      name: 'Training email after completing recording',
    },
    select: { id: true, name: true, triggerType: true, stageId: true, pipelineId: true, isActive: true },
  })
  if (!rule) {
    console.error('Rule not found')
    process.exit(1)
  }

  console.log('BEFORE:', rule)

  const updated = await prisma.automationRule.update({
    where: { id: rule.id },
    data: { triggerType: 'flow_completed' },
    select: { id: true, name: true, triggerType: true, stageId: true, pipelineId: true, isActive: true },
  })

  console.log('AFTER :', updated)

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
