/**
 * Poll a single McSimulation, reconciling against MC's authoritative
 * status endpoint when the row is still non-terminal AND has an
 * mcCallId. This is the "webhook is late/dropped" recovery path.
 *
 * Reconciliation flow:
 *   1. Load HF's shadow row (workspace-scoped).
 *   2. If it's already terminal — return as-is; skip MC round-trip.
 *   3. Else if `mcCallId` is set — GET MC's /call/:callId, then apply
 *      the returned status through `applyMcSimulationState` (SAME
 *      forward-only helper the webhook receiver uses).
 *   4. Else (`mcCallId` is null — dial hasn't returned yet) — return
 *      the row as-is. The dial handshake should complete within a
 *      few seconds; if it doesn't, HF's UI keeps polling and the
 *      answer will settle when either the dial response lands OR the
 *      webhook receiver sees an event with `clientReferenceId=row.id`.
 *
 * Merely re-reading the shadow row is NOT sufficient — we must reach
 * MC to catch a webhook drop. The applyMcSimulationState call is
 * forward-only + idempotent so this is safe to hammer.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { resolveMcMapping } from '@/lib/mockcustomer/mapping'
import { buildMcClientConfig, mcGetCallStatus, McApiError } from '@/lib/mockcustomer/client'
import { applyMcWireStatus } from '@/lib/mockcustomer/apply-simulation-state'
import { isTerminalMcStatus } from '@/lib/mockcustomer/status-ladder'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string; simulationId: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  // Candidate scoping (defensive — a URL forge attempt must 404 here
  // before any MC round-trip, so we don't leak that a simulationId
  // exists in another workspace).
  const candidate = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!candidate) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })

  const sim = await prisma.mcSimulation.findFirst({
    where: {
      id: params.simulationId,
      workspaceId: ws.workspaceId,
      candidateId: params.id,
    },
  })
  if (!sim) return NextResponse.json({ error: 'Simulation not found' }, { status: 404 })

  // Reconciliation gate. Terminal → nothing to reconcile. No mcCallId
  // yet → dial response hasn't landed; nothing to fetch from MC.
  if (!isTerminalMcStatus(sim.status) && sim.mcCallId) {
    const mapping = await resolveMcMapping(prisma, ws.workspaceId)
    if (mapping.ok) {
      try {
        const cfg = buildMcClientConfig({ apiKey: mapping.mapping.mcApiKey })
        const mcRow = await mcGetCallStatus(cfg, sim.mcCallId)
        // Applies through the SAME forward-only helper the webhook
        // receiver uses — a duplicate advance is a no-op.
        await applyMcWireStatus(prisma, {
          simulationId: sim.id,
          wireStatus: mcRow.status,
          mcCallId: mcRow.callId,
          ringingAt: mcRow.ringingAt ? new Date(mcRow.ringingAt) : undefined,
          answeredAt: mcRow.answeredAt ? new Date(mcRow.answeredAt) : undefined,
          completedAt: mcRow.completedAt ? new Date(mcRow.completedAt) : undefined,
          failedAt: mcRow.failedAt ? new Date(mcRow.failedAt) : undefined,
          failureReason: mcRow.failureReason ?? undefined,
          // Poll path doesn't have a MC `result` block — that only
          // lands on the terminal webhook. We deliberately don't
          // fabricate one here; the projection stays null until the
          // real terminal event arrives.
        })
      } catch (err) {
        // Reconciliation failures are non-fatal: we still return the
        // shadow row. Loud-log so a persistent MC outage is visible.
        if (err instanceof McApiError) {
          console.warn(
            '[mc-simulations poll] MC status fetch failed',
            { simulationId: sim.id, status: err.status, body: err.body },
          )
        } else {
          console.warn('[mc-simulations poll] MC status fetch error', {
            simulationId: sim.id,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
  }

  // Re-read after (possible) reconciliation.
  const fresh = await prisma.mcSimulation.findUnique({
    where: { id: sim.id },
    select: {
      id: true,
      mcCallId: true,
      mcOrganizationId: true,
      status: true,
      resultProjection: true,
      queuedAt: true,
      ringingAt: true,
      answeredAt: true,
      completedAt: true,
      failedAt: true,
      failureReason: true,
      createdAt: true,
    },
  })
  return NextResponse.json({ simulation: fresh })
}
