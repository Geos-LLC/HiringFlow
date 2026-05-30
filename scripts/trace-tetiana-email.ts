/**
 * Diagnose: why didn't Tetiana (tetianakarpova58@gmail.com / +19542269620,
 * flow "Application Form") receive the email she expected?
 *
 * Walks: session(s) → workspace sender config → AutomationExecution history
 * (all statuses incl. skipped_*, errored) → rules in the workspace that
 * target an `application_form_*` trigger, so we can see if a rule existed
 * but never fired (or fired but was skipped/errored).
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const EMAIL = 'tetianakarpova58@gmail.com'
const PHONE = '+19542269620'

async function main() {
  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { candidateEmail: { equals: EMAIL, mode: 'insensitive' } },
        { candidatePhone: PHONE },
      ],
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, workspaceId: true, flowId: true,
      candidateName: true, candidateEmail: true, candidatePhone: true,
      pipelineStatus: true, status: true, dispositionReason: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
      flow: { select: { id: true, name: true, slug: true } },
    },
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Sessions matching ${EMAIL} OR ${PHONE}: ${sessions.length}\n`)

  if (!sessions.length) { await prisma.$disconnect(); return }

  for (const s of sessions) {
    console.log('='.repeat(80))
    console.log(`Session ${s.id}`)
    console.log(`  ${s.candidateName} <${s.candidateEmail}>  phone=${s.candidatePhone ?? '-'}`)
    console.log(`  flow="${s.flow?.name}" (slug=${s.flow?.slug})  workspaceId=${s.workspaceId}`)
    console.log(`  pipelineStatus=${s.pipelineStatus}  status=${s.status}  disposition=${s.dispositionReason ?? '-'}`)
    console.log(`  startedAt=${s.startedAt.toISOString()}  finishedAt=${s.finishedAt?.toISOString() ?? '-'}  lastActivity=${s.lastActivityAt?.toISOString() ?? '-'}`)
  }

  // Workspace sender config — if senderEmail/senderDomain is broken, NOTHING goes out
  const wsIds = Array.from(new Set(sessions.map(s => s.workspaceId)))
  for (const wsId of wsIds) {
    const ws = await prisma.workspace.findUnique({
      where: { id: wsId },
      select: {
        id: true, name: true,
        senderEmail: true, senderName: true, senderDomain: true,
        senderVerifiedAt: true, senderDomainValidatedAt: true,
        settings: true,
      },
    })
    console.log('\n' + '='.repeat(80))
    console.log(`Workspace ${ws?.name} (${wsId})`)
    const settings = (ws?.settings ?? {}) as Record<string, unknown>
    console.log(`  automationHalted   = ${(settings as any).automationHalted ?? '-'}  haltedAt=${(settings as any).automationHaltedAt ?? '-'}  reason=${(settings as any).automationHaltedReason ?? '-'}`)
    console.log(`  senderEmail        = ${ws?.senderEmail}`)
    console.log(`  senderName         = ${ws?.senderName}`)
    console.log(`  senderDomain       = ${ws?.senderDomain}`)
    console.log(`  senderVerifiedAt   = ${ws?.senderVerifiedAt?.toISOString() ?? '-'}`)
    console.log(`  domainValidatedAt  = ${ws?.senderDomainValidatedAt?.toISOString() ?? '-'}`)
  }

  const sessionIds = sessions.map(s => s.id)

  // ALL automation executions — including skipped_* and errored — to see WHY
  const execs = await prisma.automationExecution.findMany({
    where: { sessionId: { in: sessionIds } },
    orderBy: { createdAt: 'asc' },
    include: {
      step: {
        select: {
          id: true, order: true, channel: true, delayMinutes: true,
          emailDestination: true, emailDestinationAddress: true,
          emailTemplate: { select: { name: true, subject: true } },
          smsBody: true,
        },
      },
      automationRule: { select: { id: true, name: true, triggerType: true, isActive: true } },
    },
  })

  console.log('\n' + '='.repeat(80))
  console.log(`AutomationExecutions for these sessions: ${execs.length}\n`)
  for (const e of execs) {
    const r = e.automationRule
    const st = e.step
    const tmpl = st?.channel === 'email'
      ? (st?.emailTemplate?.name ?? '-')
      : `sms[${(st?.smsBody ?? '').slice(0, 60)}]`
    console.log(`  ${e.createdAt.toISOString()}  rule="${r?.name}" trig=${r?.triggerType} active=${r?.isActive}`)
    console.log(`    step.order=${st?.order} ch=${e.channel} dest=${st?.emailDestination ?? '-'} tmpl="${tmpl}"`)
    console.log(`    status=${e.status}  skipReason=${(e as any).skipReason ?? '-'}  err=${e.errorMessage ?? '-'}`)
    console.log(`    msgId=${e.providerMessageId ?? '-'}  sentAt=${e.sentAt?.toISOString() ?? '-'}`)
  }

  // Rules in the workspace whose triggerType is application-form related,
  // so we know what *should* have fired
  const rules = await prisma.automationRule.findMany({
    where: { workspaceId: { in: wsIds } },
    select: {
      id: true, name: true, triggerType: true, isActive: true,
      flowId: true, allowedForStatuses: true,
      steps: {
        orderBy: { order: 'asc' },
        select: {
          id: true, order: true, channel: true, delayMinutes: true,
          emailDestination: true,
          emailTemplate: { select: { name: true, subject: true } },
          smsBody: true,
        },
      },
    },
    orderBy: { name: 'asc' },
  })

  const flowId = sessions[0]?.flowId
  const relevant = rules.filter(r =>
    /application|form_submit|session_started|stage_application/i.test(r.triggerType) ||
    (r.flowId && r.flowId === flowId)
  )

  console.log('\n' + '='.repeat(80))
  console.log(`Rules in workspace that could fire on "Application Form": ${relevant.length}\n`)
  for (const r of relevant) {
    console.log(`  rule="${r.name}" trig=${r.triggerType} active=${r.isActive} flowId=${r.flowId ?? 'ANY'}`)
    for (const st of r.steps) {
      const tmpl = st.channel === 'email'
        ? (st.emailTemplate?.name ?? '-')
        : `sms[${(st.smsBody ?? '').slice(0, 60)}]`
      console.log(`    step ${st.order}  ch=${st.channel}  delay=${st.delayMinutes}m  dest=${st.emailDestination ?? '-'}  tmpl="${tmpl}"`)
    }
  }

  console.log(`\nTotal rules in workspace: ${rules.length} (active=${rules.filter(r => r.isActive).length})`)

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
