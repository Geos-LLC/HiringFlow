/**
 * Shared helpers for the Telegram channel layer.
 *
 * `chatRef` normalization: Telegram channel references are case-insensitive
 * and conventionally prefixed with `@` (e.g. `@cleaners_jax`). We normalize
 * to lowercase + leading-@ so the `(workspaceId, chatRef)` unique constraint
 * catches duplicate adds regardless of capitalization or whether the
 * recruiter pasted `@cleaners_jax`, `cleaners_jax`, or `CLEANERS_JAX`.
 *
 * Public channels can also be referenced by numeric chat id (`-1001234567890`)
 * — we leave those untouched.
 */

import type { TelegramVerifyVerdict } from './telegram-publisher'

export function normalizeChatRef(input: string): string {
  const trimmed = (input || '').trim()
  if (!trimmed) return ''
  // Numeric chat IDs (private channels) — no @ prefix, no case fold.
  if (/^-?\d+$/.test(trimmed)) return trimmed
  const withAt = trimmed.startsWith('@') ? trimmed : `@${trimmed}`
  return withAt.toLowerCase()
}

/**
 * Map TelePorter's verdict shape to the four-state `verifyStatus` column on
 * TelegramChannel. Kept as a single function so the UI + the API endpoint
 * always agree on what counts as `ready` vs `warning`.
 */
export type VerifyStatus = 'unverified' | 'ready' | 'warning' | 'blocked'

export function deriveVerifyStatus(verdict: TelegramVerifyVerdict | null | undefined): VerifyStatus {
  if (!verdict) return 'unverified'
  const blockers = Array.isArray(verdict.blockers) ? verdict.blockers : []
  if (blockers.length > 0) return 'blocked'
  if (verdict.status !== 'ready') return 'blocked'
  const warnings = Array.isArray(verdict.warnings) ? verdict.warnings : []
  return warnings.length > 0 ? 'warning' : 'ready'
}
