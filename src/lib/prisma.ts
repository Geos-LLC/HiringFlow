import { PrismaClient } from '@prisma/client'
import { attachLifecycleMiddleware } from './lifecycle-middleware'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaLifecycleAttached: boolean | undefined
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

// Attach the lifecycle middleware exactly once per process — Next.js
// hot-reloads share `globalForPrisma.prisma` in dev, so guard against
// re-registering the $use hook (Prisma allows it but each registration
// adds another invocation on every query).
if (!globalForPrisma.prismaLifecycleAttached) {
  attachLifecycleMiddleware(prisma)
  globalForPrisma.prismaLifecycleAttached = true
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
