import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const gi = await prisma.googleIntegration.findUnique({
    where: { workspaceId: '739bcd71-69fd-4b30-a39e-242521b7ab20' },
    select: {
      googleEmail: true,
      hostedDomain: true,
      accessExpiresAt: true,
      lastSyncedAt: true,
      watchExpiresAt: true,
      grantedScopes: true,
      recordingCapable: true,
      recordingCapabilityReason: true,
      updatedAt: true,
    },
  })
  console.log(JSON.stringify(gi, null, 2))
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
