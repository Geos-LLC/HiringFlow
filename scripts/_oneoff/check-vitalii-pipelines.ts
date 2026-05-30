import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'

  const pipes = await prisma.pipeline.findMany({ where: { workspaceId } })
  for (const p of pipes as any[]) {
    console.log(`  ${p.id}  ${p.name}`)
  }
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
