import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const email = 'shedrackamadi33@gmail.com'

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
    console.log(`  workspace: ${s.workspace.name} (${s.workspace.id}) tz=${s.workspace.timezone}`)
    console.log(`  flow: ${s.flow?.name ?? '-'} (pipelineId=${s.flow?.pipelineId ?? '-'})`)
    console.log(`  pipelineStatus: ${s.pipelineStatus}  status: ${s.status}  dispositionReason: ${s.dispositionReason ?? '-'}`)
    console.log(`  rejectionReason: ${s.rejectionReason ?? '-'}  at=${s.rejectionReasonAt?.toISOString() ?? '-'}`)
    console.log(`  startedAt=${s.startedAt.toISOString()}  finishedAt=${s.finishedAt?.toISOString() ?? '-'}  lastActivityAt=${s.lastActivityAt?.toISOString() ?? '-'}`)
    console.log(`  stalledAt=${s.stalledAt?.toISOString() ?? '-'}  lostAt=${s.lostAt?.toISOString() ?? '-'}  hiredAt=${s.hiredAt?.toISOString() ?? '-'}`)
    console.log(`  automationsHaltedAt=${s.automationsHaltedAt?.toISOString() ?? '-'}  reason=${s.automationsHaltedReason ?? '-'}`)
    console.log()

    const meetings = await prisma.interviewMeeting.findMany({
      where: { sessionId: s.id },
      orderBy: { scheduledStart: 'asc' },
    })
    console.log(`InterviewMeetings (${meetings.length}):`)
    for (const m of meetings) {
      console.log(`  Meeting ${m.id}`)
      console.log(`    scheduled: ${m.scheduledStart.toISOString()} → ${m.scheduledEnd?.toISOString() ?? '-'} confirmedAt=${m.confirmedAt?.toISOString() ?? '-'}`)
      console.log(`    attendanceStatus=${(m as any).attendanceStatus ?? '-'} attendanceSource=${(m as any).attendanceSource ?? '-'} checkedAt=${(m as any).attendanceCheckedAt?.toISOString() ?? '-'}`)
      console.log(`    actual: ${(m as any).actualStart?.toISOString() ?? '-'} → ${(m as any).actualEnd?.toISOString() ?? '-'}`)
      console.log(`    candidate joined=${(m as any).candidateJoined ?? '-'} joinedAt=${(m as any).candidateJoinedAt?.toISOString() ?? '-'} leftAt=${(m as any).candidateLeftAt?.toISOString() ?? '-'}`)
      console.log(`    host      joined=${(m as any).hostJoined ?? '-'} joinedAt=${(m as any).hostJoinedAt?.toISOString() ?? '-'} leftAt=${(m as any).hostLeftAt?.toISOString() ?? '-'}`)
      console.log(`    meetingCode=${(m as any).meetingCode ?? '-'} meetingUri=${(m as any).meetingUri ?? '-'} meetSpaceName=${(m as any).meetSpaceName ?? '-'}`)
      console.log(`    googleCalendarEventId=${(m as any).googleCalendarEventId ?? '-'}`)
      console.log(`    recording: enabled=${(m as any).recordingEnabled} provider=${(m as any).recordingProvider ?? '-'} state=${(m as any).recordingState ?? '-'} transcriptState=${(m as any).transcriptState ?? '-'}`)
      console.log(`    drive: rec=${(m as any).driveRecordingFileId ?? '-'} transcript=${(m as any).driveTranscriptFileId ?? '-'} geminiNotes=${(m as any).driveGeminiNotesFileId ?? '-'} attendanceSheet=${(m as any).attendanceSheetFileId ?? '-'}`)
      console.log(`    recallRecordingId=${(m as any).recallRecordingId ?? '-'}`)
      console.log(`    participants=${JSON.stringify((m as any).participants).slice(0, 220)}`)
      console.log(`    meetApiSyncedAt=${(m as any).meetApiSyncedAt?.toISOString() ?? '-'} subName=${(m as any).workspaceEventsSubName ?? '-'} subExp=${(m as any).workspaceEventsSubExpiresAt?.toISOString() ?? '-'}`)
      console.log(`    createdAt=${m.createdAt.toISOString()} updatedAt=${m.updatedAt.toISOString()}`)

      const artifacts = await prisma.interviewMeetingArtifact.findMany({
        where: { interviewMeetingId: m.id },
        orderBy: { discoveredAt: 'asc' },
      })
      console.log(`    Artifacts (${artifacts.length}):`)
      for (const a of artifacts) {
        console.log(`      kind=${(a as any).kind} drive=${(a as any).driveFileId} file=${(a as any).fileName ?? '-'} created=${(a as any).driveCreatedTime?.toISOString() ?? '-'} discovered=${(a as any).discoveredAt?.toISOString() ?? '-'}`)
      }

      const rawEvents = (m as any).rawEvents
      if (Array.isArray(rawEvents) && rawEvents.length > 0) {
        console.log(`    rawEvents (${rawEvents.length}):`)
        for (const ev of rawEvents.slice(-12)) {
          console.log(`      ${JSON.stringify(ev).slice(0, 260)}`)
        }
      }
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
      const metaStr = meta ? ` meta=${JSON.stringify(meta).slice(0, 220)}` : ''
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
      },
    })
    console.log(`AutomationExecutions (${executions.length}):`)
    for (const e of executions) {
      const rule = e.automationRule
      console.log(`  ${e.createdAt.toISOString()}  [${e.status}${e.skipReason ? ' / ' + e.skipReason : ''}] ${rule?.name ?? '-'} trig=${rule?.triggerType ?? '-'} stage=${rule?.stageId ?? '-'} pipeId=${rule?.pipelineId ?? '-'}`)
    }
    console.log()
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
