/**
 * Dry-run the unified stale-detection sweep against production data.
 *
 * Run BEFORE turning the cron on (or after changing `defaultStalledDays`) to
 * see how many active candidates would flip to `stalled` and which reason
 * each would get. Writes nothing — uses the same `runStaleDetection({ dryRun: true })`
 * the cron handler calls in non-dry mode, so the count matches what would
 * actually happen on the next 04:00 UTC sweep.
 *
 * Usage:
 *   cp .env.prod .env.dryrun && DOTENV_CONFIG_PATH=.env.dryrun \
 *     npx ts-node -r dotenv/config scripts/dry-run-stale-detection.ts
 *
 *   (Or set DATABASE_URL inline for one-off Railway pulls.)
 */

import { runStaleDetection } from '../src/app/api/cron/detect-stalled/route'
import { prisma } from '../src/lib/prisma'
import { STALE_DETECTION_DEFAULT_DAYS } from '../src/lib/candidate-status'

async function main() {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, name: true, defaultStalledDays: true },
  })

  console.log('--- workspace thresholds ---')
  for (const ws of workspaces) {
    const d = ws.defaultStalledDays ?? STALE_DETECTION_DEFAULT_DAYS
    const tag = ws.defaultStalledDays === null ? '(platform default)' : '(workspace override)'
    console.log(`  ${ws.name.padEnd(40)} → ${d} days ${tag}`)
  }

  console.log('\n--- dry-run sweep ---')
  const result = await runStaleDetection({ dryRun: true })

  console.log(`  scanned candidates: ${result.scanned}`)
  console.log(`  would flip to stalled: ${result.stalled}`)
  console.log('\n  reason breakdown:')
  const reasons = Object.entries(result.byReason).filter(([, n]) => n > 0)
  if (reasons.length === 0) {
    console.log('    (no candidates eligible)')
  } else {
    for (const [reason, n] of reasons.sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason.padEnd(36)} ${n}`)
    }
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
