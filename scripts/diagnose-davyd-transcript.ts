/**
 * Diagnose why Davyd Kovtun's interview meeting transcript is stuck on
 * "processing" despite the fix in fe3d996 going live.
 *
 * Walks: session → interview meeting → conference record → listTranscripts.
 * Prints what Google's Meet API actually says about the conference, so we
 * know whether the transcript exists, is FILE_GENERATED, etc.
 *
 * Read-only — does not mutate state.
 */

import { PrismaClient } from '@prisma/client'
import { withWorkspaceMeetClient, listConferenceRecords, listRecordings, listTranscripts } from '../src/lib/meet/google-meet'
import { findMeetRecordingsFolderId, searchMeetTranscripts } from '../src/lib/meet/google-drive'

const prisma = new PrismaClient()
const SESSION_ID = 'ae7bc9cd-4707-4d93-bc70-ceab5a65b513'

async function main() {
  const session = await prisma.session.findUnique({
    where: { id: SESSION_ID },
    select: {
      id: true, workspaceId: true, candidateName: true, candidateEmail: true,
      flowId: true, startedAt: true, finishedAt: true,
    },
  })
  if (!session) { console.log('No session'); return }
  console.log('SESSION:', session)

  const meetings = await prisma.interviewMeeting.findMany({
    where: { sessionId: SESSION_ID },
    orderBy: { scheduledStart: 'desc' },
    select: {
      id: true, workspaceId: true, sessionId: true, meetSpaceName: true, meetingUri: true,
      scheduledStart: true, scheduledEnd: true, actualStart: true, actualEnd: true,
      recordingState: true, transcriptState: true,
      driveRecordingFileId: true, driveTranscriptFileId: true, driveGeminiNotesFileId: true,
      meetApiSyncedAt: true, recordingEnabled: true,
    },
  })
  console.log(`\nINTERVIEW MEETINGS (${meetings.length}):`)
  for (const m of meetings) {
    console.log(' ', JSON.stringify(m, null, 2))
  }
  if (meetings.length === 0) return

  const integ = await prisma.googleIntegration.findUnique({
    where: { workspaceId: session.workspaceId },
    select: {
      hostedDomain: true, googleEmail: true, googleDisplayName: true,
      grantedScopes: true, attendanceExtensionEnabled: true, meetRecordingsFolderId: true,
    },
  })
  console.log('\nINTEGRATION:', integ)

  for (const m of meetings) {
    if (!m.meetSpaceName) { console.log(`\n[meeting ${m.id}] no meetSpaceName, skipping API probe`); continue }
    console.log(`\n=== Probing Meet API for meeting ${m.id} (space=${m.meetSpaceName}) ===`)
    const probe = await withWorkspaceMeetClient(m.workspaceId, async (client) => {
      const confs = await listConferenceRecords(client, m.meetSpaceName!)
      console.log(`  conferenceRecords: ${confs.length}`)
      for (const c of confs) console.log('    ', c)
      if (confs.length === 0) {
        // Fall back to Drive search like personal-Gmail path.
        const folderId = integ?.meetRecordingsFolderId || await findMeetRecordingsFolderId(client).catch((e) => { console.log('    findMeetRecordingsFolderId failed:', (e as Error).message); return null })
        console.log('    meetRecordingsFolderId:', folderId)
        if (folderId && session.candidateName) {
          const start = m.scheduledStart ?? new Date(0)
          const end = m.scheduledEnd ?? new Date(Date.now() + 24 * 60 * 60 * 1000)
          const docs = await searchMeetTranscripts(client, {
            folderId,
            candidateName: session.candidateName,
            createdAfter: new Date(start.getTime() - 60 * 60 * 1000),
            createdBefore: new Date(end.getTime() + 3 * 60 * 60 * 1000),
            limit: 10,
          }).catch((e) => { console.log('    searchMeetTranscripts failed:', (e as Error).message); return [] })
          console.log(`    Drive transcript search returned ${docs.length} file(s):`)
          for (const d of docs) console.log('      ', d.id, d.name, d.createdTime, d.mimeType)
        }
        return
      }
      const conf = [...confs].sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))[0]
      console.log('  Using conf:', conf.name)
      const recs = await listRecordings(client, conf.name).catch((e) => { console.log('  listRecordings failed:', (e as Error).message); return [] })
      console.log(`  listRecordings: ${recs.length}`)
      for (const r of recs) console.log('    ', r)
      const tx = await listTranscripts(client, conf.name).catch((e) => { console.log('  listTranscripts failed:', (e as Error).message); return [] })
      console.log(`  listTranscripts: ${tx.length}`)
      for (const t of tx) console.log('    ', t)
    }).catch((e) => { console.log('  Meet client error:', (e as Error).message) })
    if (probe === null) console.log('  No Google integration on workspace')
  }
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
