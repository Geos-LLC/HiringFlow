import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const gi = await prisma.googleIntegration.findUnique({
    where: { workspaceId: '739bcd71-69fd-4b30-a39e-242521b7ab20' },
    select: {
      googleEmail: true,
      accessToken: true,
      refreshToken: true,
      accessExpiresAt: true,
      lastSyncedAt: true,
      updatedAt: true,
    },
  })
  if (!gi) return
  console.log(JSON.stringify({
    googleEmail: gi.googleEmail,
    accessExpiresAt: gi.accessExpiresAt?.toISOString(),
    lastSyncedAt: gi.lastSyncedAt?.toISOString(),
    updatedAt: gi.updatedAt.toISOString(),
    accessToken: gi.accessToken ? `<${gi.accessToken.length} chars, prefix=${gi.accessToken.slice(0, 10)}...>` : null,
    refreshToken: gi.refreshToken ? `<${gi.refreshToken.length} chars, prefix=${gi.refreshToken.slice(0, 10)}...>` : null,
  }, null, 2))
  await prisma.$disconnect()
}
main().catch(console.error).finally(() => process.exit(0))
