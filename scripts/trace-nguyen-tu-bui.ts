import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  const sessions = await prisma.session.findMany({
    where: {
      candidateName: { contains: 'Nguyen', mode: 'insensitive' },
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, candidateName: true, candidateEmail: true, candidatePhone: true,
      pipelineStatus: true, status: true, dispositionReason: true,
      stalledAt: true, lostAt: true, hiredAt: true,
      rejectionReason: true, rejectionReasonAt: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
      interestingAt: true,
      workspace: { select: { id: true, name: true, timezone: true } },
      flow: { select: { id: true, name: true, slug: true, pipelineId: true, videoInterviewTimeoutDays: true, trainingTimeoutDays: true, noShowTimeoutHours: true } },
    },
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Found ${sessions.length} session(s) matching name "Nguyen"\n`)

  for (const s of sessions) {
    console.log('='.repeat(80))
    console.log(`Session ${s.id}`)
    console.log(`  ${s.candidateName} <${s.candidateEmail}>  phone=${s.candidatePhone ?? '-'}`)
    console.log(`  workspace: ${s.workspace.name} (${s.workspace.id}) tz=${s.workspace.timezone}`)
    console.log(`  flow: ${s.flow?.name ?? '-'} (slug=${s.flow?.slug ?? '-'}, pipelineId=${s.flow?.pipelineId ?? '-'})`)
    console.log(`  flow timeouts: video=${s.flow?.videoInterviewTimeoutDays ?? 'default(3)'}d training=${s.flow?.trainingTimeoutDays ?? 'default(5)'}d noShow=${s.flow?.noShowTimeoutHours ?? 'default(24)'}h`)
    console.log(`  pipelineStatus (stage): ${s.pipelineStatus}`)
    console.log(`  status: ${s.status}`)
    console.log(`  dispositionReason: ${s.dispositionReason ?? '-'}`)
    console.log(`  stalledAt=${s.stalledAt?.toISOString() ?? '-'}  lostAt=${s.lostAt?.toISOString() ?? '-'}  hiredAt=${s.hiredAt?.toISOString() ?? '-'}`)
    console.log(`  rejectionReason=${s.rejectionReason ?? '-'} at ${s.rejectionReasonAt?.toISOString() ?? '-'}`)
    console.log(`  startedAt=${s.startedAt.toISOString()}`)
    console.log(`  finishedAt=${s.finishedAt?.toISOString() ?? '-'}`)
    console.log(`  lastActivityAt=${s.lastActivityAt?.toISOString() ?? '-'}`)
    console.log(`  interestingAt=${s.interestingAt?.toISOString() ?? '-'}\n`)

    // Calc days since lastActivity / startedAt
    const now = Date.now()
    const lastActivity = s.lastActivityAt ?? s.startedAt
    const daysSinceActivity = (now - lastActivity.getTime()) / (1000 * 60 * 60 * 24)
    console.log(`  days since last activity: ${daysSinceActivity.toFixed(2)}`)
    console.log(`  days since startedAt: ${((now - s.startedAt.getTime()) / (1000 * 60 * 60 * 24)).toFixed(2)}\n`)

    const meetings = await prisma.interviewMeeting.findMany({
      where: { sessionId: s.id },
      orderBy: { scheduledStart: 'asc' },
    })
    console.log(`InterviewMeetings (${meetings.length}):`)
    for (const m of meetings) {
      console.log(`  ${m.id}`)
      console.log(`    scheduled=${m.scheduledStart.toISOString()} → ${m.scheduledEnd.toISOString()}`)
      console.log(`    actual=${m.actualStart?.toISOString() ?? '-'} → ${m.actualEnd?.toISOString() ?? '-'}`)
      console.log(`    confirmed=${m.confirmedAt?.toISOString() ?? '-'}`)
      console.log(`    createdAt=${m.createdAt.toISOString()}`)
      console.log(`    cancelledAt=${(m as any).cancelledAt?.toISOString() ?? '-'}`)
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
      const metaStr = meta ? ` meta=${JSON.stringify(meta).slice(0, 200)}` : ''
      console.log(`  ${e.eventAt.toISOString()}  ${e.eventType}${metaStr}`)
    }
    console.log()

    const enrollments = await prisma.trainingEnrollment.findMany({
      where: { sessionId: s.id },
      orderBy: { startedAt: 'asc' },
      select: { id: true, trainingId: true, status: true, progress: true, startedAt: true, completedAt: true, training: { select: { title: true, slug: true } } },
    })
    console.log(`TrainingEnrollments (${enrollments.length}):`)
    for (const e of enrollments) {
      console.log(`  ${e.training.title}: ${e.status}  startedAt=${e.startedAt?.toISOString() ?? '-'}  completed=${e.completedAt?.toISOString() ?? '-'}  progress=${JSON.stringify(e.progress).slice(0,200)}`)
    }
    console.log()

    const tokens = await prisma.trainingAccessToken.findMany({
      where: { candidateId: s.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, trainingId: true, createdAt: true, usedAt: true, expiresAt: true, sourceType: true, status: true, training: { select: { title: true } } },
    })
    console.log(`TrainingAccessTokens (${tokens.length}):`)
    for (const t of tokens) {
      const ageDays = (Date.now() - t.createdAt.getTime()) / (1000 * 60 * 60 * 24)
      console.log(`  ${t.training.title}  sourceType=${t.sourceType} status=${t.status}  createdAt=${t.createdAt.toISOString()} (${ageDays.toFixed(1)}d ago)  usedAt=${t.usedAt?.toISOString() ?? 'NEVER'}  expiresAt=${t.expiresAt?.toISOString() ?? '-'}`)
    }
    console.log()

    const executions = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, channel: true, createdAt: true, executedAt: true, scheduledFor: true, errorMessage: true, rule: { select: { name: true, triggerType: true } }, step: { select: { trainingId: true, nextStepType: true } } },
    })
    console.log(`AutomationExecutions (${executions.length}):`)
    for (const e of executions) {
      console.log(`  ${e.createdAt.toISOString()}  [${e.status}] rule="${e.rule?.name ?? '-'}" trig=${e.rule?.triggerType ?? '-'} ch=${e.channel ?? '-'} nextType=${e.step?.nextStepType ?? '-'} trainingId=${e.step?.trainingId ?? '-'} execAt=${e.executedAt?.toISOString() ?? '-'}  err=${e.errorMessage ?? '-'}`)
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
