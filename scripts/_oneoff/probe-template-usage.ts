/**
 * Probe: does the EmailTemplate GET query actually compute `usage` for the
 * Spotless Homes workspace? Mirrors the production route's query so a
 * mismatch between code intent and DB shape surfaces here.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const ws = '739bcd71-69fd-4b30-a39e-242521b7ab20'
  const templates = await prisma.emailTemplate.findMany({
    where: { workspaceId: ws },
    orderBy: { updatedAt: 'desc' },
    include: {
      automations: { select: { id: true, name: true } },
      steps: { select: { rule: { select: { id: true, name: true } } } },
    },
    take: 5,
  })

  for (const t of templates) {
    const refs = new Map<string, string>()
    for (const r of t.automations) refs.set(r.id, r.name)
    for (const s of t.steps) refs.set(s.rule.id, s.rule.name)
    console.log(`- ${t.name.padEnd(40)} rules=${t.automations.length} steps=${t.steps.length} uniqueRefs=${refs.size}`)
    for (const n of refs.values()) console.log(`    • ${n}`)
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
