import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20' // Spotless Homes Florida LLC
  const before = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, recallBotEnabled: true },
  })
  console.log('Before:', before)
  if (!before) { console.log('workspace not found'); return }
  if (before.recallBotEnabled) { console.log('already enabled — no-op'); return }
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { recallBotEnabled: true },
  })
  const after = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, recallBotEnabled: true },
  })
  console.log('After:', after)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
