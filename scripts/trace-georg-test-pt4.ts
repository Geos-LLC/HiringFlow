import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'

  console.log('=== ALL ExtensionTokens (incl revoked) for Spotless workspace ===')
  const tokens = await prisma.extensionToken.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, prefix: true, label: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  })
  for (const t of tokens) {
    console.log(`  ${t.prefix}... label="${t.label ?? '-'}" created=${t.createdAt.toISOString()} lastUsed=${t.lastUsedAt?.toISOString() ?? '-'} revoked=${t.revokedAt?.toISOString() ?? '-'}`)
  }

  console.log('\n=== ALL attendance_uploaded events for the workspace (ever) ===')
  const events = await prisma.schedulingEvent.findMany({
    where: {
      eventType: 'attendance_uploaded',
      session: { workspaceId },
    },
    orderBy: { eventAt: 'desc' },
    take: 30,
    select: {
      eventAt: true, sessionId: true, metadata: true,
      session: { select: { candidateName: true } },
    },
  })
  if (events.length === 0) console.log('  (none — extension has never posted attendance for any meeting in this workspace)')
  for (const e of events) {
    const md = e.metadata as Record<string, unknown> | null
    console.log(`  ${e.eventAt.toISOString()} candidate="${e.session.candidateName}" meetingCode=${md?.meetingCode ?? '?'} isFinal=${md?.isFinal ?? '?'} participants=${md?.participantCount ?? '?'}`)
  }

  console.log('\n=== All meetings in Spotless workspace (last 14 days) ===')
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  const meetings = await prisma.interviewMeeting.findMany({
    where: { workspaceId, scheduledStart: { gte: cutoff } },
    orderBy: { scheduledStart: 'desc' },
    select: {
      id: true, scheduledStart: true, scheduledEnd: true,
      actualStart: true, actualEnd: true, meetingCode: true,
      participants: true,
      session: { select: { candidateName: true, pipelineStatus: true } },
    },
  })
  for (const m of meetings) {
    const ps = Array.isArray(m.participants) ? m.participants.length : 0
    console.log(`  ${m.scheduledStart.toISOString()}  ${m.session.candidateName} (${m.session.pipelineStatus})  code=${m.meetingCode}  participants=${ps}  actualStart=${m.actualStart?.toISOString() ?? '-'}  actualEnd=${m.actualEnd?.toISOString() ?? '-'}`)
  }

  await prisma.$disconnect()
}
main().catch(console.error).finally(() => process.exit(0))
