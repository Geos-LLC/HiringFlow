import { PrismaClient } from '@prisma/client'
async function main() {
  const p = new PrismaClient()
  const s = await p.session.findUnique({
    where: { id: 'f86a8ddf-342a-4186-81f7-c681e0cb04e6' },
    select: { candidateName: true, candidateEmail: true, candidatePhone: true },
  })
  console.log('prorabserv session phone:', s?.candidatePhone)
  console.log('candidate name:', s?.candidateName, 'email:', s?.candidateEmail)

  const sms = await p.automationExecution.findMany({
    where: { channel: 'sms', sentAt: { gt: new Date(Date.now() - 4 * 60 * 60_000) } },
    orderBy: { sentAt: 'desc' },
    select: {
      sessionId: true, sentAt: true, providerMessageId: true,
      automationRule: { select: { name: true } },
      step: { select: { timingMode: true, delayMinutes: true, smsDestination: true, smsDestinationNumber: true } },
    },
  })
  console.log(`\nSMS sent in last 4 hours (any session): ${sms.length} rows`)
  for (const e of sms) {
    const sess = e.sessionId ? await p.session.findUnique({ where: { id: e.sessionId }, select: { candidateName: true, candidatePhone: true } }) : null
    const dest = e.step?.smsDestination ?? '?'
    const destNum = e.step?.smsDestinationNumber ?? '-'
    console.log(`  ${e.sentAt?.toISOString()}  candidate=${sess?.candidateName || '-'} candidatePhone=${sess?.candidatePhone || '-'}  smsDest=${dest}/${destNum}  rule="${e.automationRule?.name}"  step=${e.step?.timingMode}=${e.step?.delayMinutes}m  msgId=${e.providerMessageId}`)
  }
  await p.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
