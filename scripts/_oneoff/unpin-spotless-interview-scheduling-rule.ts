/**
 * Production config cleanup, 2026-06-03.
 *
 * The "Interview scheduling" automation rule for Spotless Homes Florida LLC
 * was pinned to `stageId='stage_5'` ("Orientation training") with
 * triggerType='training_completed' and delay=2m. That stage has
 * `training_started` as its entry trigger, so the completion-pair runtime
 * (src/lib/funnel-stage-runtime.ts) auto-advances the candidate to the next
 * stage on `training_completed` — i.e. before the 2m delayed callback
 * fires. The delayed callback's stage gate then sees pipelineStatus=stage_7
 * (Interview scheduled) and skips with skipped_wrong_stage.
 *
 * The triggerStageSnapshot fix in src/lib/automation-guard.ts now carves out
 * this case for callbacks queued AFTER the deploy, but the pinned stage is
 * still semantically wrong (the rule should fire after training, regardless
 * of which stage the candidate sits at). Unpin so it works on every
 * candidate going forward, not just those whose dispatch went through the
 * patched code path.
 *
 * Run:
 *   set -a && source .env.prod && set +a && npx tsx scripts/_oneoff/unpin-spotless-interview-scheduling-rule.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const RULE_ID = '6c9c973e-3d0a-4b22-bc58-93c2830b853c'

async function main() {
  const before = await prisma.automationRule.findUnique({
    where: { id: RULE_ID },
    select: { id: true, name: true, workspaceId: true, triggerType: true, stageId: true, isActive: true },
  })
  if (!before) {
    console.error(`Rule ${RULE_ID} not found.`)
    process.exit(1)
  }
  console.log('Before:', JSON.stringify(before, null, 2))

  if (before.stageId === null) {
    console.log('Rule already unpinned (stageId=null) — no change.')
    return
  }

  const after = await prisma.automationRule.update({
    where: { id: RULE_ID },
    data: { stageId: null },
    select: { id: true, name: true, stageId: true },
  })
  console.log('After:', JSON.stringify(after, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
}).finally(() => prisma.$disconnect())
