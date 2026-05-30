import { PrismaClient } from '@prisma/client'
import { getAuthedClientForWorkspace } from '../src/lib/google'
import {
  findMeetRecordingsFolderId,
  searchMeetRecordings,
  getFileMeta,
} from '../src/lib/meet/google-drive'

async function main() {
  const prisma = new PrismaClient()

  const meetingId = '8730c3c0-bc6f-4216-804b-a29dba782811'
  const m = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true, workspaceId: true, meetSpaceName: true, meetingCode: true,
      scheduledStart: true, scheduledEnd: true, actualStart: true, actualEnd: true,
      driveRecordingFileId: true,
    },
  })
  if (!m) { console.log('meeting not found'); return }
  console.log('Kateryna meeting:')
  console.log(`  meetSpaceName: ${m.meetSpaceName}`)
  console.log(`  meetingCode: ${m.meetingCode}`)
  console.log(`  scheduled: ${m.scheduledStart.toISOString()} – ${m.scheduledEnd.toISOString()}`)
  console.log(`  actual: ${m.actualStart?.toISOString()} – ${m.actualEnd?.toISOString()}`)
  console.log(`  driveRecordingFileId (currently linked): ${m.driveRecordingFileId}`)
  console.log()

  const authed = await getAuthedClientForWorkspace(m.workspaceId)
  if (!authed) { console.log('no google auth'); return }

  // Inspect the linked file
  if (m.driveRecordingFileId) {
    console.log(`Linked recording metadata:`)
    try {
      const meta = await getFileMeta(authed.client, m.driveRecordingFileId)
      console.log(`  name: ${meta.name}`)
      console.log(`  size: ${meta.size ? `${Number(meta.size) / 1024 / 1024} MB` : '?'}`)
      console.log(`  createdTime: ${meta.createdTime}`)
      console.log(`  mimeType: ${meta.mimeType}`)
    } catch (e) {
      console.log(`  ERROR: ${e}`)
    }
  }
  console.log()

  // Wider Drive scan: every video file in the Meet Recordings folder created
  // in the meeting window (± a few hours either side).
  const folder = await findMeetRecordingsFolderId(authed.client)
  console.log(`Meet Recordings folder id: ${folder}`)
  if (!folder) return

  const after = new Date(m.scheduledStart.getTime() - 2 * 60 * 60 * 1000) // 2h before scheduled start
  const before = new Date(m.scheduledStart.getTime() + 6 * 60 * 60 * 1000) // 6h after scheduled start
  console.log(`Scanning ${after.toISOString()} – ${before.toISOString()}`)

  const files = await searchMeetRecordings(authed.client, {
    folderId: folder,
    createdAfter: after,
    createdBefore: before,
    limit: 30,
  })
  console.log(`\nFound ${files.length} mp4 files in window:`)
  for (const f of files) {
    const isLinked = f.id === m.driveRecordingFileId ? ' ← currently linked' : ''
    const sizeMB = f.size ? `${(Number(f.size) / 1024 / 1024).toFixed(2)} MB` : '?'
    console.log(`  - ${f.createdTime}  ${sizeMB}  ${f.name}  (id=${f.id})${isLinked}`)
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
