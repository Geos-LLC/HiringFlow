import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { candidateEmail: 'yekaterinadyshkant@gmail.com' },
        { candidateEmail: 'davidkovtun19@gmail.com' },
      ],
    },
    select: {
      id: true,
      candidateName: true,
      candidateEmail: true,
      status: true,
      dispositionReason: true,
      rejectionReason: true,
      pipelineStatus: true,
      stalledAt: true,
      lostAt: true,
      hiredAt: true,
      startedAt: true,
      flow: { select: { id: true, name: true, pipelineId: true } },
    },
    orderBy: { startedAt: 'desc' },
  })

  for (const s of sessions) {
    console.log(`\n${s.candidateName} <${s.candidateEmail}>`)
    console.log(`  id: ${s.id}`)
    console.log(`  status: ${s.status}`)
    console.log(`  dispositionReason: ${s.dispositionReason ?? '-'}`)
    console.log(`  rejectionReason: ${s.rejectionReason ?? '-'}`)
    console.log(`  pipelineStatus: ${s.pipelineStatus ?? '-'}`)
    console.log(`  stalledAt: ${s.stalledAt?.toISOString() ?? '-'}`)
    console.log(`  lostAt: ${s.lostAt?.toISOString() ?? '-'}`)
    console.log(`  hiredAt: ${s.hiredAt?.toISOString() ?? '-'}`)
    console.log(`  flow: ${s.flow?.name ?? '-'}  pipelineId=${s.flow?.pipelineId ?? '-'}`)

    // Pipeline status change history
    const changes = await prisma.pipelineStatusChange.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, fromStatus: true, toStatus: true, source: true },
    })
    console.log(`  pipeline transitions (${changes.length}):`)
    for (const c of changes) {
      console.log(`    ${c.createdAt.toISOString()}  ${c.fromStatus ?? '∅'} → ${c.toStatus}  src=${c.source}`)
    }
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
