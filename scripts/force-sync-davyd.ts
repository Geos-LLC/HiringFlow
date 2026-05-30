/**
 * Force-run sync-on-read for Davyd Kovtun's meeting, bypassing the 5-min
 * throttle by clearing meetApiSyncedAt first.
 */

import { PrismaClient } from '@prisma/client'
import { syncMeetingFromMeetApi } from '../src/lib/meet/sync-on-read'

const prisma = new PrismaClient()
const MEETING_ID = '87a9d811-ad83-4523-af74-6c0337da560b'

async function main() {
  await prisma.interviewMeeting.update({
    where: { id: MEETING_ID },
    data: { meetApiSyncedAt: null },
  })

  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: MEETING_ID },
    select: {
      id: true, workspaceId: true, sessionId: true, meetSpaceName: true,
      scheduledStart: true, scheduledEnd: true, actualStart: true, actualEnd: true,
      recordingState: true, transcriptState: true,
      meetApiSyncedAt: true, attendanceSheetFileId: true,
      driveRecordingFileId: true, driveGeminiNotesFileId: true, driveTranscriptFileId: true,
    },
  })
  if (!meeting) { console.log('No meeting'); return }
  console.log('Before:', { transcriptState: meeting.transcriptState, driveTranscriptFileId: meeting.driveTranscriptFileId })
  const changed = await syncMeetingFromMeetApi(meeting)
  console.log('Sync returned:', changed)

  const after = await prisma.interviewMeeting.findUnique({
    where: { id: MEETING_ID },
    select: { transcriptState: true, driveTranscriptFileId: true, recordingState: true, meetApiSyncedAt: true },
  })
  console.log('After:', after)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
