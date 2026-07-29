/**
 * Health resolvers — map domain objects to the universal `Health` primitive.
 *
 * One helper per object kind. Each is pure and pluggable so both server and
 * client can call it. Keep them focused on presentation-facing decisions —
 * status labels, colors, and short detail strings — not on business logic.
 *
 * See src/lib/hf-core/types.ts for the `Health` interface.
 */

import type { Health } from './types'
import type { CandidateStatus, CandidateDispositionReason } from '@/lib/candidate-status'
import { DISPOSITION_DISPLAY } from '@/lib/candidate-status'

// ─── Candidate ──────────────────────────────────────────────────────────────

export interface CandidateHealthInput {
  status: CandidateStatus | string | null | undefined
  dispositionReason?: CandidateDispositionReason | null
  stalledAt?: string | null
  lostAt?: string | null
  hiredAt?: string | null
  rejectionReason?: string | null
  pipelineStatus?: string | null
}

export function candidateHealth(c: CandidateHealthInput): Health {
  const status = c.status || 'active'

  if (status === 'hired' || c.pipelineStatus === 'hired') {
    return {
      status: 'green',
      label: 'Hired',
      detail: c.hiredAt ? `on ${formatDate(c.hiredAt)}` : undefined,
    }
  }

  if (status === 'lost' || c.pipelineStatus === 'rejected' || c.pipelineStatus === 'failed') {
    const reason = c.rejectionReason || (c.dispositionReason && DISPOSITION_DISPLAY[c.dispositionReason])
    return {
      status: 'red',
      label: status === 'lost' ? 'Lost' : 'Rejected',
      detail: reason || undefined,
    }
  }

  if (status === 'stalled') {
    return {
      status: 'red',
      label: 'Stalled',
      detail: buildStalledDetail(c),
    }
  }

  if (status === 'waiting') {
    return { status: 'yellow', label: 'Waiting' }
  }

  if (status === 'nurture') {
    return { status: 'yellow', label: 'On hold' }
  }

  // Custom statuses (cust_*) fall through as neutral-yellow — the workspace
  // owns the label, we don't presume health.
  if (typeof status === 'string' && status.startsWith('cust_')) {
    return { status: 'unknown', label: 'Custom status' }
  }

  return { status: 'green', label: 'On track' }
}

function buildStalledDetail(c: CandidateHealthInput): string | undefined {
  const parts: string[] = []
  if (c.stalledAt) {
    const days = daysAgo(c.stalledAt)
    if (days != null) parts.push(days === 0 ? 'today' : `${days}d`)
  }
  if (c.dispositionReason) parts.push(DISPOSITION_DISPLAY[c.dispositionReason])
  return parts.length ? parts.join(' · ') : undefined
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function daysAgo(iso: string): number | null {
  try {
    const then = new Date(iso).getTime()
    if (Number.isNaN(then)) return null
    return Math.max(0, Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000)))
  } catch {
    return null
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString()
  } catch {
    return iso
  }
}
