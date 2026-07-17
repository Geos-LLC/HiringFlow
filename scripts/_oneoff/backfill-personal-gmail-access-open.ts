/**
 * Backfill: personal-Gmail workspaces — flip existing InterviewMeeting Meet
 * spaces from TRUSTED to OPEN so assigned team-member hosts can enter and
 * run the interview without the workspace owner joining first.
 *
 * Companion to the 2026-07-17 book-interview.ts change that switched the
 * default for NEW bookings to OPEN. Existing spaces already booked TRUSTED
 * still gate on the owner — this script patches them.
 *
 * Scope:
 *   - workspaces whose GoogleIntegration has hostedDomain=null (personal Gmail)
 *   - InterviewMeeting rows with scheduledStart > now, cancelledAt=null,
 *     actualStart=null (space.config.accessType is mutable until the first
 *     participant joins the conference; already-started meetings are frozen)
 *
 * Idempotent — running twice is safe (updateSpaceSettings just sets accessType
 * to OPEN again).
 *
 * Run:
 *   DATABASE_URL=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
 *     npx tsx scripts/_oneoff/backfill-personal-gmail-access-open.ts [--dry-run]
 */

import { prisma } from '@/lib/prisma'
import { getAuthedClientForWorkspace } from '@/lib/google'
import { updateSpaceSettings, MeetApiError } from '@/lib/meet/google-meet'

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const now = new Date()

  const integrations = await prisma.googleIntegration.findMany({
    where: { hostedDomain: null },
    select: { workspaceId: true, googleEmail: true },
  })

  console.log(`[backfill] personal-Gmail workspaces: ${integrations.length}`)
  for (const gi of integrations) {
    console.log(`  - ${gi.googleEmail} (${gi.workspaceId})`)
  }

  let totalPatched = 0
  let totalSkipped = 0
  let totalFailed = 0

  for (const gi of integrations) {
    const meetings = await prisma.interviewMeeting.findMany({
      where: {
        workspaceId: gi.workspaceId,
        cancelledAt: null,
        actualStart: null,
        scheduledStart: { gt: now },
      },
      select: {
        id: true,
        meetSpaceName: true,
        scheduledStart: true,
        session: { select: { candidateName: true, candidateEmail: true } },
      },
      orderBy: { scheduledStart: 'asc' },
    })

    if (meetings.length === 0) {
      console.log(`\n[${gi.googleEmail}] no eligible meetings`)
      continue
    }

    console.log(`\n[${gi.googleEmail}] ${meetings.length} eligible meeting(s):`)
    for (const m of meetings) {
      console.log(`  - ${m.scheduledStart.toISOString()} · ${m.session.candidateName} <${m.session.candidateEmail}> · ${m.meetSpaceName}`)
    }

    if (dryRun) {
      console.log(`  (dry-run — skipping patches)`)
      continue
    }

    const authed = await getAuthedClientForWorkspace(gi.workspaceId)
    if (!authed) {
      console.warn(`  ! no auth client for ${gi.workspaceId} — skipping`)
      totalSkipped += meetings.length
      continue
    }

    for (const m of meetings) {
      try {
        await updateSpaceSettings(authed.client, m.meetSpaceName, { accessType: 'OPEN' })
        console.log(`  ✓ ${m.id} → OPEN`)
        totalPatched++
      } catch (err) {
        const msg = err instanceof MeetApiError ? `${err.status} ${err.message}` : (err as Error).message
        console.warn(`  ! ${m.id} failed: ${msg}`)
        totalFailed++
      }
    }
  }

  console.log(`\n[backfill] done. patched=${totalPatched} skipped=${totalSkipped} failed=${totalFailed}${dryRun ? ' (dry-run)' : ''}`)
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
