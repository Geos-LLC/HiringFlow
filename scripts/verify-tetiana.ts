import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
;(async () => {
  const meetings = await p.interviewMeeting.findMany({
    where: { sessionId: '44447679-dc84-40a6-9018-300f88c442c3' },
    orderBy: { scheduledStart: 'asc' },
    select: {
      id: true, meetingCode: true, meetSpaceName: true,
      driveRecordingFileId: true, driveGeminiNotesFileId: true,
      artifacts: {
        orderBy: { driveCreatedTime: 'asc' },
        select: { kind: true, driveFileId: true, fileName: true, meetSpaceName: true, driveCreatedTime: true },
      },
    },
  })
  for (const m of meetings) {
    console.log(`Meeting ${m.id} code=${m.meetingCode} space=${m.meetSpaceName}`)
    console.log(`  primary recording: ${m.driveRecordingFileId ?? '-'}`)
    console.log(`  primary geminiNotes: ${m.driveGeminiNotesFileId ?? '-'}`)
    console.log(`  artifacts (${m.artifacts.length}):`)
    for (const a of m.artifacts) {
      console.log(`    ${a.kind.padEnd(13)} ${a.driveFileId.slice(0, 33).padEnd(34)} space=${a.meetSpaceName ?? '-'} created=${a.driveCreatedTime.toISOString()}`)
      console.log(`      name=${a.fileName ?? '-'}`)
    }
    console.log()
  }
  await p.$disconnect()
})().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
