import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  // Candidates whose status is "live" (not stalled/lost/hired) but who still
  // carry an automationsHaltedAt — only possible if a forward-progress event
  // reactivated them after a cron stall without clearing the halt.
  const orphaned = await prisma.session.findMany({
    where: {
      status: { in: ['active', 'waiting', 'nurture'] },
      automationsHaltedAt: { not: null },
    },
    orderBy: { automationsHaltedAt: 'desc' },
    select: {
      id: true,
      candidateName: true,
      candidateEmail: true,
      status: true,
      pipelineStatus: true,
      stalledAt: true,
      automationsHaltedAt: true,
      automationsHaltedReason: true,
      workspace: { select: { name: true } },
    },
  })

  console.log(`Found ${orphaned.length} session(s) with status=active/waiting/nurture but automationsHaltedAt set:\n`)
  for (const s of orphaned) {
    console.log(`  ${s.candidateName} <${s.candidateEmail}>  ws="${s.workspace.name}"`)
    console.log(`    status=${s.status} pipelineStatus=${s.pipelineStatus} stalledAt=${s.stalledAt?.toISOString() ?? 'null'}`)
    console.log(`    automationsHaltedAt=${s.automationsHaltedAt?.toISOString()} reason=${s.automationsHaltedReason}`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
