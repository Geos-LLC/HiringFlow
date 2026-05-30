/**
 * Manually re-fire `recording_ready` automations for Alyona Rybachenko
 * (session 07c602d1-c543-41b4-979f-3fadb0da2b3f) now that the
 * automation-guard fix accepts CaptureResponse as a valid recording source
 * for the prereq. The original firing on 2026-05-28 09:38 was correctly
 * dispatched from /api/public/sessions/[id]/captures/finalize but skipped
 * by requireRecordingReady which only knew about InterviewMeeting.
 */
import { PrismaClient } from '@prisma/client'
import { fireFlowRecordingReadyAutomations } from '../../src/lib/automation'

const SESSION_ID = '07c602d1-c543-41b4-979f-3fadb0da2b3f'

async function main() {
  const prisma = new PrismaClient()

  const before = await prisma.automationExecution.findMany({
    where: {
      sessionId: SESSION_ID,
      automationRule: { triggerType: 'recording_ready' },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, skipReason: true, createdAt: true, sentAt: true },
  })
  console.log(`BEFORE (${before.length}):`)
  for (const e of before) console.log(`  ${e.createdAt.toISOString()}  ${e.status}${e.skipReason ? ' / ' + e.skipReason : ''}  sentAt=${e.sentAt?.toISOString() ?? '-'}`)
  console.log()

  console.log('Calling fireFlowRecordingReadyAutomations...')
  await fireFlowRecordingReadyAutomations(SESSION_ID, { executionMode: 'manual_rerun' })
  console.log('Done.\n')

  const after = await prisma.automationExecution.findMany({
    where: {
      sessionId: SESSION_ID,
      automationRule: { triggerType: 'recording_ready' },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, skipReason: true, createdAt: true, sentAt: true },
  })
  console.log(`AFTER (${after.length}):`)
  for (const e of after) console.log(`  ${e.createdAt.toISOString()}  ${e.status}${e.skipReason ? ' / ' + e.skipReason : ''}  sentAt=${e.sentAt?.toISOString() ?? '-'}`)

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
