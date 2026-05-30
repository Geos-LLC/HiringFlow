import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { candidateName: { contains: 'sugheily', mode: 'insensitive' } },
        { candidateName: { contains: 'santiago', mode: 'insensitive' } },
        { candidateEmail: { contains: 'sugheily', mode: 'insensitive' } },
        { candidateEmail: { contains: 'santiago', mode: 'insensitive' } },
      ],
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, candidateName: true, candidateEmail: true, candidatePhone: true,
      pipelineStatus: true, status: true, dispositionReason: true,
      automationsHaltedAt: true, automationsHaltedReason: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
      workspace: { select: { id: true, name: true, timezone: true } },
      flow: {
        select: {
          id: true, name: true, slug: true,
          schedulingTimeoutHours: true,
          trainingTimeoutDays: true,
          backgroundCheckTimeoutDays: true,
        },
      },
    },
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Found ${sessions.length} session(s)\n`)

  for (const s of sessions) {
    console.log('='.repeat(80))
    console.log(`Session ${s.id}`)
    console.log(`  ${s.candidateName} <${s.candidateEmail}>  phone=${s.candidatePhone ?? '-'}`)
    console.log(`  workspace: ${s.workspace.name} (${s.workspace.id}) tz=${s.workspace.timezone}`)
    console.log(`  flow: ${s.flow?.name ?? '-'} (id=${s.flow?.id ?? '-'} slug=${s.flow?.slug ?? '-'})`)
    console.log(`    timeouts: scheduling=${s.flow?.schedulingTimeoutHours}h training=${s.flow?.trainingTimeoutDays}d bgCheck=${s.flow?.backgroundCheckTimeoutDays}d`)
    console.log(`  pipelineStatus (stage): ${s.pipelineStatus}`)
    console.log(`  status: ${s.status} disposition=${s.dispositionReason ?? '-'}`)
    console.log(`  halted: ${s.automationsHaltedAt?.toISOString() ?? '-'} (${s.automationsHaltedReason ?? '-'})`)
    console.log(`  startedAt=${s.startedAt.toISOString()}  lastActivity=${s.lastActivityAt?.toISOString() ?? '-'}\n`)

    const enrollments = await prisma.trainingEnrollment.findMany({
      where: { sessionId: s.id },
      orderBy: { startedAt: 'asc' },
      select: {
        id: true, status: true, startedAt: true, completedAt: true,
        training: { select: { id: true, title: true } },
      },
    })
    console.log(`TrainingEnrollments (${enrollments.length}):`)
    for (const en of enrollments) {
      console.log(`  ${en.id}  training="${en.training?.title}"  status=${en.status}  startedAt=${en.startedAt?.toISOString() ?? '-'}  completedAt=${en.completedAt?.toISOString() ?? '-'}`)
    }
    console.log()

    const meetings = await prisma.interviewMeeting.findMany({
      where: { sessionId: s.id },
      orderBy: { scheduledStart: 'asc' },
      select: {
        id: true, scheduledStart: true, scheduledEnd: true,
        confirmedAt: true, actualStart: true, actualEnd: true,
        createdAt: true,
      },
    })
    console.log(`InterviewMeetings (${meetings.length}):`)
    for (const m of meetings) {
      console.log(`  ${m.id}  scheduled=${m.scheduledStart.toISOString()} confirmed=${m.confirmedAt?.toISOString() ?? '-'} createdAt=${m.createdAt.toISOString()}`)
    }
    console.log()

    const events = await prisma.schedulingEvent.findMany({
      where: { sessionId: s.id },
      orderBy: { eventAt: 'asc' },
      select: { id: true, eventType: true, eventAt: true, metadata: true, createdAt: true },
    })
    console.log(`SchedulingEvents (${events.length}):`)
    for (const e of events) {
      console.log(`  ${e.eventAt.toISOString()}  ${e.eventType}  (created=${e.createdAt.toISOString()})  meta=${JSON.stringify(e.metadata).slice(0, 200)}`)
    }
    console.log()

    const execs = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, status: true, channel: true, executionMode: true,
        skipReason: true, evaluatedStage: true, evaluatedStatus: true, expectedStage: true,
        scheduledFor: true, sentAt: true, createdAt: true,
        errorMessage: true, qstashMessageId: true,
        step: {
          select: {
            id: true, order: true, timingMode: true, delayMinutes: true,
            channel: true, nextStepType: true, nextStepUrl: true,
            trainingId: true, schedulingConfigId: true,
          },
        },
        automationRule: {
          select: {
            id: true, name: true, triggerType: true, isActive: true,
            flowId: true, stageId: true,
            flow: { select: { name: true } },
          },
        },
      },
    })
    console.log(`AutomationExecutions (${execs.length}):`)
    for (const e of execs) {
      const rname = e.automationRule?.name ?? '?'
      const trig = e.automationRule?.triggerType ?? '?'
      const ruleFlow = e.automationRule?.flowId ?? '?'
      const ruleActive = e.automationRule?.isActive
      const stepType = e.step?.nextStepType ?? '-'
      const stepOrder = e.step?.order ?? '-'
      const tm = e.step?.timingMode ?? '-'
      const dm = e.step?.delayMinutes ?? '-'
      console.log(`  [${e.status}] mode=${e.executionMode} ch=${e.channel}`)
      console.log(`    rule="${rname}" trigger=${trig} ruleFlow=${ruleFlow} (${e.automationRule?.flow?.name}) active=${ruleActive} stageId=${e.automationRule?.stageId}`)
      console.log(`    step order=${stepOrder} timing=${tm} delay=${dm}min nextStepType=${stepType}`)
      console.log(`    scheduledFor=${e.scheduledFor?.toISOString() ?? '-'}  sentAt=${e.sentAt?.toISOString() ?? '-'}  created=${e.createdAt.toISOString()}`)
      console.log(`    skipReason=${e.skipReason ?? '-'} evaluatedStage=${e.evaluatedStage} evaluatedStatus=${e.evaluatedStatus} expectedStage=${e.expectedStage}`)
      console.log(`    qstash=${e.qstashMessageId ?? '-'}  err=${e.errorMessage ?? '-'}`)
    }
    console.log()

    if (s.flow?.id) {
      console.log(`Active rules in flow ${s.flow.id} (${s.flow.name}):`)
      const rules = await prisma.automationRule.findMany({
        where: { flowId: s.flow.id, isActive: true },
        orderBy: { triggerType: 'asc' },
        select: {
          id: true, name: true, triggerType: true, stageId: true,
          steps: {
            orderBy: { order: 'asc' },
            select: { id: true, order: true, channel: true, timingMode: true, delayMinutes: true, nextStepType: true },
          },
        },
      })
      for (const r of rules) {
        console.log(`  "${r.name}" trigger=${r.triggerType} stageId=${r.stageId}`)
        for (const st of r.steps) {
          console.log(`    step ${st.order}: ch=${st.channel} timing=${st.timingMode} delay=${st.delayMinutes}min next=${st.nextStepType}`)
        }
      }

      console.log(`\nActive rules in OTHER flows (workspace=${s.workspace.id}) that still got executions for this session:`)
      const otherFlowRuleIds = Array.from(new Set(execs.map(e => e.automationRule?.id).filter(Boolean) as string[]))
        .filter(rid => {
          const e = execs.find(x => x.automationRule?.id === rid)
          return e?.automationRule?.flowId !== s.flow?.id
        })
      for (const rid of otherFlowRuleIds) {
        const r = await prisma.automationRule.findUnique({
          where: { id: rid },
          select: { id: true, name: true, triggerType: true, flowId: true, isActive: true, flow: { select: { name: true } } },
        })
        if (r) console.log(`  rule "${r.name}" lives in flow ${r.flowId} (${r.flow?.name}) — execution attached to this session anyway`)
      }
    }
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
