/**
 * Backfill AutomationExecution rows for orphan TrainingAccessTokens whose
 * sourceRefId points at the permanently deleted "Training email after completing
 * form" rule (8e934aa7-f432-4955-b453-76886534b54f).
 *
 * Re-attributes them to the restored rule 2fdd9149-44a3-453d-922b-9240caa7a9be
 * and recreates the missing email-sent execution row keyed on (stepId, sessionId,
 * channel='email', stageEntryId=null).
 *
 * Usage:
 *   tsx scripts/_oneoff/backfill-training-email-executions.ts            # dry-run
 *   tsx scripts/_oneoff/backfill-training-email-executions.ts --commit   # write
 */
import { PrismaClient } from '@prisma/client'

const OLD_RULE_ID = '8e934aa7-f432-4955-b453-76886534b54f'
const NEW_RULE_ID = '2fdd9149-44a3-453d-922b-9240caa7a9be'
const NEW_STEP_ID = '6bb6d6d5-ebf1-49d2-8820-8e2e0d12931a' // order 0, 2-min delay, email

const COMMIT = process.argv.includes('--commit')

const prisma = new PrismaClient()

async function main() {
  const tokens = await prisma.trainingAccessToken.findMany({
    where: { sourceType: 'automation', sourceRefId: OLD_RULE_ID },
    select: {
      id: true,
      candidateId: true,
      trainingId: true,
      createdAt: true,
      usedAt: true,
      status: true,
      candidate: { select: { candidateName: true, candidateEmail: true, workspaceId: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`Found ${tokens.length} orphan tokens pointing at deleted rule ${OLD_RULE_ID}`)

  // Sanity check: new rule + step exist
  const newRule = await prisma.automationRule.findUnique({ where: { id: NEW_RULE_ID }, select: { id: true, name: true, workspaceId: true } })
  const newStep = await prisma.automationStep.findUnique({ where: { id: NEW_STEP_ID }, select: { id: true, ruleId: true } })
  if (!newRule) throw new Error(`New rule ${NEW_RULE_ID} not found`)
  if (!newStep || newStep.ruleId !== NEW_RULE_ID) throw new Error(`New step ${NEW_STEP_ID} missing or wrong rule`)
  console.log(`Target rule: "${newRule.name}" (ws ${newRule.workspaceId})`)
  console.log(`Target step: ${newStep.id}`)
  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY-RUN'}\n`)

  let created = 0
  let skippedExisting = 0
  let tokenUpdated = 0
  let errors = 0

  for (const t of tokens) {
    if (!t.candidateId) continue

    // Idempotency: skip if an execution already exists for (stepId, sessionId, channel='email', stageEntryId=null)
    const existing = await prisma.automationExecution.findFirst({
      where: {
        stepId: NEW_STEP_ID,
        sessionId: t.candidateId,
        channel: 'email',
        stageEntryId: null,
      },
      select: { id: true },
    })

    if (existing) {
      skippedExisting++
    } else {
      if (COMMIT) {
        try {
          await prisma.automationExecution.create({
            data: {
              automationRuleId: NEW_RULE_ID,
              stepId: NEW_STEP_ID,
              sessionId: t.candidateId,
              status: 'sent',
              provider: 'sendgrid',
              channel: 'email',
              sentAt: t.createdAt,
              createdAt: t.createdAt,
              executionMode: 'cron', // backfill marker
            },
          })
          created++
        } catch (err: any) {
          errors++
          console.error(`  ERR creating exec for ${t.candidate?.candidateEmail}:`, err.message)
          continue
        }
      } else {
        created++
      }
    }

    // Re-attribute the token to the new rule so future audits don't see it as orphan
    if (COMMIT) {
      try {
        await prisma.trainingAccessToken.update({
          where: { id: t.id },
          data: { sourceRefId: NEW_RULE_ID },
        })
        tokenUpdated++
      } catch (err: any) {
        errors++
        console.error(`  ERR updating token for ${t.candidate?.candidateEmail}:`, err.message)
      }
    } else {
      tokenUpdated++
    }
  }

  console.log('\nSummary:')
  console.log(`  Tokens processed:       ${tokens.length}`)
  console.log(`  Executions to create:   ${created}`)
  console.log(`  Executions skipped:     ${skippedExisting} (already present)`)
  console.log(`  Tokens to re-attribute: ${tokenUpdated}`)
  console.log(`  Errors:                 ${errors}`)
  if (!COMMIT) console.log('\nDRY-RUN — re-run with --commit to apply.')
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e)
    prisma.$disconnect()
    process.exit(1)
  })
