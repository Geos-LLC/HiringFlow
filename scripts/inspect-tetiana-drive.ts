import { PrismaClient } from '@prisma/client'
import { getAuthedClientForWorkspace } from '../src/lib/google'

async function main() {
  const prisma = new PrismaClient()
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'

  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) { console.error('No authed client'); process.exit(1) }

  const tok = await authed.client.getAccessToken()
  if (!tok?.token) throw new Error('no access token')

  // Find every Meet artifact (recording mp4 + Gemini Notes doc) whose name
  // mentions Tetiana, regardless of folder.
  const q = encodeURIComponent("name contains 'Tetiana' and trashed=false")
  const fields = encodeURIComponent(
    'files(id,name,mimeType,createdTime,modifiedTime,parents,webViewLink,size)'
  )
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=50&orderBy=createdTime%20desc`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok.token}` } })
  if (!res.ok) {
    console.error('drive list failed', res.status, await res.text())
    process.exit(1)
  }
  const body = await res.json() as any
  const files = body.files ?? []
  console.log(`Drive files containing 'Tetiana' (${files.length}):\n`)
  for (const f of files) {
    console.log(`  ${f.id}`)
    console.log(`    name=${f.name}`)
    console.log(`    mime=${f.mimeType}`)
    console.log(`    created=${f.createdTime}`)
    console.log(`    modified=${f.modifiedTime}`)
    console.log(`    parents=${(f.parents || []).join(',')}`)
    console.log(`    size=${f.size ?? '-'}`)
    console.log(`    link=${f.webViewLink}`)
    console.log()
  }

  // Cross-ref with our InterviewMeeting rows
  const meetings = await prisma.interviewMeeting.findMany({
    where: { sessionId: '44447679-dc84-40a6-9018-300f88c442c3' },
    orderBy: { scheduledStart: 'asc' },
    select: {
      id: true, meetingCode: true, meetSpaceName: true, meetingUri: true,
      driveRecordingFileId: true, driveGeminiNotesFileId: true,
      scheduledStart: true, scheduledEnd: true,
    },
  })
  console.log('InterviewMeeting rows for Tetiana session:')
  for (const m of meetings) {
    console.log(`  ${m.id}  code=${m.meetingCode}  uri=${m.meetingUri}`)
    console.log(`    recording=${m.driveRecordingFileId ?? '-'}  notes=${m.driveGeminiNotesFileId ?? '-'}`)
    console.log(`    window=${m.scheduledStart.toISOString()} → ${m.scheduledEnd.toISOString()}`)
  }

  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
