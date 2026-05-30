// Mimics what the GET /api/candidates/[id]/interview-meetings endpoint
// returns to the InterviewPanel UI.
import { PrismaClient } from '@prisma/client'

const SESSION_ID = '44447679-dc84-40a6-9018-300f88c442c3'

async function main() {
  const p = new PrismaClient()
  const meetings = await p.interviewMeeting.findMany({
    where: { sessionId: SESSION_ID },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      meetingUri: true,
      meetingCode: true,
      meetSpaceName: true,
      scheduledStart: true,
      scheduledEnd: true,
      actualStart: true,
      actualEnd: true,
      recordingEnabled: true,
      recordingState: true,
      recordingProvider: true,
      transcriptState: true,
      driveRecordingFileId: true,
      driveTranscriptFileId: true,
      driveGeminiNotesFileId: true,
      attendanceSheetFileId: true,
      participants: true,
      confirmedAt: true,
      createdAt: true,
      artifacts: {
        select: {
          id: true, kind: true, driveFileId: true, fileName: true,
          meetSpaceName: true, driveCreatedTime: true,
        },
        orderBy: { driveCreatedTime: 'asc' },
      },
    },
  })

  console.log(`API would return ${meetings.length} meetings:\n`)
  for (const m of meetings) {
    console.log(`  id=${m.id} code=${m.meetingCode}`)
    console.log(`    primary recording: ${m.driveRecordingFileId ?? '-'}`)
    console.log(`    recordingState=${m.recordingState}`)
    console.log(`    artifacts.length=${m.artifacts.length}`)
    for (const a of m.artifacts) {
      const isPrimary = a.driveFileId === m.driveRecordingFileId ? ' [PRIMARY]' : ''
      console.log(`      ${a.kind.padEnd(13)} ${a.driveFileId.slice(0, 33).padEnd(34)} ${isPrimary}`)
    }
    console.log()
  }
  await p.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
