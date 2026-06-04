/**
 * GET /api/cron/detect-stalled
 *
 * Unified inactivity rule. The cron flips `Session.status` from 'active' →
 * 'stalled' when a candidate has not had a real forward-progress event for
 * `Workspace.defaultStalledDays` (fallback: `STALE_DETECTION_DEFAULT_DAYS`,
 * currently 7).
 *
 * Source of inactivity: `Session.lastProgressAt` (initialized on session
 * create, bumped only on real progress events — see
 * `src/lib/session-activity.ts:bumpSessionProgress`). Passive signals like
 * "candidate opened the training landing page" intentionally do NOT bump this
 * column.
 *
 * Reason derivation: we run `deriveStaleReason()` against per-session
 * checkpoint fingerprints (flow finished? training invited? meeting booked?
 * etc.) so the analytics drop-off cards still get the structured breakdown
 * (`training_not_completed`, `scheduling_not_booked`, `interview_no_show`, …)
 * even though the threshold is one number.
 *
 * Idempotent: `WHERE status='active'` guards every write so re-runs leave
 * already-stalled / manually-nurtured / lost / hired candidates alone. A
 * candidate's transition out of `stalled` happens via either a forward-progress
 * event (`applyStageTrigger` reactivates) or a manual recruiter action.
 *
 * Vercel cron schedule: daily 4:00 UTC (after the Calendar/Meet renewals).
 *
 * Sweep logic lives in `./runner.ts` — Next.js App Router restricts this
 * file's exports to HTTP method handlers.
 */

import { NextRequest, NextResponse } from 'next/server'
import { runStaleDetection } from './runner'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await runStaleDetection({ dryRun: false })
  return NextResponse.json({ ok: true, ranAt: new Date().toISOString(), ...result })
}
