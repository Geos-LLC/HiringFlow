import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'
  const flowId = 'df8473ec-166d-48ae-a3dc-d7b30bf9061c'

  const flow = await prisma.flow.findUnique({
    where: { id: flowId },
    select: { id: true, name: true, pipelineId: true },
  })
  console.log(`Flow: ${flow?.name}  pipelineId=${flow?.pipelineId ?? '(null → default)'}`)

  const pipelines = await prisma.pipeline.findMany({
    where: { workspaceId },
    select: { id: true, name: true, isDefault: true, stages: true },
  })
  for (const p of pipelines) {
    console.log(`\n=== Pipeline ${p.id} "${p.name}" default=${p.isDefault} ===`)
    const stages = p.stages as any[]
    if (!Array.isArray(stages)) {
      console.log('  (stages is not an array)', stages)
      continue
    }
    for (const st of stages) {
      const trigs = Array.isArray(st.triggers) ? st.triggers : []
      console.log(`  [${st.order}] id=${st.id} label="${st.label}"`)
      if (trigs.length === 0) {
        console.log(`      triggers: (none — manual move only)`)
      } else {
        for (const t of trigs) {
          console.log(`      trigger: event=${t.event}  targetId=${t.targetId ?? '(wildcard)'}`)
        }
      }
    }
  }

  // List trainings for this workspace so we can map targetIds
  console.log(`\n=== Trainings in workspace ===`)
  const trainings = await prisma.training.findMany({
    where: { workspaceId },
    select: { id: true, title: true },
  })
  for (const t of trainings) {
    console.log(`  ${t.id}  "${t.title}"`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
