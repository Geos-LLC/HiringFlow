import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const email = 'viktoryiavaleisha@gmail.com'
  const phone = '+12675631762'

  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { candidateEmail: { equals: email, mode: 'insensitive' } },
        { candidatePhone: phone },
      ],
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, candidateName: true, candidateEmail: true, candidatePhone: true,
      pipelineStatus: true, status: true, dispositionReason: true,
      rejectionReason: true, rejectionReasonAt: true,
      stalledAt: true, lostAt: true, hiredAt: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
      workspace: { select: { id: true, name: true, timezone: true } },
      flow: { select: { id: true, name: true, slug: true } },
      lastStepId: true,
      automationsHaltedAt: true,
      automationsHaltedReason: true,
    },
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Found ${sessions.length} session(s) matching ${email} OR ${phone}`)
  console.log()

  for (const s of sessions) {
    console.log('='.repeat(80))
    console.log(`Session ${s.id}`)
    console.log(`  ${s.candidateName} <${s.candidateEmail}>  phone=${s.candidatePhone ?? '-'}`)
    console.log(`  workspace: ${s.workspace.name} (${s.workspace.id}) tz=${s.workspace.timezone}`)
    console.log(`  flow: ${s.flow?.name ?? '-'} (slug=${s.flow?.slug ?? '-'})`)
    console.log(`  pipelineStatus (stage): ${s.pipelineStatus}`)
    console.log(`  status: ${s.status}`)
    console.log(`  dispositionReason: ${s.dispositionReason ?? '-'}`)
    console.log(`  startedAt=${s.startedAt.toISOString()}  finishedAt=${s.finishedAt?.toISOString() ?? '-'}  lastActivity=${s.lastActivityAt?.toISOString() ?? '-'}`)
    console.log()

    // All AutomationRules for this flow/workspace
    const rules = await prisma.automationRule.findMany({
      where: {
        workspaceId: s.workspace.id,
        OR: [{ flowId: s.flow?.id ?? '__none__' }, { flowId: null }],
      },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, triggerType: true, stageId: true,
        flowId: true, channel: true, isActive: true,
        steps: {
          orderBy: { order: 'asc' },
          select: {
            id: true, order: true, channel: true, timingMode: true, delayMinutes: true,
            emailDestination: true, smsDestination: true,
            emailTemplateId: true, smsBody: true,
            nextStepType: true,
          },
        },
      },
    })

    console.log(`AutomationRules visible to this session (${rules.length}):`)
    for (const r of rules) {
      console.log(`  rule ${r.id}  name="${r.name}"  trigger=${r.triggerType}  stage=${r.stageId ?? '-'}  flowId=${r.flowId ?? '(any)'}  active=${r.isActive}`)
      for (const st of r.steps) {
        console.log(`     step#${st.order} id=${st.id} channel=${st.channel} timing=${st.timingMode}+${st.delayMinutes}m emailDest=${st.emailDestination} smsDest=${st.smsDestination} next=${st.nextStepType ?? '-'}`)
      }
    }
    console.log()

    // Executions for this session
    const execs = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, automationRuleId: true, stepId: true,
        status: true, errorMessage: true, channel: true,
        provider: true, providerMessageId: true, qstashMessageId: true,
        sentAt: true, scheduledFor: true, createdAt: true,
        automationRule: { select: { name: true, triggerType: true } },
        step: { select: { order: true, timingMode: true, delayMinutes: true } },
      },
    })
    console.log(`AutomationExecutions for this session (${execs.length}):`)
    for (const e of execs) {
      const stp = e.step ? `step#${e.step.order} ${e.step.timingMode}+${e.step.delayMinutes}m` : '(legacy/no-step)'
      console.log(`  ${e.id}  rule="${e.automationRule.name}" (${e.automationRule.triggerType})  ${stp}  channel=${e.channel}`)
      console.log(`     status=${e.status}  scheduledFor=${e.scheduledFor?.toISOString() ?? '-'}  sentAt=${e.sentAt?.toISOString() ?? '-'}  qstash=${e.qstashMessageId ?? '-'}`)
      if (e.errorMessage) console.log(`     error: ${e.errorMessage.slice(0, 250)}`)
      if (e.providerMessageId) console.log(`     providerMessageId=${e.providerMessageId}`)
    }
    console.log()

    // Scheduling events
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

    // InterviewMeetings
    const meetings = await prisma.interviewMeeting.findMany({
      where: { sessionId: s.id },
      orderBy: { scheduledStart: 'asc' },
      select: {
        id: true, scheduledStart: true, scheduledEnd: true,
        actualStart: true, actualEnd: true, confirmedAt: true,
        createdAt: true, meetingUri: true,
      },
    })
    console.log(`InterviewMeetings (${meetings.length}):`)
    for (const m of meetings) {
      console.log(`  ${m.id}  scheduled=${m.scheduledStart.toISOString()}→${m.scheduledEnd.toISOString()}  actualStart=${m.actualStart?.toISOString() ?? '-'}  confirmed=${m.confirmedAt?.toISOString() ?? '-'}  uri=${m.meetingUri}`)
    }
    console.log()

    // FormResponses → look for application + scheduling answers
    const responses = await prisma.formResponse.findMany({
      where: { sessionId: s.id },
      orderBy: { answeredAt: 'asc' },
      take: 30,
      select: { stepId: true, fieldKey: true, value: true, answeredAt: true },
    })
    console.log(`FormResponses (${responses.length}):`)
    for (const r of responses) {
      const val = typeof r.value === 'string' ? r.value : JSON.stringify(r.value)
      console.log(`  ${r.answeredAt.toISOString()}  step=${r.stepId} field=${r.fieldKey}  value=${val?.slice(0, 120)}`)
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
