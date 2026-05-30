import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const pipelines = await prisma.pipeline.findMany({
    select: { id: true, name: true, isDefault: true, stages: true, workspaceId: true },
    orderBy: [{ workspaceId: 'asc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
  })
  for (const p of pipelines) {
    const stages = Array.isArray(p.stages) ? p.stages as Array<Record<string, unknown>> : []
    console.log(`[${p.workspaceId.slice(0, 8)}] ${p.name}${p.isDefault ? ' (default)' : ''}  — ${stages.length} stages`)
    for (const s of stages) {
      console.log(`    ${s.id}  "${s.label ?? '?'}"`)
    }
    console.log()
  }
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
