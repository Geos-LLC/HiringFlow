/**
 * Backfill — convert legacy Pipeline.stages[].triggers[] into V2
 * PipelineTransitionRule rows.
 *
 * For each stage with embedded triggers, synthesize one rule per trigger:
 *   - toStageId    = stage.id              (V1 trigger meant "land here")
 *   - eventType    = trigger.event
 *   - targetId     = trigger.targetId ?? null
 *   - fromStageId  = null                  (V1 had no "from" concept)
 *   - priority     = stage.order           (deterministic ordering)
 *   - allowBackward= false                 (preserve V1 furthest-wins)
 *   - enabled      = true
 *
 * Idempotent: skips any rule whose (pipelineId, toStageId, eventType,
 * targetId, fromStageId) tuple already exists. Re-runs are no-ops.
 *
 * Modes (mutually exclusive aside from --enable-v2):
 *   default      dry-run: prints plan, no writes.
 *   --apply      create rules; V2 stays off unless --enable-v2 also passed.
 *   --apply --enable-v2
 *                same as --apply, then flip Pipeline.transitionsV2Enabled=true
 *                ONLY for pipelines where the post-state has at least one rule.
 *
 * Filters (at least one required for --apply unless --all):
 *   --workspace=<id>
 *   --pipeline=<id>
 *   --all                  required to apply without a filter (safety)
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts
 *   DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts --workspace=... --apply
 *   DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts --pipeline=... --apply --enable-v2
 *   DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts --all --apply
 */
import { PrismaClient } from '@prisma/client'
import { normalizeStages, type StageTriggerEvent } from '../src/lib/funnel-stages'

interface Args {
  apply: boolean
  enableV2: boolean
  all: boolean
  workspaceId: string | null
  pipelineId: string | null
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    apply: false,
    enableV2: false,
    all: false,
    workspaceId: null,
    pipelineId: null,
  }
  for (const a of argv) {
    if (a === '--apply') out.apply = true
    else if (a === '--enable-v2') out.enableV2 = true
    else if (a === '--all') out.all = true
    else if (a === '--dry-run') out.apply = false  // explicit; same as default
    else if (a.startsWith('--workspace=')) out.workspaceId = a.slice('--workspace='.length)
    else if (a.startsWith('--pipeline=')) out.pipelineId = a.slice('--pipeline='.length)
    else if (a === '-h' || a === '--help') {
      console.log(HELP)
      process.exit(0)
    } else {
      console.error(`Unknown arg: ${a}`)
      console.error(HELP)
      process.exit(2)
    }
  }
  return out
}

const HELP = `Backfill V2 PipelineTransitionRule rows from legacy stage triggers.

Modes:
  (default)                  Dry-run. Print plan, no writes.
  --apply                    Create rules; leaves transitionsV2Enabled untouched.
  --apply --enable-v2        Also flip Pipeline.transitionsV2Enabled=true for
                             pipelines that end up with >=1 rule.

Filters:
  --workspace=<id>           Scope to one workspace.
  --pipeline=<id>            Scope to one pipeline.
  --all                      Required to run --apply without a workspace or pipeline filter.

Flags:
  --dry-run                  Explicit dry-run (same as default).
  -h, --help                 Print this help.
`

// Allowlist mirror of StageTriggerEvent. We skip any V1 trigger whose event
// isn't in the allowed set — a typoed or removed event would otherwise
// produce a rule that can never fire.
const ALLOWED_EVENTS = new Set<StageTriggerEvent>([
  'flow_passed', 'flow_completed',
  'training_started', 'training_completed',
  'meeting_scheduled', 'meeting_rescheduled', 'meeting_confirmed', 'meeting_cancelled',
  'meeting_started', 'meeting_ended', 'meeting_no_show',
  'recording_ready', 'transcript_ready',
  'background_check_passed', 'background_check_failed', 'background_check_needs_review',
])

