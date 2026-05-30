/**
 * Audit every session whose flow lives in the Dispatcher pipeline:
 *   - did they finish the voice-recording flow?
 *   - did the recording-ready / training-completed / etc automations skip?
 *   - what does the candidate detail page's `automationExecutions` array look like for them?
 */
import { PrismaClient } from '@prisma/client'

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'
const DISPATCHER_PIPELINE_ID = '9aa5ea9d-4e18-420f-b25c-215b477ed302'

async function main() {
  const prisma = new PrismaClient()

  const flows = await prisma.flow.findMany({
    where: { workspaceId: WORKSPACE_ID, pipelineId: DISPATCHER_PIPELINE_ID },
    select: { id: true, name: true, slug: true },
  })
  console.log(`Dispatcher-pipeline flows (${flows.length}): ${flows.map(f => f.name).join(', ')}`)
  console.log()

  const flowIds = flows.map(f => f.id)
  const sessions = await prisma.session.findMany({
    where: { workspaceId: WORKSPACE_ID, flowId: { in: flowIds } },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, candidateName: true, candidateEmail: true,
      pipelineStatus: true, status: true,
      startedAt: true, finishedAt: true,
      flow: { select: { name: true } },
    },
  })
  console.log(`Sessions in Dispatcher pipeline (${sessions.length}):\n`)

  let totalSent = 0
  let totalSkipped = 0
  let totalCandidatesAffected = 0

  for (const s of sessions) {
    const execs = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, status: true, channel: true, executionMode: true,
        sentAt: true, createdAt: true,
        automationRule: { select: { name: true, triggerType: true, stageId: true } },
      },
    })

    const skipped = execs.filter(e => e.status?.startsWith('skipped_'))
    const sent = execs.filter(e => e.status === 'sent')

    if (skipped.length > 0) totalCandidatesAffected++
    totalSent += sent.length
    totalSkipped += skipped.length

    const flowFinished = s.finishedAt ? 'yes' : 'no'
    console.log(`${s.candidateName ?? '(no name)'} <${s.candidateEmail ?? '-'}>`)
    console.log(`  id=${s.id}  flow="${s.flow?.name}" finishedFlow=${flowFinished}  pipelineStatus=${s.pipelineStatus}`)
    console.log(`  sent=${sent.length}  skipped=${skipped.length}  total=${execs.length}`)
    for (const e of execs) {
      const tag = e.status === 'sent' ? '✓' : e.status?.startsWith('skipped_') ? '✗' : '·'
      console.log(`    ${tag} [${e.status}] ${e.automationRule?.name}  trig=${e.automationRule?.triggerType} ruleStage=${e.automationRule?.stageId ?? '-'} mode=${e.executionMode} ch=${e.channel}`)
    }
    console.log()
  }

  console.log('─'.repeat(80))
  console.log(`SUMMARY: ${sessions.length} candidates, ${totalCandidatesAffected} affected by skips, ${totalSent} sent, ${totalSkipped} skipped`)

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
