import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const email = 'tiffany.mathis3214@gmail.com'

  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { candidateEmail: { equals: email, mode: 'insensitive' } },
        { candidatePhone: { contains: '7863801784' } },
        { candidateName: { contains: 'Tiffany', mode: 'insensitive' } },
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
      formData: true,
      submissions: { select: { id: true, submittedAt: true, stepId: true, videoStorageKey: true, videoFilename: true, textMessage: true } as any },
      trainingEnrollments: true,
      answers: true,
    } as any,
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Found ${sessions.length} session(s)`)
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
    console.log(`  rejectionReason: ${s.rejectionReason ?? '-'} (at ${s.rejectionReasonAt?.toISOString() ?? '-'})`)
    console.log(`  stalledAt=${s.stalledAt?.toISOString() ?? '-'} lostAt=${s.lostAt?.toISOString() ?? '-'} hiredAt=${s.hiredAt?.toISOString() ?? '-'}`)
    console.log(`  startedAt=${s.startedAt.toISOString()}  finishedAt=${s.finishedAt?.toISOString() ?? '-'}  lastActivity=${s.lastActivityAt?.toISOString() ?? '-'}`)
    const sa = s as any
    console.log(`  formData keys: ${sa.formData && typeof sa.formData === 'object' ? Object.keys(sa.formData).slice(0, 12).join(',') : '-'}`)
    console.log(`  submissions: ${sa.submissions?.length ?? 0}`)
    for (const fr of sa.submissions ?? []) {
      console.log(`    - id=${fr.id} stepId=${fr.stepId ?? '-'} submittedAt=${fr.submittedAt?.toISOString?.() ?? '-'} hasVideo=${!!fr.videoStorageKey} hasText=${!!fr.textMessage}`)
    }
    console.log(`  trainingEnrollments: ${sa.trainingEnrollments?.length ?? 0}`)
    for (const te of sa.trainingEnrollments ?? []) {
      console.log(`    - ${JSON.stringify(te).slice(0, 400)}`)
    }
    console.log(`  answers: ${sa.answers?.length ?? 0}`)
    for (const a of (sa.answers ?? []).slice(0, 12)) {
      console.log(`    - ${JSON.stringify(a).slice(0, 200)}`)
    }
    console.log()

    const meetings = await prisma.interviewMeeting.findMany({
      where: { sessionId: s.id },
      orderBy: { scheduledStart: 'asc' },
      select: {
        id: true, scheduledStart: true, scheduledEnd: true,
        actualStart: true, actualEnd: true,
        createdAt: true, updatedAt: true,
        meetingUri: true, meetSpaceName: true,
        recordingState: true, transcriptState: true,
        meetingCode: true,
      },
    })
    console.log(`InterviewMeetings (${meetings.length}):`)
    for (const m of meetings) {
      console.log(`  id=${m.id}`)
      console.log(`    scheduled: ${m.scheduledStart.toISOString()} → ${m.scheduledEnd.toISOString()}`)
      console.log(`    actual:    start=${m.actualStart?.toISOString() ?? '-'} end=${m.actualEnd?.toISOString() ?? '-'}`)
      console.log(`    createdAt=${m.createdAt.toISOString()}  updatedAt=${m.updatedAt.toISOString()}`)
      console.log(`    uri=${m.meetingUri}  space=${m.meetSpaceName}  code=${(m as any).meetingCode ?? '-'}`)
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

    // Look at flow steps to understand "onboarding" structure
    if (s.flow?.id) {
      const steps = await (prisma as any).flowStep.findMany({
        where: { flowId: s.flow.id },
        orderBy: { order: 'asc' },
      }).catch(async () => {
        // try alternate model names
        const tables = await prisma.$queryRawUnsafe<any>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%step%'`)
        console.log('flow step tables:', tables)
        return []
      })
      console.log(`Flow steps (${steps.length}):`)
      for (const st of steps) {
        console.log(`  [${st.order ?? '-'}] type=${st.type ?? '-'}  title="${st.title ?? '-'}"  id=${st.id}`)
      }
      console.log()
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
