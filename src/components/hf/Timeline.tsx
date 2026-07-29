/**
 * Timeline — UI for the HireFunnel event bus.
 *
 * The single component behind every activity feed in the app. Consumers
 * either:
 *   1. Pass `entries` directly (Phase 0 — most existing surfaces).
 *   2. Pass `scope` and let the future `useTimeline(scope)` hook resolve
 *      entries against the shared event log (Phase 1, once lifecycle writes
 *      publish HFEvent rows).
 *
 * Same visual language and delivery-pill treatment on every scope, so a
 * recruiter who understands the Candidate timeline immediately understands
 * the Stage timeline, Position timeline, Workspace timeline, and so on.
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import { Eyebrow } from '@/components/design'
import type { TimelineEntry, TimelineEntryType, TimelineScope, HFEventDelivery } from '@/lib/hf-core/types'

export interface TimelineProps {
  entries: TimelineEntry[]
  /** Optional — Phase 1 will use this to resolve entries via the event bus. */
  scope?: TimelineScope
  /** Header eyebrow. Defaults to "Timeline". Pass empty string to omit. */
  title?: string
  /** Truncate to N entries with a "Show more" toggle. */
  initial?: number
  /** Empty state text. Panel hides entirely if omitted and entries are empty. */
  emptyLabel?: string
  className?: string
}

export function Timeline({
  entries,
  title = 'Timeline',
  initial,
  emptyLabel,
  className = '',
}: TimelineProps) {
  const [showAll, setShowAll] = React.useState(false)
  const visible = !initial || showAll ? entries : entries.slice(0, initial)

  if (entries.length === 0) {
    if (!emptyLabel) return null
    return (
      <div className={className}>
        {title && <Eyebrow className="mb-3">{title}</Eyebrow>}
        <div className="text-[13px] text-grey-40">{emptyLabel}</div>
      </div>
    )
  }

  return (
    <div className={className}>
      {title && <Eyebrow className="mb-3">{title}</Eyebrow>}
      <ol className="flex flex-col">
        {visible.map(entry => (
          <TimelineRow key={entry.id} entry={entry} />
        ))}
      </ol>
      {initial && entries.length > initial && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-3 text-[12px] text-brand-600 hover:text-brand-700 font-medium"
        >
          Show {entries.length - initial} more
        </button>
      )}
    </div>
  )
}

// ─── Row ────────────────────────────────────────────────────────────────────

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const dot = DOT[entry.type]
  const body = (
    <div className="flex items-start gap-3 py-2">
      <span
        aria-hidden
        className="mt-1.5 shrink-0 w-2 h-2 rounded-full"
        style={{ background: dot.color }}
        title={entry.type}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13px] text-ink">{entry.label}</span>
          {entry.delivery && <DeliveryPill delivery={entry.delivery} />}
          <span className="text-[11px] text-grey-40 font-mono">{formatTime(entry.time)}</span>
        </div>
        {entry.detail && (
          <div className="text-[12px] text-grey-35 mt-0.5 whitespace-pre-wrap break-words">
            {entry.detail}
          </div>
        )}
      </div>
    </div>
  )

  if (entry.href) {
    return (
      <li>
        <Link href={entry.href} className="block hover:bg-surface-light rounded-lg -mx-2 px-2">
          {body}
        </Link>
      </li>
    )
  }
  return <li>{body}</li>
}

// ─── Delivery pill (matches DeliveryBadgePill used on candidate page) ───────

function DeliveryPill({ delivery }: { delivery: HFEventDelivery }) {
  const meta = DELIVERY_META[delivery.status] ?? DELIVERY_META.pending
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] uppercase whitespace-nowrap"
      style={{ background: meta.bg, color: meta.fg, letterSpacing: '0.04em', fontWeight: 600 }}
      title={delivery.error || delivery.at || meta.label}
    >
      <span className="inline-block w-1 h-1 rounded-full" style={{ background: 'currentColor' }} />
      {meta.label}
    </span>
  )
}

const DOT: Record<TimelineEntryType, { color: string }> = {
  start:     { color: 'var(--info-fg)' },
  success:   { color: 'var(--success-fg)' },
  error:     { color: 'var(--danger-fg)' },
  info:      { color: 'var(--neutral-fg)' },
  scheduled: { color: 'var(--warn-fg)' },
}

const DELIVERY_META: Record<HFEventDelivery['status'], { bg: string; fg: string; label: string }> = {
  pending:   { bg: 'var(--neutral-bg)', fg: 'var(--neutral-fg)', label: 'Pending' },
  processed: { bg: 'var(--neutral-bg)', fg: 'var(--neutral-fg)', label: 'Processed' },
  delivered: { bg: 'var(--success-bg)', fg: 'var(--success-fg)', label: 'Delivered' },
  deferred:  { bg: 'var(--warn-bg)',    fg: 'var(--warn-fg)',    label: 'Deferred' },
  bounced:   { bg: 'var(--danger-bg)',  fg: 'var(--danger-fg)',  label: 'Bounced' },
  dropped:   { bg: 'var(--danger-bg)',  fg: 'var(--danger-fg)',  label: 'Dropped' },
  blocked:   { bg: 'var(--danger-bg)',  fg: 'var(--danger-fg)',  label: 'Blocked' },
  failed:    { bg: 'var(--danger-bg)',  fg: 'var(--danger-fg)',  label: 'Failed' },
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString()
  } catch {
    return iso
  }
}
