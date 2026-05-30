import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const sid = '17546143-875e-416e-a2c5-74ee215b4c66'
  const mid = 'fe2e4822-f6ab-42bb-bd5e-d4dc493e1ba1'

  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: mid },
    select: {
      driveRecordingFileId: true, driveTranscriptFileId: true,
      driveGeminiNotesFileId: true, attendanceSheetFileId: true,
      recordingState: true, transcriptState: true,
      actualStart: true, actualEnd: true, scheduledStart: true, scheduledEnd: true,
      workspaceId: true,
    },
  })
  console.log('=== Meeting Drive artifacts ===')
  console.log(`  recordingState=${meeting?.recordingState} drive=${meeting?.driveRecordingFileId ?? '-'}`)
  console.log(`  transcriptState=${meeting?.transcriptState} drive=${meeting?.driveTranscriptFileId ?? '-'}`)
  console.log(`  geminiNotes=${meeting?.driveGeminiNotesFileId ?? '-'}`)
  console.log(`  attendanceSheet=${meeting?.attendanceSheetFileId ?? '-'}`)
  console.log(`  actualStart=${meeting?.actualStart?.toISOString() ?? '-'}`)
  console.log(`  actualEnd=${meeting?.actualEnd?.toISOString() ?? '-'}`)

  console.log('\n=== Spotless workspace GoogleIntegration ===')
  const integ = await prisma.googleIntegration.findUnique({
    where: { workspaceId: meeting!.workspaceId },
    select: {
      hostedDomain: true, googleEmail: true, googleUserId: true, googleDisplayName: true,
      attendanceExtensionEnabled: true, recordingCapable: true,
      recordingCapabilityReason: true, meetRecordingsFolderId: true,
      lastSyncedAt: true,
    },
  })
  console.log(`  email=${integ?.googleEmail}  hostedDomain=${integ?.hostedDomain ?? 'NULL (personal gmail)'}`)
  console.log(`  attendanceExtensionEnabled=${integ?.attendanceExtensionEnabled}`)
  console.log(`  recordingCapable=${integ?.recordingCapable} reason=${integ?.recordingCapabilityReason}`)
  console.log(`  meetRecordingsFolderId=${integ?.meetRecordingsFolderId ?? '-'}`)

  console.log('\n=== Active ExtensionTokens (HF Meet Tracker) for this workspace ===')
  const tokens = await prisma.extensionToken.findMany({
    where: { workspaceId: meeting!.workspaceId },
    select: { id: true, prefix: true, revokedAt: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  for (const t of tokens) {
    console.log(`  ${t.prefix}... created=${t.createdAt.toISOString()} lastUsed=${t.lastUsedAt?.toISOString() ?? '-'} revoked=${t.revokedAt?.toISOString() ?? '-'}`)
  }

  console.log('\n=== Recent attendance_uploaded events for this session ===')
  const attEvents = await prisma.schedulingEvent.findMany({
    where: { sessionId: sid, eventType: 'attendance_uploaded' },
    orderBy: { eventAt: 'desc' },
    select: { eventAt: true, metadata: true },
  })
  if (attEvents.length === 0) console.log('  (none — extension never posted attendance for this meeting)')
  for (const e of attEvents) {
    console.log(`  ${e.eventAt.toISOString()}  meta=${JSON.stringify(e.metadata)}`)
  }

  await prisma.$disconnect()
}
main().catch(console.error).finally(() => process.exit(0))
