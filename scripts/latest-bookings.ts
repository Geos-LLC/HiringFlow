import { PrismaClient } from '@prisma/client'
async function main() {
  const p = new PrismaClient()
  console.log('NOW UTC:', new Date().toISOString())
  console.log()
  const ms = await p.interviewMeeting.findMany({
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: {
      id: true, sessionId: true, scheduledStart: true, scheduledEnd: true,
      createdAt: true, meetingUri: true, schedulingConfigId: true,
      session: { select: { candidateName: true, candidateEmail: true, source: true } },
    },
  })
  for (const m of ms) {
    const minsUntil = Math.round((m.scheduledStart.getTime() - Date.now()) / 60000)
    console.log(`created ${m.createdAt.toISOString()} → meeting ${m.scheduledStart.toISOString()} (${minsUntil > 0 ? `in ${minsUntil}m` : `${-minsUntil}m ago`})`)
    console.log(`  ${m.session.candidateName} <${m.session.candidateEmail}>  src=${m.session.source ?? '-'}`)
    console.log(`  uri=${m.meetingUri}`)
    console.log(`  meetingId=${m.id}  session=${m.sessionId}  cfg=${m.schedulingConfigId ?? '-'}`)
    console.log()
  }
  await p.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
