/**
 * One-off cleanup for the workspace's duplicate EmailTemplate rows.
 *
 * Sequence (workspace = Spotless Homes Florida LLC):
 *   1. Snapshot every row we're going to touch into a JSON file so the
 *      changes are reversible if we're wrong about anything.
 *   2. Re-point the lone rule/step that uses `03a38899 Interview Confirmation`
 *      to use `51f8603e` (the original, bodies are byte-identical).
 *   3. Delete `03a38899` Interview Confirmation duplicate.
 *   4. Delete two of the three orphaned "Next Step" templates (zero refs).
 *   5. Rename `565094ab Training Invitation` → "Training Invitation – 3-day
 *      reminder" so it stops sharing a name with `5c01a73d`.
 *
 * Idempotent: re-running detects an already-clean state and exits with no
 * writes. Stops on first error.
 */
import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'
import * as path from 'path'

const prisma = new PrismaClient()

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'

// Decisions
const INTERVIEW_KEEP = '51f8603e-7b03-4ca7-9d75-3c8fe54aa1ed' // We need to look this up below
const INTERVIEW_DELETE_PREFIX = '03a38899'
const NEXT_STEP_DELETE_PREFIXES = ['23f8c1e7', '22ce2471']
const TRAINING_RENAME_PREFIX = '565094ab'
const TRAINING_NEW_NAME = 'Training Invitation – 3-day reminder'

async function findByPrefix(prefix: string) {
  return prisma.emailTemplate.findFirst({
    where: { workspaceId: WORKSPACE_ID, id: { startsWith: prefix } },
  })
}

async function main() {
  console.log('--- 1. Snapshot ---')
  const allCandidatePrefixes = [
    'INTERVIEW_KEEP_LOOKUP',
    INTERVIEW_DELETE_PREFIX,
    ...NEXT_STEP_DELETE_PREFIXES,
    TRAINING_RENAME_PREFIX,
  ]

  // Resolve the "keep" ID for Interview Confirmation by name + earliest createdAt.
  const interviewConfs = await prisma.emailTemplate.findMany({
    where: { workspaceId: WORKSPACE_ID, name: 'Interview Confirmation' },
    orderBy: { createdAt: 'asc' },
  })
  if (interviewConfs.length === 0) {
    throw new Error('No Interview Confirmation templates found — abort')
  }
  const interviewKeepId = interviewConfs[0].id
  console.log(`  Interview Confirmation keep id = ${interviewKeepId}`)

  // Snapshot every potentially-touched template + every reference.
  const interviewDelete = await findByPrefix(INTERVIEW_DELETE_PREFIX)
  const nextStepDel0 = await findByPrefix(NEXT_STEP_DELETE_PREFIXES[0])
  const nextStepDel1 = await findByPrefix(NEXT_STEP_DELETE_PREFIXES[1])
  const trainingRename = await findByPrefix(TRAINING_RENAME_PREFIX)

  const interviewDeleteRules = interviewDelete
    ? await prisma.automationRule.findMany({ where: { emailTemplateId: interviewDelete.id } })
    : []
  const interviewDeleteSteps = interviewDelete
    ? await prisma.automationStep.findMany({ where: { emailTemplateId: interviewDelete.id } })
    : []

  const snapshot = {
    takenAt: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
    interviewKeep: interviewConfs[0],
    interviewDelete,
    interviewDeleteRules,
    interviewDeleteSteps,
    nextStepDelete: [nextStepDel0, nextStepDel1].filter(Boolean),
    trainingRename,
  }

  const snapshotPath = path.join(
    process.cwd(),
    'scripts',
    '_oneoff',
    `dedupe-email-templates-snapshot-${Date.now()}.json`,
  )
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2))
  console.log(`  Snapshot written: ${snapshotPath}`)

  // -- 2. Re-point Interview Confirmation duplicate's rule/step --------------
  console.log('\n--- 2. Repoint Interview Confirmation duplicate -> original ---')
  if (interviewDelete && interviewDelete.id !== interviewKeepId) {
    const ruleUpdate = await prisma.automationRule.updateMany({
      where: { emailTemplateId: interviewDelete.id },
      data: { emailTemplateId: interviewKeepId },
    })
    const stepUpdate = await prisma.automationStep.updateMany({
      where: { emailTemplateId: interviewDelete.id },
      data: { emailTemplateId: interviewKeepId },
    })
    console.log(`  rules repointed: ${ruleUpdate.count}, steps repointed: ${stepUpdate.count}`)
  } else {
    console.log('  (no duplicate to repoint)')
  }

  // -- 3. Delete the Interview Confirmation duplicate -----------------------
  console.log('\n--- 3. Delete Interview Confirmation duplicate ---')
  if (interviewDelete && interviewDelete.id !== interviewKeepId) {
    await prisma.emailTemplate.delete({ where: { id: interviewDelete.id } })
    console.log(`  deleted ${interviewDelete.id}`)
  } else {
    console.log('  (nothing to delete)')
  }

  // -- 4. Delete unused "Next Step" duplicates ------------------------------
  console.log('\n--- 4. Delete orphan "Next Step" duplicates ---')
  for (const tpl of [nextStepDel0, nextStepDel1]) {
    if (!tpl) continue
    const ruleRefs = await prisma.automationRule.count({ where: { emailTemplateId: tpl.id } })
    const stepRefs = await prisma.automationStep.count({ where: { emailTemplateId: tpl.id } })
    if (ruleRefs > 0 || stepRefs > 0) {
      console.log(`  SKIP ${tpl.id} — has ${ruleRefs} rule refs + ${stepRefs} step refs`)
      continue
    }
    await prisma.emailTemplate.delete({ where: { id: tpl.id } })
    console.log(`  deleted ${tpl.id}`)
  }

  // -- 5. Rename the training reminder template -----------------------------
  console.log('\n--- 5. Rename Training Invitation duplicate ---')
  if (trainingRename && trainingRename.name !== TRAINING_NEW_NAME) {
    await prisma.emailTemplate.update({
      where: { id: trainingRename.id },
      data: { name: TRAINING_NEW_NAME },
    })
    console.log(`  renamed ${trainingRename.id} -> "${TRAINING_NEW_NAME}"`)
  } else {
    console.log('  (already renamed or missing)')
  }

  console.log('\n--- final state ---')
  const remaining = await prisma.emailTemplate.findMany({
    where: { workspaceId: WORKSPACE_ID },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
  console.log(`  Total templates: ${remaining.length}`)
  const byName: Record<string, number> = {}
  for (const t of remaining) byName[t.name] = (byName[t.name] || 0) + 1
  const stillDupes = Object.entries(byName).filter(([, n]) => n > 1)
  if (stillDupes.length === 0) {
    console.log('  Remaining duplicates: 0 ✓')
  } else {
    console.log('  Remaining duplicates:')
    stillDupes.forEach(([n, c]) => console.log(`    "${n}" × ${c}`))
  }

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
