import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  // Find every "Cleaner" pipeline across workspaces, with flow counts and
  // session counts so we can identify which one the user means.
  const pipelines = await prisma.pipeline.findMany({
    where: { name: { contains: 'cleaner', mode: 'insensitive' } },
    select: { id: true, name: true, workspaceId: true, workspace: { select: { name: true } } },
  })
  console.log(`Found ${pipelines.length} pipeline(s) matching "cleaner":`)
  for (const p of pipelines) {
    const flows = await prisma.flow.findMany({
      where: { pipelineId: p.id },
      select: { id: true, name: true, slug: true, isPublished: true, _count: { select: { sessions: true } } },
    })
    console.log(`\n  pipeline ${p.id}  "${p.name}"  workspace="${p.workspace.name}" (${p.workspaceId})`)
    console.log(`    flows: ${flows.length}`)
    for (const f of flows) {
      console.log(`      ${f.id}  "${f.name}" (slug=${f.slug}) published=${f.isPublished} sessions=${f._count.sessions}`)
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
