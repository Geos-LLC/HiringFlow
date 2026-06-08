/**
 * WipBadge — visual marker for UI surfaces whose backend isn't wired up yet.
 *
 * Use this for new elements that ship with the layout but aren't functional.
 * The dashed border + monospace "Coming soon" label tells the recruiter
 * "this is real but parked" without mistaking it for a broken button.
 *
 * Inline form: small pill next to a label. Block form: wraps a card-like
 * section. Both are intentionally low-saturation so they don't compete with
 * live UI.
 */

import * as React from 'react'

export interface WipBadgeProps {
  /** Optional short reason ("Export to CSV", "Visual stage map") */
  label?: string
  className?: string
}

export function WipBadge({ label = 'Coming soon', className = '' }: WipBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-grey-50 px-1.5 py-0.5 rounded-[6px] border border-dashed border-grey-35 ${className}`.trim()}
    >
      <span aria-hidden>○</span>
      {label}
    </span>
  )
}

export interface WipSectionProps {
  title?: string
  description?: string
  children?: React.ReactNode
  className?: string
}

export function WipSection({ title, description, children, className = '' }: WipSectionProps) {
  return (
    <div
      className={`rounded-[12px] border border-dashed border-grey-35 p-4 bg-surface-light ${className}`.trim()}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-[13px] text-ink">{title || 'Coming soon'}</div>
        <WipBadge />
      </div>
      {description && <div className="text-[12px] text-grey-35 mb-2">{description}</div>}
      {children}
    </div>
  )
}
