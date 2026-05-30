/**
 * Audit AutomationExecutions skipped with `missing_prerequisite` for rules
 * triggered on `recording_ready`, where the session has a processed
 * CaptureResponse (audio/video) — i.e. the flow-recording case the guard
 * blindly rejected before the 2026-05-28 fix.
 */
import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  const skipped = await prisma.automationExecution.findMany({
    where: {
      status: 'skipped_missing_prerequisite',
      automationRule: { triggerType: 'recording_ready' },
    },
    select: {
      id: true, sessionId: true, createdAt: true,
      automationRule: { select: { id: true, name: true, workspaceId: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  console.log(`Found ${skipped.length} skipped recording_ready executions total\n`)

  const affected: typeof skipped = []
  for (const e of skipped) {
    const cap = await prisma.captureResponse.findFirst({
      where: {
        sessionId: e.sessionId,
        status: 'processed',
        mode: { in: ['audio', 'video', 'audio_video'] },
      },
      select: { id: true },
    })
    const sub = await prisma.candidateSubmission.findFirst({
      where: { sessionId: e.sessionId, videoStorageKey: { not: null } },
      select: { id: true },
    })
    const meeting = await prisma.interviewMeeting.findFirst({
      where: { sessionId: e.sessionId, recordingState: 'ready' },
      select: { id: true },
    })
    // Only count rows where a flow recording exists AND no Meet recording —
    // these are the genuine false-skips.
    if ((cap || sub) && !meeting) affected.push(e)
  }

  console.log(`Genuinely affected (flow recording present, no Meet recording): ${affected.length}\n`)

  const bySession = new Map<string, typeof affected>()
  for (const e of affected) {
    const k = e.sessionId
    if (!bySession.has(k)) bySession.set(k, [])
    bySession.get(k)!.push(e)
  }

  console.log(`Unique sessions affected: ${bySession.size}\n`)
  for (const [sessionId, execs] of bySession) {
    const s = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        candidateName: true, candidateEmail: true,
        status: true, pipelineStatus: true, automationsHaltedAt: true,
        flow: { select: { name: true } },
      },
    })
    const halted = s?.automationsHaltedAt ? ` HALTED@${s.automationsHaltedAt.toISOString()}` : ''
    console.log(`  ${sessionId}  ${s?.candidateName} <${s?.candidateEmail}>  flow="${s?.flow?.name}" status=${s?.status}/${s?.pipelineStatus ?? '-'}${halted}`)
    for (const e of execs) {
      console.log(`    ${e.createdAt.toISOString()}  rule="${e.automationRule?.name}" (${e.automationRule?.id})`)
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
