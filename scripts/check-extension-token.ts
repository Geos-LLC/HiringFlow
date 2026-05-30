import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20' // Spotless Homes Florida LLC

  const tokens = await prisma.extensionToken.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  })
  console.log(`ExtensionTokens for workspace ${workspaceId}:`)
  if (tokens.length === 0) console.log('  (none)')
  for (const t of tokens) {
    console.log(`  prefix=${t.prefix} created=${t.createdAt.toISOString()} lastUsed=${t.lastUsedAt?.toISOString() ?? 'NEVER'} revoked=${t.revokedAt?.toISOString() ?? '-'}`)
  }
  console.log()

  // Has the extension ever uploaded ANY attendance to this workspace?
  const lastUploads = await prisma.schedulingEvent.findMany({
    where: {
      eventType: 'attendance_uploaded',
      session: { workspaceId },
    },
    orderBy: { eventAt: 'desc' },
    take: 10,
    select: {
      eventAt: true, sessionId: true,
      session: { select: { candidateName: true, candidateEmail: true } },
      metadata: true,
    },
  })
  console.log(`Last 10 attendance_uploaded events in workspace:`)
  if (lastUploads.length === 0) console.log('  (NONE — extension has never POSTed)')
  for (const e of lastUploads) {
    const meta = e.metadata as Record<string, unknown> | null
    console.log(`  ${e.eventAt.toISOString()}  ${e.session.candidateName} <${e.session.candidateEmail}>  isFinal=${meta?.isFinal} participants=${meta?.participantCount}`)
  }
  console.log()

  // Cross-check the two meetings we already discussed
  for (const meetingId of ['0ae588cd-78f5-46ab-b22c-5f803b81a95f', '67dc6dfb-ec12-4eaa-86c4-c7c5c8b0b79a']) {
    const m = await prisma.interviewMeeting.findUnique({
      where: { id: meetingId },
      select: { id: true, meetingCode: true, sessionId: true, session: { select: { candidateName: true } } },
    })
    if (!m) continue
    const uploads = await prisma.schedulingEvent.findMany({
      where: {
        sessionId: m.sessionId,
        eventType: 'attendance_uploaded',
      },
      orderBy: { eventAt: 'desc' },
      select: { eventAt: true, metadata: true },
    })
    console.log(`Meeting ${m.id} (${m.session.candidateName}) meetingCode=${m.meetingCode}: ${uploads.length} attendance_uploaded events`)
    for (const u of uploads) {
      const meta = u.metadata as Record<string, unknown> | null
      console.log(`  ${u.eventAt.toISOString()}  isFinal=${meta?.isFinal}  participants=${meta?.participantCount}`)
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
