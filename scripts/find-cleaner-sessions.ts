import { PrismaClient } from '@prisma/client'

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'
const CLEANER_PIPELINE_ID = '418cac55-be00-4412-bf57-1412bf54218a'

async function main() {
  const prisma = new PrismaClient()

  // Cleaner pipeline stages (stored as JSON on Pipeline.stages)
  const pipeline = await prisma.pipeline.findUnique({
    where: { id: CLEANER_PIPELINE_ID },
    select: { stages: true },
  })
  const stages = (pipeline?.stages as Array<{ id?: string; key?: string; label?: string }> | null) ?? []
  console.log(`Cleaner pipeline stages (${stages.length}):`)
  for (const s of stages) console.log(`  ${JSON.stringify(s)}`)
  console.log()

  // Sessions in Cleaner — match by flow.pipelineId OR pipelineStatus = a Cleaner stage key/id
  const stageKeys = stages.flatMap((s) => [s.id, s.key].filter(Boolean) as string[])
  const sessions = await prisma.session.findMany({
    where: {
      workspaceId: WORKSPACE_ID,
      OR: [
        ...(stageKeys.length ? [{ pipelineStatus: { in: stageKeys } }] : []),
        { flow: { pipelineId: CLEANER_PIPELINE_ID } },
      ],
    },
    select: {
      id: true, candidateName: true, candidateEmail: true,
      pipelineStatus: true, status: true, dispositionReason: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
      flow: { select: { id: true, name: true, pipelineId: true } },
    },
    orderBy: { startedAt: 'desc' },
    take: 100,
  })
  console.log(`Sessions in Cleaner (${sessions.length} max 100):`)
  for (const s of sessions) {
    console.log(`  ${s.id}  ${s.candidateName} <${s.candidateEmail}>`)
    console.log(`    flow="${s.flow?.name}" flowPipelineId=${s.flow?.pipelineId ?? '-'}`)
    console.log(`    pipelineStatus=${s.pipelineStatus} status=${s.status} dispo=${s.dispositionReason ?? '-'}  started=${s.startedAt.toISOString()}`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
