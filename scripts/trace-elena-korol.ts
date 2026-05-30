import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const email = process.argv[2] || 'ekorol@tut.by'

  const sessions = await prisma.session.findMany({
    where: { candidateEmail: { equals: email, mode: 'insensitive' } },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, candidateName: true, candidateEmail: true, candidatePhone: true,
      pipelineStatus: true, status: true, dispositionReason: true,
      rejectionReason: true, rejectionReasonAt: true,
      stalledAt: true, lostAt: true, hiredAt: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
      workspace: { select: { id: true, name: true, timezone: true } },
      flow: { select: { id: true, name: true, slug: true } },
    },
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Found ${sessions.length} session(s) for ${email}`)
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
        driveRecordingFileId: true, driveTranscriptFileId: true,
        driveGeminiNotesFileId: true, attendanceSheetFileId: true,
        workspaceEventsSubName: true, workspaceEventsSubExpiresAt: true,
        meetApiSyncedAt: true, confirmedAt: true,
        spaceAdoptedFromReschedule: true,
        participants: true,
      },
    })
    console.log(`InterviewMeetings (${meetings.length}):`)
    for (const m of meetings) {
      const minsSinceStart = Math.round((Date.now() - m.scheduledStart.getTime()) / 60000)
      const minsSinceEnd = Math.round((Date.now() - m.scheduledEnd.getTime()) / 60000)
      console.log(`  meeting id=${m.id}`)
      console.log(`    scheduled: ${m.scheduledStart.toISOString()} → ${m.scheduledEnd.toISOString()}`)
      console.log(`    elapsed:   start ${minsSinceStart}m ago, end ${minsSinceEnd}m ago`)
      console.log(`    actual:    start=${m.actualStart?.toISOString() ?? '-'} end=${m.actualEnd?.toISOString() ?? '-'}`)
      console.log(`    recording: state=${m.recordingState} fileId=${m.driveRecordingFileId ?? '-'}`)
      console.log(`    transcript: state=${m.transcriptState} fileId=${m.driveTranscriptFileId ?? '-'}`)
      console.log(`    gemini-notes fileId: ${m.driveGeminiNotesFileId ?? '-'}`)
      console.log(`    attendance-sheet fileId: ${m.attendanceSheetFileId ?? '-'}`)
      console.log(`    workspaceEvents sub: ${m.workspaceEventsSubName ?? '-'}  expires=${m.workspaceEventsSubExpiresAt?.toISOString() ?? '-'}`)
      console.log(`    meetApiSyncedAt: ${m.meetApiSyncedAt?.toISOString() ?? '-'}`)
      console.log(`    confirmedAt: ${m.confirmedAt?.toISOString() ?? '-'}`)
      console.log(`    spaceAdoptedFromReschedule: ${m.spaceAdoptedFromReschedule}`)
      console.log(`    uri=${m.meetingUri}  space=${m.meetSpaceName}`)
      const ps = m.participants as unknown
      if (Array.isArray(ps) && ps.length) {
        console.log(`    participants: ${ps.length}`)
        for (const p of ps as Array<Record<string, unknown>>) {
          console.log(`      - ${JSON.stringify(p).slice(0, 200)}`)
        }
      } else {
        console.log(`    participants: (none)`)
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
      const metaStr = meta ? ` meta=${JSON.stringify(meta).slice(0, 200)}` : ''
      console.log(`  ${e.eventAt.toISOString()}  ${e.eventType}${metaStr}`)
    }
    console.log()

    const gi = await prisma.googleIntegration.findFirst({
      where: { workspaceId: s.workspace.id },
      select: {
        id: true, googleEmail: true, hostedDomain: true,
        recordingCapable: true, recordingCapabilityReason: true,
        transcriptionCapable: true, transcriptionCapabilityReason: true,
        attendanceExtensionEnabled: true,
        lastSyncedAt: true, accessExpiresAt: true,
        grantedScopes: true,
      },
    })
    console.log('GoogleIntegration:')
    if (!gi) { console.log('  (none)') }
    else {
      console.log(`  email=${gi.googleEmail}  hostedDomain=${gi.hostedDomain ?? 'NULL (personal/individual)'}`)
      console.log(`  recordingCapable=${gi.recordingCapable} (${gi.recordingCapabilityReason ?? '-'})`)
      console.log(`  transcriptionCapable=${gi.transcriptionCapable} (${gi.transcriptionCapabilityReason ?? '-'})`)
      console.log(`  attendanceExtensionEnabled=${gi.attendanceExtensionEnabled}`)
      console.log(`  lastSyncedAt=${gi.lastSyncedAt?.toISOString() ?? '-'}  accessExpiresAt=${gi.accessExpiresAt?.toISOString() ?? '-'}`)
      console.log(`  scopes=${gi.grantedScopes?.slice(0, 200) ?? '-'}`)
    }
    console.log()
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
