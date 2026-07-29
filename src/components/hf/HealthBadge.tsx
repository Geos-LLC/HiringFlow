/**
 * HealthBadge — universal health indicator for any HFObject.
 *
 * Renders 🟢 🟡 🔴 as a dot + label. Two sizes: `sm` (inline, list rows) and
 * `md` (header pill). Uses the shared status CSS variables so tone matches
 * every other badge in the app.
 *
 * See src/lib/hf-core/types.ts for the `Health` shape.
 */

import * as React from 'react'
import type { Health, HealthStatus } from '@/lib/hf-core/types'

export interface HealthBadgeProps {
  health: Health
  size?: 'sm' | 'md'
  /** Show only the dot (for very dense contexts — kanban cards). */
  dotOnly?: boolean
  className?: string
}

const TONE: Record<HealthStatus, { bg: string; fg: string; dot: string }> = {
  green:   { bg: 'var(--success-bg)', fg: 'var(--success-fg)', dot: '#1F6A3A' },
  yellow:  { bg: 'var(--warn-bg)',    fg: 'var(--warn-fg)',    dot: '#B77A00' },
  red:     { bg: 'var(--danger-bg)',  fg: 'var(--danger-fg)',  dot: '#A93A2C' },
  unknown: { bg: 'var(--neutral-bg)', fg: 'var(--neutral-fg)', dot: '#98989A' },
}

export function HealthBadge({ health, size = 'sm', dotOnly, className = '' }: HealthBadgeProps) {
  const t = TONE[health.status]
  const sizing =
    size === 'md'
      ? 'px-2.5 py-1 text-[12px]'
      : 'px-2 py-0.5 text-[11px]'

  if (dotOnly) {
    return (
      <span
        aria-label={health.label}
        title={health.detail ? `${health.label} — ${health.detail}` : health.label}
        className={`inline-block w-2 h-2 rounded-full ${className}`}
        style={{ background: t.dot }}
      />
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-mono uppercase whitespace-nowrap ${sizing} ${className}`.trim()}
      style={{ background: t.bg, color: t.fg, letterSpacing: '0.04em', fontWeight: 600 }}
      title={health.detail}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: t.dot }} />
      {health.label}
    </span>
  )
}
