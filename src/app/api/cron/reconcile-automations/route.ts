/**
 * GET /api/cron/reconcile-automations
 *
 * Safety net for the lifecycle middleware in `src/lib/lifecycle-middleware.ts`.
 *
 * The middleware fires automation events synchronously on every Prisma write
 * to a tracked field — that covers ~99% of cases. But:
 *   - A write inside a transaction that rolls back after `$use` runs would
 *     fire the event for state that no longer exists in the DB.
 *   - A raw SQL write or a write from a Prisma client without the middleware
 *     attached would bypass the firing entirely.
 *   - A redeploy mid-request can drop in-flight fire-and-forget dispatches.
 *
 * This cron scans the last 24h for state transitions whose matching event
 * left no observable trace (no AutomationExecution row, no auto:* audit row)
 * and replays the event. The central guard's idempotency means even if a
 * stale notification later lands, the dup is silently dropped.
 *
 * Intentionally narrow: only the two transitions we've actually seen drop
 * events in production (flow_completed and recording_ready). Extending to
 * training_completed / meeting_ended is a one-liner each — add them when a
 * gap surfaces.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  fireAutomations,
  fireFlowRecordingReadyAutomations,
} from '@/lib/automation'

interface SweepCounts {
  scanned: { sessionsFinished: number; capturesProcessed: number }
  fired: { flowCompleted: number; recordingReady: number }
  errors: number
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const counts: SweepCounts = {
    scanned: { sessionsFinished: 0, capturesProcessed: 0 },
    fired: { flowCompleted: 0, recordingReady: 0 },
    errors: 0,
  }

  // -- Rule 1: Session.finishedAt set but no auto:flow_completed audit -----
  //
  // PipelineStatusChange is the canonical "this event was dispatched"
  // signal — fireAutomations() always calls applyStageTrigger() which
  // writes either the matched-stage row or a legacyFallback row. If
  // neither exists for the session, the firing path never executed.
  const finishedSessions = await prisma.session.findMany({
    where: {
      finishedAt: { gte: cutoff, not: null },
    },
    select: { id: true, outcome: true },
  })
  counts.scanned.sessionsFinished = finishedSessions.length

  if (finishedSessions.length > 0) {
    const audited = await prisma.pipelineStatusChange.findMany({
      where: {
        sessionId: { in: finishedSessions.map((s) => s.id) },
        source: { in: ['auto:flow_completed', 'auto:flow_passed'] },
      },
      select: { sessionId: true },
    })
    const auditedSet = new Set(audited.map((a) => a.sessionId))

    for (const s of finishedSessions) {
      if (auditedSet.has(s.id)) continue
      try {
        await fireAutomations(s.id, s.outcome ?? 'completed', { executionMode: 'cron' })
        counts.fired.flowCompleted++
      } catch (err) {
        counts.errors++
        console.error('[reconcile-automations] fireAutomations failed', { sessionId: s.id, err })
      }
    }
  }

  // -- Rule 2: CaptureResponse processed but no recording_ready execution --
  //
  // CaptureResponse rows don't write a PipelineStatusChange audit (the
  // recording_ready path applies the stage trigger only when wired). The
  // observable signal is an AutomationExecution row with the matching
  // triggerType — its existence proves dispatchRulesForTrigger was reached
  // for this session. If no execution exists AND there is at least one
  // active rule that would match, the firing must have been dropped.
  const processedCaps = await prisma.captureResponse.findMany({
    where: {
      status: 'processed',
      createdAt: { gte: cutoff },
    },
    select: { id: true, sessionId: true, workspaceId: true },
  })
  counts.scanned.capturesProcessed = processedCaps.length

  for (const cap of processedCaps) {
    try {
      // Cheap pre-check: any AutomationExecution with the recording_ready
      // triggerType for this session? If yes, the firing succeeded.
      const existing = await prisma.automationExecution.findFirst({
        where: {
          sessionId: cap.sessionId,
          automationRule: { triggerType: 'recording_ready' },
        },
        select: { id: true },
      })
      if (existing) continue

      // Second filter: is there any active rule that COULD have matched?
      // Without this, we'd re-fire every cron run for workspaces that
      // simply have no recording_ready rule wired.
      const eligible = await prisma.automationRule.findFirst({
        where: {
          workspaceId: cap.workspaceId,
          isActive: true,
          triggerType: 'recording_ready',
        },
        select: { id: true },
      })
      if (!eligible) continue

      await fireFlowRecordingReadyAutomations(cap.sessionId, { executionMode: 'cron' })
      counts.fired.recordingReady++
    } catch (err) {
      counts.errors++
      console.error('[reconcile-automations] fireFlowRecordingReadyAutomations failed', { captureId: cap.id, err })
    }
  }

  return NextResponse.json(counts)
}
