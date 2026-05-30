/**
 * Re-fire `recording_ready` for Arman Khachatryan's newer completed
 * session (0da21568, 2026-05-26 22:14). The older session (0b3556c2)
 * is left alone to avoid sending a duplicate training email.
 */
import { PrismaClient } from '@prisma/client'
import { fireFlowRecordingReadyAutomations } from '../../src/lib/automation'

const SESSION_ID = '0da21568-64d3-463b-a153-5475f0fae014'

async function main() {
  const prisma = new PrismaClient()

  const before = await prisma.automationExecution.findMany({
    where: { sessionId: SESSION_ID, automationRule: { triggerType: 'recording_ready' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, skipReason: true, createdAt: true, sentAt: true },
  })
  console.log(`BEFORE (${before.length}):`)
  for (const e of before) console.log(`  ${e.createdAt.toISOString()}  ${e.status}${e.skipReason ? ' / ' + e.skipReason : ''}  sentAt=${e.sentAt?.toISOString() ?? '-'}`)
  console.log()

  console.log('Calling fireFlowRecordingReadyAutomations (manual_rerun)...')
  await fireFlowRecordingReadyAutomations(SESSION_ID, { executionMode: 'manual_rerun' })
  console.log('Done.\n')

  const after = await prisma.automationExecution.findMany({
    where: { sessionId: SESSION_ID, automationRule: { triggerType: 'recording_ready' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, skipReason: true, createdAt: true, sentAt: true },
  })
  console.log(`AFTER (${after.length}):`)
  for (const e of after) console.log(`  ${e.createdAt.toISOString()}  ${e.status}${e.skipReason ? ' / ' + e.skipReason : ''}  sentAt=${e.sentAt?.toISOString() ?? '-'}`)

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
