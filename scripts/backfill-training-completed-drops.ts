/**
 * One-shot backfill for `training_completed` events that were dropped by the
 * fire-and-forget lifecycle middleware before cron Rule 3 shipped (f3d5889).
 *
 * Same shape as the cron sweep but with a 14d lookback instead of 24h:
 *   - find every TrainingEnrollment with completedAt set in the window
 *   - skip halted sessions (guard would skip them anyway)
 *   - skip if any training_completed AutomationExecution already exists
 *   - skip if no eligible active rule in the workspace
 *   - fire fireTrainingCompletedAutomations with executionMode='cron'
 *
 * Dry-run by default. Pass --apply to actually fire.
 */
import { PrismaClient } from '@prisma/client'
import { fireTrainingCompletedAutomations } from '../src/lib/automation'

const APPLY = process.argv.includes('--apply')
const LOOKBACK_DAYS = 14

async function main() {
  const prisma = new PrismaClient()
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000)
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}  cutoff=${cutoff.toISOString()}\n`)

  const enrollments = await prisma.trainingEnrollment.findMany({
    where: {
      completedAt: { gte: cutoff, not: null },
      sessionId: { not: null },
    },
    orderBy: { completedAt: 'asc' },
    select: {
      id: true,
      sessionId: true,
      trainingId: true,
      completedAt: true,
      training: { select: { title: true } },
      session: {
        select: {
          workspaceId: true,
          candidateName: true,
          candidateEmail: true,
          pipelineStatus: true,
          status: true,
          automationsHaltedAt: true,
          workspace: { select: { name: true } },
        },
      },
    },
  })
  console.log(`Found ${enrollments.length} completed enrollments in window.\n`)

  let candidates = 0
  let firedCount = 0
  let skipHalted = 0
  let skipAlreadyDispatched = 0
  let skipNoEligibleRule = 0
  let skipNoSession = 0
  let errors = 0

  for (const e of enrollments) {
    const sessionId = e.sessionId
    if (!sessionId || !e.session) { skipNoSession++; continue }
    candidates++

    if (e.session.automationsHaltedAt) {
      skipHalted++
      console.log(`  HALTED: ${e.session.candidateName ?? '?'} <${e.session.candidateEmail ?? '-'}>  ws=${e.session.workspace.name}  training="${e.training.title}"  haltedAt=${e.session.automationsHaltedAt.toISOString()}`)
      continue
    }

    const existing = await prisma.automationExecution.findFirst({
      where: {
        sessionId,
        automationRule: { triggerType: 'training_completed' },
      },
      select: { id: true },
    })
    if (existing) { skipAlreadyDispatched++; continue }

    const eligible = await prisma.automationRule.findFirst({
      where: {
        workspaceId: e.session.workspaceId,
        isActive: true,
        triggerType: 'training_completed',
        OR: [{ trainingId: e.trainingId }, { trainingId: null }],
      },
      select: { id: true, name: true },
    })
    if (!eligible) {
      skipNoEligibleRule++
      continue
    }

    console.log(`  ${APPLY ? 'FIRING' : 'WOULD-FIRE'}: ${e.session.candidateName ?? '?'} <${e.session.candidateEmail ?? '-'}>  ws=${e.session.workspace.name}  training="${e.training.title}"  rule="${eligible.name}"  completedAt=${e.completedAt?.toISOString()}  pipelineStatus=${e.session.pipelineStatus}`)

    if (APPLY) {
      try {
        await fireTrainingCompletedAutomations(sessionId, e.trainingId, { executionMode: 'cron' })
        firedCount++
      } catch (err) {
        errors++
        console.error(`    ERROR firing for ${sessionId}:`, err)
      }
    }
  }

  console.log('\n─'.repeat(60))
  console.log(`Summary (lookback=${LOOKBACK_DAYS}d):`)
  console.log(`  scanned enrollments     : ${enrollments.length}`)
  console.log(`  with session            : ${candidates}`)
  console.log(`  skipped (halted)        : ${skipHalted}`)
  console.log(`  skipped (already done)  : ${skipAlreadyDispatched}`)
  console.log(`  skipped (no rule wired) : ${skipNoEligibleRule}`)
  console.log(`  skipped (no session)    : ${skipNoSession}`)
  console.log(`  ${APPLY ? 'fired' : 'would-fire'}                 : ${APPLY ? firedCount : (candidates - skipHalted - skipAlreadyDispatched - skipNoEligibleRule)}`)
  if (errors) console.log(`  errors                  : ${errors}`)

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
