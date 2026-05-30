import { PrismaClient } from '@prisma/client'
import { DEFAULT_TIMEOUTS } from '../src/lib/candidate-status'
const p = new PrismaClient()

async function main() {
  const now = new Date()
  // Look for candidates who STARTED training >5d ago but are still active.
  const stuck = await p.session.findMany({
    where: {
      status: 'active',
      trainingEnrollments: {
        some: {
          completedAt: null,
          startedAt: { lt: new Date(now.getTime() - 5 * 86400_000) },
        },
      },
    },
    select: {
      id: true,
      candidateName: true,
      candidateEmail: true,
      status: true,
      lastActivityAt: true,
      pipelineStatus: true,
      workspace: { select: { name: true } },
      flow: { select: { id: true, name: true, trainingTimeoutDays: true } },
      trainingEnrollments: {
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          training: { select: { title: true } },
        },
      },
    },
    take: 30,
  })

  console.log(`\nFound ${stuck.length} active session(s) with training enrollments older than 5 days:\n`)
  for (const s of stuck) {
    const enr = s.trainingEnrollments.find(e => !e.completedAt) || s.trainingEnrollments[0]
    if (!enr) continue
    const daysSinceStart = Math.round((now.getTime() - enr.startedAt.getTime()) / 86400_000)
    const flowTimeoutDays = s.flow?.trainingTimeoutDays ?? DEFAULT_TIMEOUTS.trainingTimeoutDays
    const cutoff = new Date(now.getTime() - flowTimeoutDays * 86400_000)
    const lastActDaysAgo = s.lastActivityAt ? Math.round((now.getTime() - s.lastActivityAt.getTime()) / 86400_000) : null
    const lastActPastCutoff = !s.lastActivityAt || s.lastActivityAt < cutoff
    const enrStatusOk = enr.status === 'in_progress'
    const wouldFlag = enrStatusOk && lastActPastCutoff
    console.log(`  ${s.candidateName ?? '?'}  <${s.candidateEmail ?? '-'}>  ws=${s.workspace.name}  flow="${s.flow?.name}"`)
    console.log(`     enrollment: status=${enr.status} startedAt=${enr.startedAt.toISOString()} (${daysSinceStart}d ago)  training="${enr.training.title}"`)
    console.log(`     pipelineStatus=${s.pipelineStatus} lastActivityAt=${s.lastActivityAt?.toISOString() ?? '-'} (${lastActDaysAgo}d ago)`)
    console.log(`     timeoutDays for this flow: ${flowTimeoutDays}  →  cutoff=${cutoff.toISOString()}`)
    console.log(`     would cron flag now?  enrInProgress=${enrStatusOk}  lastActPastCutoff=${lastActPastCutoff}  →  ${wouldFlag ? 'YES (but cron didn\'t run, or pseudo-recent activity)' : 'NO — guard prevents'}`)
    console.log()
  }
  await p.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