async function main() {
  const args = parseArgs(process.argv.slice(2))

  // Safety: --apply with no filter must be explicit via --all.
  if (args.apply && !args.workspaceId && !args.pipelineId && !args.all) {
    console.error('Refusing global --apply without a filter. Pass --workspace=<id>, --pipeline=<id>, or --all.')
    process.exit(2)
  }

  const prisma = new PrismaClient()
  try {
    // Resolve target pipelines based on the filter combo.
    const pipelines = await prisma.pipeline.findMany({
      where: {
        ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
        ...(args.pipelineId ? { id: args.pipelineId } : {}),
      },
      select: {
        id: true, workspaceId: true, name: true,
        stages: true, transitionsV2Enabled: true,
        workspace: { select: { name: true } },
      },
      orderBy: [{ workspaceId: 'asc' }, { createdAt: 'asc' }],
    })

    console.log(`Scanning ${pipelines.length} pipeline${pipelines.length === 1 ? '' : 's'}${args.apply ? ' (apply mode)' : ' (dry-run)'}…\n`)

    let totalTriggersScanned = 0
    let totalRulesPlanned = 0
    let totalRulesCreated = 0
    let totalRulesSkippedExisting = 0
    let totalRulesSkippedBadEvent = 0
    const pipelinesWithRules = new Set<string>()
    let pipelinesV2Enabled = 0

    for (const p of pipelines) {
      const stages = normalizeStages(p.stages)
      const planned: Array<{
        toStageId: string
        eventType: string
        targetId: string | null
        fromStageId: string | null
        priority: number
        stageLabel: string
      }> = []

      for (const stage of stages) {
        const triggers = stage.triggers ?? []
        for (const t of triggers) {
          totalTriggersScanned++
          if (!ALLOWED_EVENTS.has(t.event)) {
            totalRulesSkippedBadEvent++
            console.warn(`  ! ${p.workspace.name}/${p.name}: stage "${stage.label}" has unknown event "${t.event}" — skipped`)
            continue
          }
          planned.push({
            toStageId: stage.id,
            eventType: t.event,
            targetId: t.targetId ?? null,
            fromStageId: null,
            priority: stage.order,
            stageLabel: stage.label,
          })
        }
      }
      totalRulesPlanned += planned.length

      if (planned.length === 0) {
        console.log(`  ${p.workspace.name}/${p.name} — no V1 triggers, nothing to backfill`)
        continue
      }

      // Per-pipeline header
      console.log(`  ${p.workspace.name}/${p.name} (pipeline=${p.id}) — ${planned.length} candidate rule(s)`)

      // Existing rules for idempotency comparison.
      const existing = await prisma.pipelineTransitionRule.findMany({
        where: { pipelineId: p.id },
        select: { toStageId: true, eventType: true, targetId: true, fromStageId: true },
      })
      const existingKey = new Set(
        existing.map((r) => `${r.toStageId}|${r.eventType}|${r.targetId ?? ''}|${r.fromStageId ?? ''}`),
      )

      let createdThisPipeline = 0
      for (const item of planned) {
        const k = `${item.toStageId}|${item.eventType}|${item.targetId ?? ''}|${item.fromStageId ?? ''}`
        if (existingKey.has(k)) {
          totalRulesSkippedExisting++
          console.log(`    = SKIP (exists): "${item.stageLabel}" ← ${item.eventType}${item.targetId ? ` target=${item.targetId.slice(0, 8)}` : ''}`)
          continue
        }
        if (args.apply) {
          await prisma.pipelineTransitionRule.create({
            data: {
              workspaceId: p.workspaceId,
              pipelineId: p.id,
              toStageId: item.toStageId,
              eventType: item.eventType,
              targetId: item.targetId,
              fromStageId: item.fromStageId,
              priority: item.priority,
              allowBackward: false,
              enabled: true,
            },
          })
          totalRulesCreated++
          createdThisPipeline++
          console.log(`    + CREATE: "${item.stageLabel}" ← ${item.eventType}${item.targetId ? ` target=${item.targetId.slice(0, 8)}` : ''} priority=${item.priority}`)
        } else {
          console.log(`    + PLAN:   "${item.stageLabel}" ← ${item.eventType}${item.targetId ? ` target=${item.targetId.slice(0, 8)}` : ''} priority=${item.priority}`)
        }
      }

      // Track pipelines that end up with rules. Under --apply this is
      // "created OR already existed"; under dry-run, count what WOULD end up
      // having rules (planned OR existing) so the summary previews accurately.
      const postRunHasRules = args.apply
        ? (createdThisPipeline > 0 || existing.length > 0)
        : (planned.length > 0 || existing.length > 0)
      if (postRunHasRules) pipelinesWithRules.add(p.id)

      // --enable-v2 flips per-pipeline only after at least one rule exists
      // for that pipeline, and only under --apply.
      if (args.apply && args.enableV2 && postRunHasRules && !p.transitionsV2Enabled) {
        await prisma.pipeline.update({
          where: { id: p.id },
          data: { transitionsV2Enabled: true },
        })
        pipelinesV2Enabled++
        console.log(`    * ENABLED V2: pipeline "${p.name}" (transitionsV2Enabled → true)`)
      }
    }

    // ── Summary ────────────────────────────────────────────────────────────
    console.log(`\nSummary (${args.apply ? 'apply' : 'dry-run'})`)
    console.log(`  pipelines scanned:            ${pipelines.length}`)
    console.log(`  V1 triggers found:            ${totalTriggersScanned}`)
    console.log(`  rules planned/created:        ${args.apply ? totalRulesCreated : totalRulesPlanned}`)
    if (args.apply) console.log(`  rules planned but not new:    ${totalRulesPlanned - totalRulesCreated}`)
    console.log(`  rules skipped (already exist): ${totalRulesSkippedExisting}`)
    if (totalRulesSkippedBadEvent > 0) {
      console.log(`  rules skipped (unknown event): ${totalRulesSkippedBadEvent}`)
    }
    console.log(`  pipelines now with rules:     ${pipelinesWithRules.size}`)
    if (args.enableV2) {
      console.log(`  pipelines V2-enabled this run: ${pipelinesV2Enabled}`)
    }
    if (!args.apply) {
      console.log(`\n(dry-run — no writes. Re-run with --apply to commit. Add --enable-v2 to also flip Pipeline.transitionsV2Enabled.)`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
