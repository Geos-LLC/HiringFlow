import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const email = 'alser2026@ukr.net'

  const sessions = await prisma.session.findMany({
    where: { candidateEmail: { equals: email, mode: 'insensitive' } },
    orderBy: { startedAt: 'desc' },
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Found ${sessions.length} session(s) for ${email}\n`)

  for (const s of sessions) {
    console.log('='.repeat(80))
    console.log(`Session ${s.id}`)
    console.log(`  ${s.candidateName} <${s.candidateEmail}>  phone=${s.candidatePhone ?? '-'}`)
    console.log(`  flowId=${s.flowId}  pipelineStatus=${s.pipelineStatus} status=${s.status} dispo=${s.dispositionReason ?? '-'}`)
    console.log(`  startedAt=${s.startedAt.toISOString()} finishedAt=${s.finishedAt?.toISOString() ?? '-'} lastActivityAt=${s.lastActivityAt?.toISOString() ?? '-'}`)
    console.log(`  automationsHaltedAt=${s.automationsHaltedAt?.toISOString() ?? '-'} reason=${s.automationsHaltedReason ?? '-'}`)

    const flow = await prisma.flow.findUnique({
      where: { id: s.flowId },
      select: { id: true, name: true, slug: true, pipelineId: true, workspaceId: true },
    })
    console.log(`  flow: ${flow?.name} (${flow?.slug})`)
    console.log()

    const enrollments = await prisma.trainingEnrollment.findMany({
      where: { sessionId: s.id },
      orderBy: { startedAt: 'asc' },
      include: { training: { select: { title: true } } },
    })
    console.log(`TrainingEnrollments (${enrollments.length}):`)
    for (const e of enrollments) {
      console.log(`  "${e.training.title}" status=${e.status} startedAt=${e.startedAt?.toISOString() ?? '-'} completedAt=${e.completedAt?.toISOString() ?? '-'} accessTokenId=${e.accessTokenId ?? '-'}`)
    }
    console.log()

    const tokens = await prisma.trainingAccessToken.findMany({
      where: { candidateId: s.id },
      orderBy: { createdAt: 'asc' },
      include: { training: { select: { title: true } } },
    })
    console.log(`TrainingAccessTokens (${tokens.length}):`)
    for (const t of tokens) {
      console.log(`  "${t.training.title}" src=${t.sourceType}/${t.sourceRefId ?? '-'} status=${t.status} created=${t.createdAt.toISOString()} usedAt=${t.usedAt?.toISOString() ?? 'NEVER'}`)
    }
    console.log()

    const events = await prisma.schedulingEvent.findMany({
      where: { sessionId: s.id },
      orderBy: { eventAt: 'asc' },
      select: { eventType: true, eventAt: true, metadata: true },
    })
    console.log(`SchedulingEvents (${events.length}):`)
    for (const e of events) {
      const meta = e.metadata as Record<string, unknown> | null
      const metaStr = meta ? ` meta=${JSON.stringify(meta).slice(0, 220)}` : ''
      console.log(`  ${e.eventAt.toISOString()} ${e.eventType}${metaStr}`)
    }
    console.log()

    const captures = await prisma.captureResponse.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
    })
    console.log(`CaptureResponses (${captures.length}):`)
    for (const c of captures) {
      console.log(`  ${c.createdAt.toISOString()} mode=${c.mode} status=${c.status} duration=${c.durationSec ?? '-'}s storageKey=${c.storageKey ?? '-'} stepId=${c.stepId}`)
    }
    console.log()

    const submissions = await prisma.candidateSubmission.findMany({
      where: { sessionId: s.id },
      orderBy: { submittedAt: 'asc' },
    })
    console.log(`CandidateSubmissions (${submissions.length}):`)
    for (const r of submissions) {
      console.log(`  ${r.createdAt.toISOString()} ${JSON.stringify(r).slice(0, 300)}`)
    }
    console.log()

    const executions = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
      include: {
        automationRule: { select: { id: true, name: true, triggerType: true, pipelineId: true, stageId: true, isActive: true, waitForRecording: true } },
        step: { select: { id: true, channel: true, nextStepType: true, trainingId: true, emailDestination: true, smsDestination: true, delayMinutes: true } },
      },
    })
    console.log(`AutomationExecutions (${executions.length}):`)
    for (const e of executions) {
      const rule = e.automationRule
      console.log(`  ${e.createdAt.toISOString()} [${e.status}${e.skipReason ? ' / ' + e.skipReason : ''}]`)
      console.log(`    rule: ${rule?.name} (${rule?.id}) trigger=${rule?.triggerType} stage=${rule?.stageId ?? '-'} isActive=${rule?.isActive} waitForRecording=${rule?.waitForRecording}`)
      console.log(`    step: ${e.step?.id} ch=${e.step?.channel} type=${e.step?.nextStepType} trainingId=${e.step?.trainingId ?? '-'} email→${e.step?.emailDestination ?? '-'} sms→${e.step?.smsDestination ?? '-'} delay=${e.step?.delayMinutes ?? '-'}min`)
      console.log(`    exec: channel=${e.channel ?? '-'} mode=${e.executionMode ?? '-'} sentAt=${e.sentAt?.toISOString() ?? '-'} evalStage=${e.evaluatedStage ?? '-'}/expected=${e.expectedStage ?? '-'} evalStatus=${e.evaluatedStatus ?? '-'}`)
    }
    console.log()
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
