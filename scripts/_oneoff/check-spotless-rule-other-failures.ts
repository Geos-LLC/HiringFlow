import { PrismaClient } from '@prisma/client'

// The rule "Candidate confirmation form submitted" has 4 steps (one immediate
// "Speaking test eamil" + three "Training email after completing form" at +2m).
// Steps run independently (not chained), so when SendGrid started rejecting,
// all 4 steps could have been affected. Check whether the +2m children also
// failed for the same 5 sessions.
async function main() {
  const prisma = new PrismaClient()

  const ruleName = 'Candidate confirmation form submitted '
  const wsName = 'Spotless Homes Florida LLC'

  const rule = await prisma.automationRule.findFirst({
    where: { name: ruleName, workspace: { name: wsName } },
    include: {
      steps: {
        orderBy: { order: 'asc' },
        select: { id: true, order: true, channel: true, delayMinutes: true, emailTemplate: { select: { name: true } } },
      },
    },
  })
  if (!rule) { console.log('Rule not found'); return }

  console.log(`Rule: ${rule.name}  (id=${rule.id})  active=${rule.isActive}  trigger=${rule.triggerType}`)
  console.log(`Steps:`)
  for (const s of rule.steps) {
    console.log(`  order=${s.order}  delay=${s.delayMinutes}m  ch=${s.channel}  template="${s.emailTemplate?.name ?? '-'}"  stepId=${s.id}`)
  }

  const stepIds = rule.steps.map((s) => s.id)
  const sessionIds = [
    'd941e227-4a77-485c-89e5-5f783d6dda72', // Stephan
    '60790830-d5f2-4ae4-a85b-fdf45f245af0', // Jada
    'b8622bf9-1646-4adb-9d97-98c77e431564', // Karen
    '54994cdf-c85c-49cb-bd99-32342f22092f', // Kyra
    'd74d652b-2f54-4fa0-baa9-6a7a76aba0ee', // Rodolfo
  ]

  const allExecs = await prisma.automationExecution.findMany({
    where: { stepId: { in: stepIds }, sessionId: { in: sessionIds } },
    select: { id: true, stepId: true, sessionId: true, status: true, sentAt: true, errorMessage: true, scheduledFor: true, createdAt: true, executionMode: true, deliveryStatus: true },
    orderBy: { createdAt: 'asc' },
  })

  const sessions = await prisma.session.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, candidateName: true, candidateEmail: true },
  })
  const sBy = new Map(sessions.map((s) => [s.id, s]))
  const stepBy = new Map(rule.steps.map((s) => [s.id, s]))

  console.log('\nPer-session breakdown of every execution under this rule:')
  for (const sid of sessionIds) {
    const s = sBy.get(sid)
    console.log(`\n  ${s?.candidateName ?? '?'} <${s?.candidateEmail ?? '?'}>  session=${sid}`)
    const sExecs = allExecs.filter((e) => e.sessionId === sid)
    if (sExecs.length === 0) { console.log(`    (no executions found)`); continue }
    for (const e of sExecs) {
      const step = stepBy.get(e.stepId ?? '')
      console.log(`    step.order=${step?.order ?? '?'}  template="${step?.emailTemplate?.name ?? '-'}"  status=${e.status}  mode=${e.executionMode ?? '-'}  sent=${e.sentAt?.toISOString() ?? '-'}  delivery=${e.deliveryStatus ?? '-'}  err=${e.errorMessage ?? '-'}  scheduledFor=${e.scheduledFor?.toISOString() ?? '-'}  createdAt=${e.createdAt.toISOString()}`)
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
