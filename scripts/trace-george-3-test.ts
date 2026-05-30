import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { candidateName: { contains: 'george', mode: 'insensitive' } },
        { candidateName: { contains: 'georg', mode: 'insensitive' } },
        { candidateEmail: { contains: 'george', mode: 'insensitive' } },
        { candidateEmail: { contains: 'georg', mode: 'insensitive' } },
        { candidateEmail: { contains: 'sayapin', mode: 'insensitive' } },
      ],
    },
    orderBy: { startedAt: 'desc' },
    take: 15,
    select: {
      id: true, candidateName: true, candidateEmail: true, candidatePhone: true,
      pipelineStatus: true, status: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
      workspace: { select: { id: true, name: true } },
      flow: { select: { id: true, name: true, slug: true, pipelineId: true } },
    },
  })

  console.log(`Found ${sessions.length} session(s):`)
  for (const s of sessions) {
    console.log(`  ${s.id}  "${s.candidateName}" <${s.candidateEmail}>  ws=${s.workspace.name}  flow=${s.flow?.name}  pipeId=${s.flow?.pipelineId ?? '-'}  pipelineStatus=${s.pipelineStatus}  startedAt=${s.startedAt.toISOString()}`)
  }

  // For each session, dump everything
  for (const s of sessions) {
    console.log()
    console.log('='.repeat(80))
    console.log(`SESSION ${s.id} — ${s.candidateName}`)
    console.log(`  status=${s.status}  pipelineStatus=${s.pipelineStatus}  startedAt=${s.startedAt.toISOString()} finishedAt=${s.finishedAt?.toISOString() ?? '-'}`)

    const enrollments = await prisma.trainingEnrollment.findMany({
      where: { sessionId: s.id },
      orderBy: { startedAt: 'asc' },
      select: { trainingId: true, status: true, startedAt: true, completedAt: true, training: { select: { title: true } } },
    })
    console.log(`  TrainingEnrollments (${enrollments.length}):`)
    for (const e of enrollments) {
      console.log(`    "${e.training.title}" ${e.status} startedAt=${e.startedAt?.toISOString()} completedAt=${e.completedAt?.toISOString() ?? '-'}`)
    }

    const events = await prisma.schedulingEvent.findMany({
      where: { sessionId: s.id },
      orderBy: { eventAt: 'asc' },
      select: { eventType: true, eventAt: true, metadata: true },
    })
    console.log(`  SchedulingEvents (${events.length}):`)
    for (const e of events) {
      console.log(`    ${e.eventAt.toISOString()} ${e.eventType} ${e.metadata ? JSON.stringify(e.metadata).slice(0, 160) : ''}`)
    }

    const execs = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
      select: {
        status: true, channel: true, executionMode: true, sentAt: true, createdAt: true,
        skipReason: true, errorMessage: true,
        automationRule: { select: { name: true, triggerType: true, stageId: true, pipelineId: true, isActive: true } },
      },
    })
    console.log(`  AutomationExecutions (${execs.length}):`)
    for (const e of execs) {
      console.log(`    ${e.createdAt.toISOString()} [${e.status}${e.skipReason ? '/' + e.skipReason : ''}] "${e.automationRule?.name}" trig=${e.automationRule?.triggerType} active=${e.automationRule?.isActive} ruleStage=${e.automationRule?.stageId ?? '-'} ruleP=${e.automationRule?.pipelineId ?? '-'} mode=${e.executionMode} ch=${e.channel}${e.errorMessage ? ' err=' + e.errorMessage.slice(0, 80) : ''}`)
    }

    const meetings = await prisma.interviewMeeting.findMany({
      where: { sessionId: s.id },
      orderBy: { scheduledStart: 'asc' },
      select: {
        id: true, scheduledStart: true, scheduledEnd: true,
        actualStart: true, actualEnd: true,
        recordingState: true, transcriptState: true,
        meetingUri: true, createdAt: true,
      },
    })
    console.log(`  InterviewMeetings (${meetings.length}):`)
    for (const m of meetings) {
      console.log(`    ${m.id}  scheduled=${m.scheduledStart?.toISOString()}  actualStart=${m.actualStart?.toISOString() ?? '-'} actualEnd=${m.actualEnd?.toISOString() ?? '-'}  rec=${m.recordingState} trans=${m.transcriptState}`)
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
