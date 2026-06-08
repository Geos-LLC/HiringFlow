import { PrismaClient } from '@prisma/client'

// Drill into the 6 credit-exceeded failures so we know exactly what each
// execution represents (which step, which template, which candidate, whether
// the candidate already received the email somehow). Two rows on the same
// session at the same millisecond is a red flag — could be 2 parallel steps,
// or a duplicate insert. Verify before resending.
async function main() {
  const prisma = new PrismaClient()

  const execIds = [
    '063eb910-f09d-4fe5-bcb7-32538bd1d2a2',
    '4ed64bb2-1eda-4bce-95bd-472577a7652a',
    'aa908477-e559-4bec-be7c-2bcaed43bfaf',
    'bf0cdf53-9ca3-4423-b1c2-e82b520997e0',
    '21f319db-ab67-4174-befb-af012ef78b23',
    'ac220418-d574-4a0d-b442-a34a8736610a',
  ]

  const execs = await prisma.automationExecution.findMany({
    where: { id: { in: execIds } },
    include: {
      step: {
        include: {
          emailTemplate: { select: { name: true, subject: true } },
          rule: { select: { name: true, isActive: true } },
        },
      },
    },
  })

  const sessionIds = Array.from(new Set(execs.map((e) => e.sessionId).filter((x): x is string => !!x)))
  const sessions = await prisma.session.findMany({
    where: { id: { in: sessionIds } },
    select: {
      id: true,
      candidateName: true,
      candidateEmail: true,
      pipelineStatus: true,
      automationsHaltedAt: true,
      automationsHaltedReason: true,
      stageEntries: { orderBy: { enteredAt: 'desc' }, take: 1, select: { stageId: true, enteredAt: true } },
    },
  })
  const sBy = new Map(sessions.map((s) => [s.id, s]))

  // For each session, find every execution on the SAME stepId+channel — to
  // see whether ANY successful send already covered it (rare but possible if
  // a retry slipped through).
  const stepSessionKeys = execs.map((e) => ({ stepId: e.stepId ?? '', sessionId: e.sessionId ?? '', channel: e.channel }))
  const sameStepSessionExecs = await prisma.automationExecution.findMany({
    where: {
      OR: stepSessionKeys.map((k) => ({
        stepId: k.stepId,
        sessionId: k.sessionId,
        channel: k.channel,
      })),
    },
    select: { id: true, stepId: true, sessionId: true, channel: true, status: true, errorMessage: true, sentAt: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  for (const e of execs) {
    const s = e.sessionId ? sBy.get(e.sessionId) : null
    console.log(`\n=== exec ${e.id} ===`)
    console.log(`  candidate     : ${s?.candidateName ?? '?'}  <${s?.candidateEmail ?? '?'}>`)
    console.log(`  session       : ${e.sessionId}  pipelineStatus=${s?.pipelineStatus ?? '?'}  halted=${s?.automationsHaltedAt ? `YES (${s.automationsHaltedReason})` : 'no'}  stage=${s?.stageEntries[0]?.stageId ?? '-'}`)
    console.log(`  rule          : "${e.step?.rule?.name ?? '?'}"  active=${e.step?.rule?.isActive ?? '?'}`)
    console.log(`  step          : id=${e.stepId}  order=${e.step?.order ?? '?'}  channel=${e.step?.channel ?? '?'}`)
    console.log(`  template      : "${e.step?.emailTemplate?.name ?? '(none)'}"  subject="${e.step?.emailTemplate?.subject ?? '-'}"`)
    console.log(`  exec          : status=${e.status}  channel=${e.channel}  scheduledFor=${e.scheduledFor?.toISOString() ?? '-'}  sentAt=${e.sentAt?.toISOString() ?? '-'}`)
    console.log(`  error         : ${e.errorMessage}`)
    console.log(`  executionMode : ${e.executionMode ?? '-'}  qstashMsgId=${e.qstashMessageId ?? '-'}`)

    const peers = sameStepSessionExecs.filter(
      (p) => p.stepId === e.stepId && p.sessionId === e.sessionId && p.channel === e.channel
    )
    if (peers.length > 1) {
      console.log(`  PEERS (same stepId+sessionId+channel):`)
      for (const p of peers) {
        console.log(`    ${p.createdAt.toISOString()}  ${p.id}  status=${p.status}  sentAt=${p.sentAt?.toISOString() ?? '-'}  err=${p.errorMessage ?? '-'}`)
      }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
