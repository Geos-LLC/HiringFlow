import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  // User typed sofigrinbergsork — likely a typo for sofigrinbergwork. Try both.
  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { candidateEmail: { equals: 'sofigrinbergsork@gmail.com', mode: 'insensitive' } },
        { candidateEmail: { equals: 'sofigrinbergwork@gmail.com', mode: 'insensitive' } },
        { candidateName: { contains: 'Sofiia', mode: 'insensitive' } },
        { candidateName: { contains: 'Sofia', mode: 'insensitive' } },
      ],
    },
    orderBy: { startedAt: 'desc' },
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Found ${sessions.length} session(s) matching Sofiia\n`)

  for (const s of sessions) {
    console.log('='.repeat(80))
    console.log(`Session ${s.id}`)
    console.log(`  ${s.candidateName} <${s.candidateEmail}>  phone=${s.candidatePhone ?? '-'}`)
    console.log(`  workspaceId=${s.workspaceId}`)
    console.log(`  flowId=${s.flowId}`)

    const flow = await prisma.flow.findUnique({
      where: { id: s.flowId },
      select: { name: true, slug: true, pipelineId: true, workspaceId: true },
    })
    const pipeline = flow?.pipelineId ? await prisma.pipeline.findUnique({
      where: { id: flow.pipelineId },
      select: { id: true, name: true, workspaceId: true },
    }) : null

    console.log(`  flow: "${flow?.name}" (slug=${flow?.slug}) pipelineId=${flow?.pipelineId ?? '-'}`)
    console.log(`  pipeline: "${pipeline?.name ?? '(none)'}" (${pipeline?.id ?? '-'})`)
    console.log(`  pipelineStatus=${s.pipelineStatus} status=${s.status} dispo=${s.dispositionReason ?? '-'}`)
    console.log(`  startedAt=${s.startedAt.toISOString()} finishedAt=${s.finishedAt?.toISOString() ?? '-'} lastActivityAt=${s.lastActivityAt?.toISOString() ?? '-'}`)
    console.log(`  outcome=${s.outcome ?? '-'} automationsHaltedAt=${s.automationsHaltedAt?.toISOString() ?? '-'} reason=${s.automationsHaltedReason ?? '-'}`)
    console.log()
  }

  // Also list all flows in the workspaces involved so user can see if same
  // flow exists under two pipelines (slug "speaking-test-2" duplicated, etc.)
  const wsIds = [...new Set(sessions.map((s) => s.workspaceId))]
  for (const wsId of wsIds) {
    const flows = await prisma.flow.findMany({
      where: { workspaceId: wsId, name: { contains: 'speaking', mode: 'insensitive' } },
      select: { id: true, name: true, slug: true, pipelineId: true, isPublished: true },
    })
    console.log(`Flows in workspace ${wsId} matching "speaking":`)
    for (const f of flows) {
      const p = f.pipelineId ? await prisma.pipeline.findUnique({ where: { id: f.pipelineId }, select: { name: true } }) : null
      console.log(`  ${f.id}  "${f.name}" (slug=${f.slug})  pipeline="${p?.name ?? '-'}"  published=${f.isPublished}`)
    }
    console.log()

    const allPipelines = await prisma.pipeline.findMany({
      where: { workspaceId: wsId },
      select: { id: true, name: true },
    })
    console.log(`All pipelines in workspace ${wsId}:`)
    for (const p of allPipelines) console.log(`  ${p.id}  "${p.name}"`)
    console.log()
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
