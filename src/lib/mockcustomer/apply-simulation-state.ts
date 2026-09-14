/**
 * Forward-only state application for McSimulation.
 *
 * Called from TWO different code paths that must agree on state
 * transitions:
 *   1. `POST /api/webhooks/mockcustomer` — MC pushes an event.
 *   2. `GET /api/candidates/[id]/mc-simulations/:id` — polling
 *      reconciliation reads MC's authoritative status endpoint and
 *      applies it through the same helper.
 *
 * Sharing this helper is load-bearing: if polling and webhook paths
 * ever disagreed on ladder semantics, a slow-webhook race would
 * produce inconsistent local state.
 *
 * Rules:
 *   - Only forward transitions per the ladder in `status-ladder.ts`.
 *   - Terminal statuses are absorbing.
 *   - Never fabricate result fields; if the caller has a partial
 *     `result` blob, pass it through as-is and let readers see the
 *     nulls.
 */

import type { PrismaClient } from '@prisma/client'
import {
  isForwardMcTransition,
  isTerminalMcStatus,
  type McSimulationStatus,
  normalizeWireStatus,
} from './status-ladder'
import type { McWebhookResult } from './webhook-types'

export interface ApplySimulationStateInput {
  simulationId: string
  toStatus: McSimulationStatus
  mcCallId?: string | null
  ringingAt?: Date | null
  answeredAt?: Date | null
  completedAt?: Date | null
  failedAt?: Date | null
  failureReason?: string | null
  /**
   * Terminal-event `result` block. Copied verbatim into
   * McSimulation.resultProjection when the row is transitioning to
   * a terminal status. Never fabricated by the caller.
   */
  result?: McWebhookResult
}

export type ApplyResult =
  | { applied: true; newStatus: McSimulationStatus }
  | { applied: false; reason: 'row_not_found' | 'no_change' | 'regressive' | 'terminal' }

/**
 * Apply a forward transition inside the given Prisma tx client (or the
 * top-level client when the caller doesn't need to compose with other
 * writes). Returns `{applied: false}` on all non-advance cases so
 * callers can distinguish idempotent no-ops from silent errors.
 *
 * Uses `updateMany` with a `WHERE status IN (allowed pre-terminal)`
 * clause so two racing writes (webhook + polling reconciliation
 * arriving within milliseconds) cannot both apply the transition —
 * only the first one to reach the DB wins, the second sees `count=0`
 * and reports `no_change`.
 */
export async function applyMcSimulationState(
  prisma: Pick<PrismaClient, 'mcSimulation'>,
  input: ApplySimulationStateInput,
): Promise<ApplyResult> {
  const current = await prisma.mcSimulation.findUnique({
    where: { id: input.simulationId },
    select: { id: true, status: true },
  })
  if (!current) return { applied: false, reason: 'row_not_found' }
  const currentStatus = current.status as McSimulationStatus
  if (currentStatus === input.toStatus) {
    // Still write metadata that may have shown up out-of-order (e.g.
    // mcCallId landing on a later event when the first race-lost it).
    // But status is unchanged.
    if (input.mcCallId) {
      await prisma.mcSimulation.updateMany({
        where: { id: input.simulationId, mcCallId: null },
        data: { mcCallId: input.mcCallId },
      })
    }
    return { applied: false, reason: 'no_change' }
  }
  if (isTerminalMcStatus(currentStatus)) {
    return { applied: false, reason: 'terminal' }
  }
  if (!isForwardMcTransition(currentStatus, input.toStatus)) {
    return { applied: false, reason: 'regressive' }
  }

  // Atomic conditional advance — only succeeds if the row is still in a
  // pre-terminal status. If a concurrent path already advanced it, this
  // updateMany matches zero rows and we treat it as no_change.
  const allowedPreTerminals: McSimulationStatus[] = ['queued', 'ringing', 'in_progress']
  const result = await prisma.mcSimulation.updateMany({
    where: {
      id: input.simulationId,
      status: { in: allowedPreTerminals },
    },
    data: {
      status: input.toStatus,
      // Only stamp lifecycle timestamps that were provided AND aren't
      // already set — we don't fabricate.
      ...(input.ringingAt !== undefined && input.ringingAt !== null
        ? { ringingAt: input.ringingAt }
        : {}),
      ...(input.answeredAt !== undefined && input.answeredAt !== null
        ? { answeredAt: input.answeredAt }
        : {}),
      ...(input.completedAt !== undefined && input.completedAt !== null
        ? { completedAt: input.completedAt }
        : {}),
      ...(input.failedAt !== undefined && input.failedAt !== null
        ? { failedAt: input.failedAt }
        : {}),
      ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
      ...(input.mcCallId ? { mcCallId: input.mcCallId } : {}),
      ...(input.result !== undefined && isTerminalMcStatus(input.toStatus)
        ? { resultProjection: input.result as unknown as object }
        : {}),
    },
  })
  if (result.count === 0) {
    // Someone else won the race. Not an error — the invariant holds.
    return { applied: false, reason: 'no_change' }
  }
  return { applied: true, newStatus: input.toStatus }
}

/** Convenience: applyMcSimulationState after normalizing wire status. */
export async function applyMcWireStatus(
  prisma: Pick<PrismaClient, 'mcSimulation'>,
  args: Omit<ApplySimulationStateInput, 'toStatus'> & { wireStatus: string },
): Promise<ApplyResult> {
  const to = normalizeWireStatus(args.wireStatus)
  if (!to) return { applied: false, reason: 'regressive' }
  return applyMcSimulationState(prisma, { ...args, toStatus: to })
}
