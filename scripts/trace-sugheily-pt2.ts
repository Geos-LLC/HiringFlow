import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const sessionId = 'b6030910-2aaf-4ebe-99d9-0da98e16cd1a'
  const flowId = 'df8473ec-166d-48ae-a3dc-d7b30bf9061c'
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'

  // Look up the Schedule notification + Background check rules in full
  const scheduleRule = await prisma.automationRule.findFirst({
    where: { workspaceId, name: 'Schedule notification' },
    include: {
      steps: { orderBy: { order: 'asc' } },
      flow: { select: { id: true, name: true } },
    },
  })
  console.log('=== "Schedule notification" rule ===')
  if (scheduleRule) {
    console.log(`  id=${scheduleRule.id}  flowId=${scheduleRule.flowId} (${scheduleRule.flow?.name})  active=${scheduleRule.isActive}`)
    console.log(`  triggerType=${scheduleRule.triggerType}  stageId=${scheduleRule.stageId}`)
    for (const s of scheduleRule.steps) {
      console.log(`    step ${s.order}: id=${s.id} ch=${s.channel} timing=${s.timingMode} delay=${s.delayMinutes}min nextStepType=${s.nextStepType} nextStepUrl=${s.nextStepUrl ?? '-'}`)
    }
  }

  const bgRule = await prisma.automationRule.findFirst({
    where: { workspaceId, name: 'Background check' },
    include: {
      steps: { orderBy: { order: 'asc' } },
      flow: { select: { id: true, name: true } },
    },
  })
  console.log('\n=== "Background check" rule ===')
  if (bgRule) {
    console.log(`  id=${bgRule.id}  flowId=${bgRule.flowId} (${bgRule.flow?.name})  active=${bgRule.isActive}`)
    console.log(`  triggerType=${bgRule.triggerType}  stageId=${bgRule.stageId}`)
    for (const s of bgRule.steps) {
      console.log(`    step ${s.order}: id=${s.id} ch=${s.channel} timing=${s.timingMode} delay=${s.delayMinutes}min nextStepType=${s.nextStepType}`)
    }
  }

  // Workspace pipeline stages
  console.log('\n=== Workspace pipeline(s) ===')
  const pipelines = await prisma.pipeline.findMany({
    where: { workspaceId },
    include: { stages: { orderBy: { order: 'asc' } } },
  })
  for (const p of pipelines) {
    console.log(`  Pipeline ${p.id} (${p.name})`)
    for (const st of p.stages) {
      console.log(`    ${st.id}  order=${st.order} kind=${st.kind} name="${st.name}"`)
    }
  }

  // Which pipeline does the flow use?
  const flow = await prisma.flow.findUnique({
    where: { id: flowId },
    select: { id: true, name: true, pipelineId: true },
  })
  console.log(`\nFlow ${flow?.name} → pipelineId=${flow?.pipelineId}`)

  // FunnelStageHistory for the session (if exists)
  // try a few possible table names
  try {
    const stageEvents = await (prisma as any).funnelStageEvent?.findMany?.({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    })
    if (stageEvents) {
      console.log(`\nFunnelStageEvent (${stageEvents.length}):`)
      for (const e of stageEvents) {
        console.log(`  ${e.createdAt?.toISOString?.()}  ${JSON.stringify(e)}`)
      }
    }
  } catch (e) {
    console.log('(no funnelStageEvent table)')
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
