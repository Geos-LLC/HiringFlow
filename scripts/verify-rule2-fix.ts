import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const now = new Date()
  const TRAINING_TIMEOUT_DAYS_DEFAULT = 5

  const flows = await prisma.flow.findMany({
    select: { id: true, name: true, trainingTimeoutDays: true },
  })

  console.log(`Dry-run new Rule 2 (per-token scoping). NOW=${now.toISOString()}\n`)

  let total = 0
  for (const flow of flows) {
    const days = flow.trainingTimeoutDays ?? TRAINING_TIMEOUT_DAYS_DEFAULT
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

    const stuckTokens = await prisma.trainingAccessToken.findMany({
      where: {
        usedAt: null,
        createdAt: { lt: cutoff },
        candidate: {
          flowId: flow.id,
          status: 'active',
        },
        enrollments: { none: { status: { not: 'not_started' } } },
      },
      select: {
        candidateId: true,
        id: true,
        createdAt: true,
        training: { select: { title: true } },
        candidate: { select: { candidateName: true, candidateEmail: true, status: true, pipelineStatus: true } },
      },
    })

    if (stuckTokens.length === 0) continue
    console.log(`Flow "${flow.name}" (timeout=${days}d, cutoff=${cutoff.toISOString()}):`)
    for (const t of stuckTokens) {
      const ageDays = (now.getTime() - t.createdAt.getTime()) / (1000 * 60 * 60 * 24)
      console.log(`  ${t.candidate?.candidateName} <${t.candidate?.candidateEmail}>  status=${t.candidate?.status}  pipelineStatus=${t.candidate?.pipelineStatus}  training="${t.training.title}"  tokenAge=${ageDays.toFixed(1)}d`)
    }
    total += stuckTokens.length
    console.log()
  }

  console.log(`Total stuck tokens that would flip to stalled: ${total}`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
