/**
 * ObjectShell — the standard chrome for any HFObject detail surface.
 *
 * Renders (top to bottom):
 *
 *   Header:          title + subtitle + HealthBadge + PrimaryActionButton
 *   Uncertainty row: 4 short answers to UX rule #0 (what/ok?/attention/next)
 *   Info cards:      compact stat grid
 *   Slots:           `recommendations`, `body`, `timeline`, `advanced`
 *
 * The shell is intentionally thin — layout only. Object-specific panels
 * (candidates list, interview panel, notes, etc.) render inside `body` as
 * plain children so each object composes its own middle rather than
 * inheriting a template. Same building blocks, different order per object.
 */

'use client'

import * as React from 'react'
import { Card, Eyebrow } from '@/components/design'
import { HealthBadge } from './HealthBadge'
import { PrimaryActionButton } from './PrimaryActionButton'
import type { HFObject } from '@/lib/hf-core/types'

export interface ObjectShellProps {
  object: HFObject
  onOpenDrawer?: (drawerId: string, params?: Record<string, string>) => void
  onCallback?: (callbackId: string) => void
  /** Recommendations panel (rendered right after the uncertainty row). */
  recommendations?: React.ReactNode
  /** Object-specific body — the "middle" of the page. */
  body?: React.ReactNode
  /** Timeline slot at the bottom (or wherever the object composes it). */
  timeline?: React.ReactNode
  /** Advanced ▾ collapsible section. */
  advanced?: React.ReactNode
  className?: string
}

export function ObjectShell({
  object,
  onOpenDrawer,
  onCallback,
  recommendations,
  body,
  timeline,
  advanced,
  className = '',
}: ObjectShellProps) {
  const { overview, primaryAction } = object

  return (
    <div className={`flex flex-col gap-5 ${className}`.trim()}>
      {/* Header */}
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-[26px] font-semibold text-ink leading-none tracking-tight2 m-0">
              {overview.title}
            </h1>
            <HealthBadge health={overview.health} size="md" />
          </div>
          {overview.subtitle && (
            <div className="text-[13px] text-grey-35 mt-1.5">{overview.subtitle}</div>
          )}
        </div>
        <PrimaryActionButton
          action={primaryAction}
          onOpenDrawer={onOpenDrawer}
          onCallback={onCallback}
        />
      </header>

      {/* Uncertainty row — UX rule #0 */}
      <Card padding={16}>
        <dl className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <UncertaintyItem label="What is this" value={overview.uncertainty.whatIsThis} />
          <UncertaintyItem label="Everything ok" value={overview.uncertainty.everythingOk} />
          <UncertaintyItem label="Needs you" value={overview.uncertainty.needsAttention} />
          <UncertaintyItem label="Next best" value={overview.uncertainty.nextBest} />
        </dl>
      </Card>

      {/* Info cards */}
      {overview.infoCards.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {overview.infoCards.map((c, i) => (
            <Card key={`${c.label}-${i}`} padding={14}>
              <Eyebrow size="xs" className="mb-1">{c.label}</Eyebrow>
              <div className="text-[22px] font-semibold text-ink leading-none">{c.value}</div>
              {c.sub && <div className="text-[12px] text-grey-40 mt-1">{c.sub}</div>}
            </Card>
          ))}
        </div>
      )}

      {recommendations}
      {body}
      {timeline}
      {advanced}
    </div>
  )
}

function UncertaintyItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase text-grey-40" style={{ letterSpacing: '0.1em' }}>
        {label}
      </dt>
      <dd className="text-[13px] text-ink mt-1 m-0">{value}</dd>
    </div>
  )
}
