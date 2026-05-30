import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
async function main() {
  const flow = await p.flow.findUnique({
    where: { id: 'df8473ec-166d-48ae-a3dc-d7b30bf9061c' },
    select: { name: true, schedulingTimeoutHours: true, trainingTimeoutDays: true, backgroundCheckTimeoutDays: true, videoInterviewTimeoutDays: true, noShowTimeoutHours: true },
  })
  console.log('Flow timeouts:', flow)
  const session = await p.session.findUnique({
    where: { id: '289d02df-fcb2-46db-b7ab-81da0d4ad54b' },
    select: { id: true, pipelineStatus: true, status: true },
  })
  console.log('Viktoryia session:', session)
  const queued = await p.automationExecution.findMany({
    where: { sessionId: '289d02df-fcb2-46db-b7ab-81da0d4ad54b', status: { in: ['queued','pending','cancelled'] } },
    include: { automationRule: { select: { name: true, stageId: true } } },
  })
  console.log('Queued/cancelled execs:')
  for (const e of queued) console.log(' ', e.status, '|', e.automationRule.name, 'stageId=', e.automationRule.stageId, 'scheduledFor=', e.scheduledFor?.toISOString())
  await p.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
