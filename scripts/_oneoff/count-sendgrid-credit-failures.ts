import { PrismaClient } from '@prisma/client'

// Read-only audit: find every AutomationExecution that died on the SendGrid
// "Maximum credits exceeded" error so we know the blast radius BEFORE we
// trigger any resends. SendGrid returns that exact string in
// error.response.body.errors[0].message when the account hits its plan cap;
// our send wrapper (src/lib/email.ts) stores it verbatim in errorMessage.
async function main() {
  const prisma = new PrismaClient()

  const failed = await prisma.automationExecution.findMany({
    where: {
      status: 'failed',
      errorMessage: { contains: 'credits', mode: 'insensitive' },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      automationRule: { select: { name: true, workspace: { select: { id: true, name: true } } } },
      step: { select: { id: true, channel: true, emailTemplate: { select: { subject: true } } } },
    },
  })

  console.log(`\nTotal failed executions with credit-related errorMessage: ${failed.length}`)

  // Group by error string so we can see if there are other related errors.
  const byErr = new Map<string, number>()
  for (const e of failed) {
    const k = e.errorMessage ?? '(null)'
    byErr.set(k, (byErr.get(k) ?? 0) + 1)
  }
  console.log('\nBreakdown by errorMessage:')
  for (const [msg, n] of byErr) console.log(`  [${n}] "${msg}"`)

  // Time range.
  if (failed.length > 0) {
    const oldest = failed[failed.length - 1].createdAt
    const newest = failed[0].createdAt
    console.log(`\nTime range: ${oldest.toISOString()}  →  ${newest.toISOString()}`)
  }

  // Workspaces affected.
  const byWs = new Map<string, { name: string; count: number }>()
  for (const e of failed) {
    const id = e.automationRule.workspace.id
    const cur = byWs.get(id) ?? { name: e.automationRule.workspace.name, count: 0 }
    cur.count += 1
    byWs.set(id, cur)
  }
  console.log('\nBy workspace:')
  for (const [id, v] of byWs) console.log(`  ${v.count.toString().padStart(4)}  ${v.name}  (${id})`)

  // Channels.
  const byCh = new Map<string, number>()
  for (const e of failed) byCh.set(e.channel, (byCh.get(e.channel) ?? 0) + 1)
  console.log('\nBy channel:')
  for (const [ch, n] of byCh) console.log(`  ${ch}: ${n}`)

  // Show the 10 most-recent so we can sanity-check.
  console.log('\nMost-recent 10 failed executions:')
  for (const e of failed.slice(0, 10)) {
    console.log(
      `  ${e.createdAt.toISOString()}  ws="${e.automationRule.workspace.name}"  rule="${e.automationRule.name}"  step="${e.step?.emailTemplate?.subject ?? '(no template)'}"  ch=${e.channel}  sessionId=${e.sessionId}  execId=${e.id}`
    )
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
