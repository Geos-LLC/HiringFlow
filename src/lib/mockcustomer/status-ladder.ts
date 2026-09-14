/**
 * Forward-only status ladder for McSimulation. Mirrors MC's ExternalCall
 * ladder byte-for-byte so an event MC emits maps cleanly onto our local
 * projection.
 *
 *   queued → ringing → in_progress → { completed | failed | cancelled }
 *
 * Terminal statuses are absorbing — once a McSimulation reaches
 * completed, failed, or cancelled, no further state changes are allowed.
 * The webhook receiver applies this check inside the same DB transaction
 * that records the McWebhookEvent, so out-of-order or regressive events
 * from MC's retry queue are absorbed without visible effect.
 */

export type McSimulationStatus =
  | 'queued'
  | 'ringing'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const MC_STATUS_RANK: Record<McSimulationStatus, number> = {
  queued: 0,
  ringing: 1,
  in_progress: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
}

const TERMINAL: ReadonlySet<McSimulationStatus> = new Set<McSimulationStatus>([
  'completed',
  'failed',
  'cancelled',
])

export function isTerminalMcStatus(status: string): boolean {
  return TERMINAL.has(status as McSimulationStatus)
}

/**
 * Wire-form status strings MC sends. MC emits `in-progress` (kebab) on the
 * wire but internal DB values use underscore. Normalize on the way in.
 */
export function normalizeWireStatus(wire: string): McSimulationStatus | null {
  const s = wire === 'in-progress' ? 'in_progress' : wire
  if (
    s === 'queued' ||
    s === 'ringing' ||
    s === 'in_progress' ||
    s === 'completed' ||
    s === 'failed' ||
    s === 'cancelled'
  ) {
    return s
  }
  return null
}

/**
 * True when `to` is a strictly-forward transition from `from`. Same rules
 * as MC's own status ladder (mirrored here so a network partition can't
 * cause disagreement):
 *   1. Never transition FROM a terminal status.
 *   2. Never no-op (same → same).
 *   3. Never go to a lower rank.
 *   4. Never transition between two DIFFERENT terminals (completed ↛ failed).
 */
export function isForwardMcTransition(
  from: McSimulationStatus,
  to: McSimulationStatus,
): boolean {
  if (from === to) return false
  if (TERMINAL.has(from)) return false
  return MC_STATUS_RANK[to] > MC_STATUS_RANK[from]
}
