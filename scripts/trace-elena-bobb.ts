import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const email = 'elenab907@gmail.com'

  const sessions = await prisma.session.findMany({
    where: {
      candidateEmail: { equals: email, mode: 'insensitive' },
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, candidateName: true, candidateEmail: true, candidatePhone: true,
      pipelineStatus: true, status: true, dispositionReason: true,
      stalledAt: true, lostAt: true, hiredAt: true,
      rejectionReason: true, rejectionReasonAt: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
      automationsHaltedAt: true, automationsHaltedReason: true,
      workspace: { select: { id: true, name: true, timezone: true } },
      flow: { select: { id: true, name: true, slug: true, pipelineId: true } },
    },
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Found ${sessions.length} session(s) for ${email}\n`)

  for (const s of sessions) {
    console.log('='.repeat(80))
    console.log(`Session ${s.id}`)
    console.log(`  ${s.candidateName} <${s.candidateEmail}>  phone=${s.candidatePhone ?? '-'}`)
    console.log(`  workspace: ${s.workspace.name} (${s.workspace.id})`)
    console.log(`  flow: ${s.flow?.name ?? '-'} (pipelineId=${s.flow?.pipelineId ?? '-'})`)
    console.log(`  pipelineStatus: ${s.pipelineStatus}  status: ${s.status}  dispositionReason: ${s.dispositionReason ?? '-'}`)
    console.log(`  startedAt=${s.startedAt.toISOString()}  finishedAt=${s.finishedAt?.toISOString() ?? '-'}  lastActivityAt=${s.lastActivityAt?.toISOString() ?? '-'}`)
    console.log(`  automationsHaltedAt=${s.automationsHaltedAt?.toISOString() ?? '-'}  reason=${s.automationsHaltedReason ?? '-'}`)
    console.log()

    const enrollments = await prisma.trainingEnrollment.findMany({
      where: { sessionId: s.id },
      orderBy: { startedAt: 'asc' },
      select: { id: true, trainingId: true, status: true, startedAt: true, completedAt: true, accessTokenId: true, training: { select: { title: true } } },
    })
    console.log(`TrainingEnrollments (${enrollments.length}):`)
    for (const e of enrollments) {
      console.log(`  "${e.training.title}": ${e.status}  startedAt=${e.startedAt?.toISOString() ?? '-'}  completedAt=${e.completedAt?.toISOString() ?? '-'}  accessTokenId=${e.accessTokenId ?? '-'}`)
    }
    console.log()

    const tokens = await prisma.trainingAccessToken.findMany({
      where: { candidateId: s.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, trainingId: true, createdAt: true, usedAt: true, sourceType: true, sourceRefId: true, status: true, training: { select: { title: true } } },
    })
    console.log(`TrainingAccessTokens (${tokens.length}):`)
    for (const t of tokens) {
      const age = (Date.now() - t.createdAt.getTime()) / (1000 * 60 * 60 * 24)
      console.log(`  "${t.training.title}"  src=${t.sourceType}/${t.sourceRefId ?? '-'} status=${t.status} created=${t.createdAt.toISOString()} (${age.toFixed(1)}d ago) usedAt=${t.usedAt?.toISOString() ?? 'NEVER'}`)
    }
    console.log()

    const events = await prisma.schedulingEvent.findMany({
      where: { sessionId: s.id },
      orderBy: { eventAt: 'asc' },
      select: { id: true, eventType: true, eventAt: true, metadata: true },
    })
    console.log(`SchedulingEvents (${events.length}):`)
    for (const e of events) {
      const meta = e.metadata as Record<string, unknown> | null
      const metaStr = meta ? ` meta=${JSON.stringify(meta).slice(0, 180)}` : ''
      console.log(`  ${e.eventAt.toISOString()}  ${e.eventType}${metaStr}`)
    }
    console.log()

    const executions = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, status: true, channel: true, createdAt: true, sentAt: true,
        skipReason: true,
        evaluatedStage: true, evaluatedStatus: true, expectedStage: true,
        executionMode: true,
        automationRule: { select: { name: true, triggerType: true, pipelineId: true, stageId: true } },
        step: { select: { trainingId: true, nextStepType: true, emailDestination: true, smsDestination: true, channel: true, delayMinutes: true } },
      },
    })
    console.log(`AutomationExecutions (${executions.length}):`)
    for (const e of executions) {
      const rule = e.automationRule
      console.log(`  ${e.createdAt.toISOString()}  [${e.status}${e.skipReason ? ' / ' + e.skipReason : ''}] ${rule?.name ?? '-'} trig=${rule?.triggerType ?? '-'} stage=${rule?.stageId ?? '-'} pipeId=${rule?.pipelineId ?? '-'}`)
      console.log(`      step: ch=${e.step?.channel ?? '-'} type=${e.step?.nextStepType ?? '-'} trainingId=${e.step?.trainingId ?? '-'} email→${e.step?.emailDestination ?? '-'} sms→${e.step?.smsDestination ?? '-'} delay=${e.step?.delayMinutes ?? '-'}min`)
      console.log(`      exec: channel=${e.channel ?? '-'} mode=${e.executionMode ?? '-'} sentAt=${e.sentAt?.toISOString() ?? '-'} evalStage=${e.evaluatedStage ?? '-'}/expected=${e.expectedStage ?? '-'} evalStatus=${e.evaluatedStatus ?? '-'}`)
    }
    console.log()
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
