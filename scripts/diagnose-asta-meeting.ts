import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const wsId = '739bcd71-69fd-4b30-a39e-242521b7ab20'
  const meetingId = 'e14af188-1c4d-4d48-b6dd-453608d0a3c3'

  // Meeting code as stored vs what extension would POST
  const m = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true, meetingCode: true, meetingUri: true,
      scheduledStart: true, scheduledEnd: true,
      actualStart: true, actualEnd: true,
      meetSpaceName: true, recordingState: true, recordingEnabled: true,
      driveRecordingFileId: true, driveGeminiNotesFileId: true,
      attendanceSheetFileId: true, meetApiSyncedAt: true,
      participants: true,
    },
  })
  console.log('=== Asta meeting row ===')
  console.log(JSON.stringify(m, null, 2))

  // ExtensionToken — does this workspace have a Meet Tracker token?
  const tokens = await prisma.extensionToken.findMany({
    where: { workspaceId: wsId },
    select: { id: true, label: true, lastUsedAt: true, revokedAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  console.log(`\n=== ExtensionTokens for workspace (${tokens.length}) ===`)
  for (const t of tokens) console.log(' ', t)

  // Recent attendance_uploaded events workspace-wide (last 24h)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recent = await prisma.schedulingEvent.findMany({
    where: {
      eventType: 'attendance_uploaded',
      eventAt: { gte: since },
      session: { workspaceId: wsId },
    },
    select: { eventAt: true, sessionId: true, metadata: true },
    orderBy: { eventAt: 'desc' },
    take: 20,
  })
  console.log(`\n=== Recent attendance_uploaded events (last 24h, ${recent.length}) ===`)
  for (const r of recent) console.log(`  ${r.eventAt.toISOString()} session=${r.sessionId}  ${JSON.stringify(r.metadata)}`)

  // Recent ALL events for Asta's meeting (cross-check)
  const allForMeeting = await prisma.schedulingEvent.findMany({
    where: {
      metadata: { path: ['interviewMeetingId'], equals: meetingId },
    },
    orderBy: { eventAt: 'asc' },
    select: { eventType: true, eventAt: true, metadata: true },
  })
  console.log(`\n=== ALL events referencing this meetingId (${allForMeeting.length}) ===`)
  for (const e of allForMeeting) console.log(`  ${e.eventAt.toISOString()} ${e.eventType}  ${JSON.stringify(e.metadata)}`)

  // Workspace funnel stages (so we know what stage_7 is)
  const ws = await prisma.workspace.findUnique({
    where: { id: wsId },
    select: { settings: true },
  })
  const stages = (ws?.settings as { funnelStages?: any[] } | null)?.funnelStages
  console.log('\n=== Workspace funnel stages ===')
  if (Array.isArray(stages)) {
    for (const s of stages) console.log(`  ${s.id}  label="${s.label}" order=${s.order} triggers=${JSON.stringify(s.triggers)}`)
  } else {
    console.log('  (default stages, no custom config)')
  }
}
main().catch(console.error).finally(() => prisma.$disconnect())
