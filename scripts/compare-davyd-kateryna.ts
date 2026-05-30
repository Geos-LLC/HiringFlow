import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  // Window: Monday May 18 2026, 10:00am - 1:00pm in any common US tz.
  // We'll search by scheduledStart in UTC ±12h around 11am/12pm to be safe.
  const dayStart = new Date('2026-05-18T00:00:00Z')
  const dayEnd = new Date('2026-05-19T23:59:59Z')

  const meetings = await prisma.interviewMeeting.findMany({
    where: {
      scheduledStart: { gte: dayStart, lte: dayEnd },
      OR: [
        { session: { candidateName: { contains: 'Davyd', mode: 'insensitive' } } },
        { session: { candidateName: { contains: 'Kovtun', mode: 'insensitive' } } },
        { session: { candidateName: { contains: 'Kateryna', mode: 'insensitive' } } },
        { session: { candidateName: { contains: 'Catherine', mode: 'insensitive' } } },
      ],
    },
    select: {
      id: true,
      scheduledStart: true,
      scheduledEnd: true,
      actualStart: true,
      actualEnd: true,
      meetingUri: true,
      meetingCode: true,
      meetSpaceName: true,
      googleCalendarEventId: true,
      recordingEnabled: true,
      driveRecordingFileId: true,
      driveTranscriptFileId: true,
      driveGeminiNotesFileId: true,
      attendanceSheetFileId: true,
      recordingState: true,
      transcriptState: true,
      confirmedAt: true,
      participants: true,
      meetApiSyncedAt: true,
      spaceAdoptedFromReschedule: true,
      session: {
        select: {
          id: true,
          candidateName: true,
          candidateEmail: true,
          workspaceId: true,
          workspace: { select: { name: true, meetIntegrationV2Enabled: true } },
        },
      },
      artifacts: {
        select: {
          id: true,
          kind: true,
          driveFileId: true,
          meetSpaceName: true,
          driveCreatedTime: true,
          fileName: true,
          discoveredAt: true,
        },
        orderBy: { discoveredAt: 'asc' },
      },
    },
    orderBy: { scheduledStart: 'asc' },
  })

  console.log(`Found ${meetings.length} meeting(s) on May 18 2026 for Davyd/Kateryna`)
  console.log('---')
  for (const m of meetings) {
    console.log(`\nMeeting ${m.id}`)
    console.log(`  candidate: ${m.session.candidateName} <${m.session.candidateEmail}>`)
    console.log(`  workspace: ${m.session.workspace.name}  meetV2=${m.session.workspace.meetIntegrationV2Enabled}`)
    console.log(`  scheduled: ${m.scheduledStart.toISOString()} – ${m.scheduledEnd.toISOString()}`)
    console.log(`  actual   : ${m.actualStart?.toISOString() ?? '-'} – ${m.actualEnd?.toISOString() ?? '-'}`)
    console.log(`  meetingUri: ${m.meetingUri ?? '-'}`)
    console.log(`  meetingCode: ${m.meetingCode ?? '-'}`)
    console.log(`  meetSpaceName: ${m.meetSpaceName ?? '-'}`)
    console.log(`  googleCalendarEventId: ${m.googleCalendarEventId ?? '-'}`)
    console.log(`  recordingEnabled: ${m.recordingEnabled}`)
    console.log(`  recordingState: ${m.recordingState ?? '-'}`)
    console.log(`  driveRecordingFileId: ${m.driveRecordingFileId ?? '-'}`)
    console.log(`  driveTranscriptFileId: ${m.driveTranscriptFileId ?? '-'}`)
    console.log(`  driveGeminiNotesFileId: ${m.driveGeminiNotesFileId ?? '-'}`)
    console.log(`  attendanceSheetFileId: ${m.attendanceSheetFileId ?? '-'}`)
    console.log(`  transcriptState: ${m.transcriptState}`)
    console.log(`  meetApiSyncedAt: ${m.meetApiSyncedAt?.toISOString() ?? '-'}`)
    console.log(`  spaceAdoptedFromReschedule: ${m.spaceAdoptedFromReschedule}`)
    console.log(`  confirmedAt: ${m.confirmedAt?.toISOString() ?? '-'}`)
    console.log(`  participants: ${JSON.stringify(m.participants)}`)
    console.log(`  artifacts (${m.artifacts.length}):`)
    for (const a of m.artifacts) {
      console.log(`    - kind=${a.kind} space=${a.meetSpaceName ?? '-'} created=${a.driveCreatedTime?.toISOString() ?? '-'} discovered=${a.discoveredAt?.toISOString() ?? '-'} file=${a.fileName ?? '-'} driveId=${a.driveFileId}`)
    }

    // SchedulingEvents tied to this meeting
    const evts = await prisma.schedulingEvent.findMany({
      where: {
        sessionId: m.session.id,
        OR: [
          { metadata: { path: ['interviewMeetingId'], equals: m.id } },
        ],
      },
      orderBy: { eventAt: 'asc' },
      select: { eventType: true, eventAt: true, metadata: true },
    })
    console.log(`  scheduling events (${evts.length}):`)
    for (const e of evts) {
      console.log(`    - ${e.eventAt.toISOString()}  ${e.eventType}  src=${(e.metadata as any)?.source ?? '-'}`)
    }
  }

  // Also: look up the workspace's GoogleIntegration to know if recordingCapable
  if (meetings.length > 0) {
    const wsIds = [...new Set(meetings.map((m) => m.session.workspaceId))]
    for (const wsId of wsIds) {
      const gi = await prisma.googleIntegration.findUnique({
        where: { workspaceId: wsId },
        select: {
          hostedDomain: true,
          recordingCapable: true,
          recordingCapabilityReason: true,
          recordingCapabilityCheckedAt: true,
          lastSyncedAt: true,
          watchExpiresAt: true,
          attendanceExtensionEnabled: true,
          grantedScopes: true,
        },
      })
      console.log(`\nWorkspace ${wsId} GoogleIntegration:`)
      console.log(`  hostedDomain: ${gi?.hostedDomain ?? '(personal Gmail)'}`)
      console.log(`  recordingCapable: ${gi?.recordingCapable}  reason=${gi?.recordingCapabilityReason ?? '-'}  checkedAt=${gi?.recordingCapabilityCheckedAt?.toISOString() ?? '-'}`)
      console.log(`  attendanceExtensionEnabled: ${gi?.attendanceExtensionEnabled}`)
      console.log(`  lastSyncedAt: ${gi?.lastSyncedAt?.toISOString() ?? '-'}  watchExpiresAt: ${gi?.watchExpiresAt?.toISOString() ?? '-'}`)
      console.log(`  grantedScopes: ${gi?.grantedScopes?.join(' ') ?? '-'}`)
    }
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
