import { PrismaClient } from '@prisma/client'
import { attachLifecycleMiddleware } from './lifecycle-middleware'

// JSON.stringify throws on bigint by default. Video.sizeBytes (and any future
// BigInt Prisma column) would otherwise break every NextResponse.json call
// that includes a row from those tables. Live here — not in instrumentation.ts
// — so it is guaranteed to run before the first Prisma read on every server
// function bundle (instrumentation.register runs at process boot, but relying
// on that for a per-request serializer is fragile). File sizes fit in a JS
// Number well past 9 petabytes, so returning a plain number keeps the wire
// format stable for clients that still declare `sizeBytes: number`.
if (!(BigInt.prototype as unknown as { toJSON?: unknown }).toJSON) {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function () { return Number(this) },
    writable: true,
    configurable: true,
  })
}

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
