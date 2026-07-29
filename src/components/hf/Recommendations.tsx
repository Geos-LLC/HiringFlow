/**
 * Recommendations — 0–N action cards for any HFObject.
 *
 * UX rule #7: this is where AI shows up. The panel is labelled
 * "Recommendations", never "AI". Sources v1 are deterministic heuristics
 * (empty booking page, high no-show rate, oversize SMS body, …); v2 can
 * add LLM-generated cards without changing the shape.
 *
 * The panel self-hides when there are no items — never renders "no
 * recommendations".
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import { Card, Eyebrow } from '@/components/design'
import type { Recommendation } from '@/lib/hf-core/types'

export interface RecommendationsProps {
  items: Recommendation[]
  /** Called when the user dismisses a recommendation. Parent persists the snooze. */
  onDismiss?: (id: string, snoozeDays?: number) => void
  onOpenDrawer?: (drawerId: string, params?: Record<string, string>) => void
  onCallback?: (callbackId: string) => void
  className?: string
}

const SEVERITY_BORDER = {
  info:    'border-l-[color:var(--info-fg)]',
  nudge:   'border-l-[color:var(--brand-fg)]',
  warning: 'border-l-[color:var(--warn-fg)]',
} as const

export function Recommendations({ items, onDismiss, onOpenDrawer, onCallback, className = '' }: RecommendationsProps) {
  if (items.length === 0) return null

  return (
    <Card className={className}>
      <Eyebrow className="mb-3">Recommendations</Eyebrow>
      <ul className="flex flex-col gap-2">
        {items.map(r => (
          <li
            key={r.id}
            className={`border-l-2 pl-3 py-1.5 flex items-start justify-between gap-3 ${SEVERITY_BORDER[r.severity]}`}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-ink font-medium">{r.claim}</div>
              {r.detail && <div className="text-[12px] text-grey-35 mt-0.5">{r.detail}</div>}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {r.action && r.action.target?.kind === 'href' && (
                <Link
                  href={r.action.target.href}
                  className="text-[12px] font-medium text-brand-600 hover:text-brand-700 underline-offset-2 hover:underline"
                >
                  {r.action.label}
                </Link>
              )}
              {r.action && r.action.target?.kind === 'drawer' && (
                <button
                  onClick={() => {
                    if (r.action?.target?.kind === 'drawer') {
                      onOpenDrawer?.(r.action.target.drawerId, r.action.target.params)
                    }
                  }}
                  className="text-[12px] font-medium text-brand-600 hover:text-brand-700 underline-offset-2 hover:underline"
                >
                  {r.action.label}
                </button>
              )}
              {r.action && r.action.target?.kind === 'callback' && (
                <button
                  onClick={() => {
                    if (r.action?.target?.kind === 'callback') {
                      onCallback?.(r.action.target.callbackId)
                    }
                  }}
                  className="text-[12px] font-medium text-brand-600 hover:text-brand-700 underline-offset-2 hover:underline"
                >
                  {r.action.label}
                </button>
              )}
              {onDismiss && (
                <button
                  onClick={() => onDismiss(r.id, r.snoozeDays)}
                  aria-label="Dismiss recommendation"
                  className="text-grey-50 hover:text-grey-35 text-[16px] leading-none px-1"
                >
                  ×
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
