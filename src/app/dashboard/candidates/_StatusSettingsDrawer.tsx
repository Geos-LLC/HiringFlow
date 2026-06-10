'use client'

/**
 * Status settings drawer — sibling of StageSettingsDrawer. Edits two
 * orthogonal pieces of the candidate-status model:
 *
 *  1. **Stale candidate detection** — a single workspace-level inactivity
 *     threshold consumed by the daily `/api/cron/detect-stalled`. Null /
 *     blank → use the platform default in `STALE_DETECTION_DEFAULT_DAYS`.
 *     Per-pipeline / per-stage overrides are a future feature.
 *
 *  2. **Statuses list** — 6 built-in statuses (read-only) plus
 *     workspace-defined custom statuses. Custom statuses are manual-only
 *     labels for "nurture-like" buckets the recruiter wants to track
 *     without touching the cron rule. Stored on
 *     `Workspace.settings.customStatuses`.
 */

import { useEffect, useState } from 'react'
import { Badge, Button } from '@/components/design'
import {
  CANDIDATE_STATUSES,
  STALE_DETECTION_DEFAULT_DAYS,
  STATUS_DISPLAY,
  makeCustomStatusId,
  type CandidateStatus,
  type CandidateStatusTone,
  type CustomStatus,
} from '@/lib/candidate-status'

const STATUS_DESCRIPTIONS: Record<CandidateStatus, string> = {
  active:  'Default — candidate is moving through the funnel.',
  waiting: 'Waiting on something external (e.g. a training to be scheduled). Treated like active on the board.',
  stalled: 'Auto-flagged by the daily cron when the candidate has no forward progress for the threshold below.',
  nurture: 'Manual — paused. Kept warm for a future cycle, not in the active pool.',
  lost:    'Manual — true terminal negative outcome (rejected, declined, etc.). Hidden from the default board.',
  hired:   'Manual — confirmed hire.',
}

const TONE_OPTIONS: Array<{ tone: CandidateStatusTone; color: string; label: string }> = [
  { tone: 'neutral', color: 'var(--neutral-fg)',    label: 'Grey'   },
  { tone: 'brand',   color: 'var(--brand-primary)', label: 'Orange' },
  { tone: 'success', color: 'var(--success-fg)',    label: 'Green'  },
  { tone: 'warn',    color: '#D97706',              label: 'Amber'  },
  { tone: 'info',    color: '#2563EB',              label: 'Blue'   },
  { tone: 'danger',  color: 'var(--danger-fg)',     label: 'Red'    },
]

interface Props {
  open: boolean
  onClose: () => void
  initialCustomStatuses: CustomStatus[]
  onSaved: (next: { customStatuses: CustomStatus[]; defaultStalledDays: number | null }) => void
}

export function StatusSettingsDrawer({ open, onClose, initialCustomStatuses, onSaved }: Props) {
  const [defaultStalledDays, setDefaultStalledDays] = useState<number | null>(null)
  const [customStatuses, setCustomStatuses] = useState<CustomStatus[]>(initialCustomStatuses)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Reload workspace settings + reset working copy whenever the drawer opens.
  useEffect(() => {
    if (!open) return
    setCustomStatuses(initialCustomStatuses)
    setError(null)
    setLoading(true)
    fetch('/api/workspace/settings', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((ws: Record<string, unknown>) => {
        const raw = ws.defaultStalledDays
        setDefaultStalledDays(typeof raw === 'number' && raw > 0 ? raw : null)
      })
      .catch(() => setError('Failed to load workspace settings'))
      .finally(() => setLoading(false))
  }, [open, initialCustomStatuses])

  if (!open) return null

  const addCustomStatus = () => {
    const label = `New status ${customStatuses.length + 1}`
    const id = makeCustomStatusId(label, customStatuses)
    setCustomStatuses((prev) => [...prev, { id, label, tone: 'neutral' }])
  }

  const updateCustomStatus = (id: string, patch: Partial<CustomStatus>) => {
    setCustomStatuses((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  const removeCustomStatus = (id: string) => {
    setCustomStatuses((prev) => prev.filter((s) => s.id !== id))
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const wsRes = await fetch('/api/workspace/settings', { credentials: 'same-origin' })
      const wsData = wsRes.ok ? await wsRes.json() : null
      const currentSettings = (wsData?.settings && typeof wsData.settings === 'object') ? wsData.settings : {}
      const cleaned = customStatuses
        .filter((s) => s.label.trim().length > 0)
        .map((s) => ({ id: s.id, label: s.label.trim(), tone: s.tone }))

      const res = await fetch('/api/workspace/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          settings: { ...currentSettings, customStatuses: cleaned },
          defaultStalledDays: defaultStalledDays,
        }),
      })
      if (!res.ok) throw new Error('Failed to save')

      onSaved({ customStatuses: cleaned, defaultStalledDays })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-end bg-black/30"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div
        className="h-full w-full max-w-[640px] bg-white shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-6 py-5 border-b border-surface-divider flex items-center justify-between">
          <div>
            <div className="text-[11px] font-mono uppercase text-grey-50 mb-1" style={{ letterSpacing: '0.1em' }}>
              Settings
            </div>
            <h2 className="text-[18px] font-semibold text-ink">Statuses</h2>
          </div>
          <button onClick={onClose} className="text-grey-40 hover:text-ink text-xl leading-none w-8 h-8 flex items-center justify-center rounded-md hover:bg-surface-light">×</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-7">
          {/* Disambiguation note — recruiters routinely confuse status (Active /
              Stalled / Hired / Lost / Nurture) with pipeline stage (kanban
              column). Surfacing the difference up-front prevents people from
              hunting for movement settings here. */}
          <div className="rounded-[10px] bg-amber-50 border border-amber-100 px-3 py-2.5 text-[12px] leading-snug text-amber-900">
            <div className="font-medium">Status rules don&apos;t move candidates between stages.</div>
            <div className="text-amber-800 mt-0.5">
              They only mark the candidate&apos;s lifecycle state — Active, Stalled, On Hold, Hired, or Lost —
              based on inactivity or a recruiter action. For stage movement (kanban columns) use the
              <strong> Stages</strong> drawer.
            </div>
          </div>

          {/* Section A — Unified stale-detection threshold */}
          <section>
            <div className="text-[13px] font-semibold text-ink mb-1">Stale candidate detection</div>
            <p className="text-[12px] text-grey-40 mb-4">
              Candidates are marked <strong>Stale</strong> when they have no forward progress for
              this many days. This applies to all pipelines and stages by default.
            </p>

            {loading ? (
              <div className="py-6 text-center text-sm text-grey-40">Loading…</div>
            ) : (
              <div className="rounded-[10px] border border-surface-border p-4">
                <label className="flex items-center gap-3">
                  <span className="text-[13px] text-ink min-w-[160px]">Default stale after:</span>
                  <div className="relative">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={defaultStalledDays ?? ''}
                      placeholder={String(STALE_DETECTION_DEFAULT_DAYS)}
                      onChange={(e) => {
                        const raw = e.target.value
                        if (raw === '') return setDefaultStalledDays(null)
                        const n = Number.parseInt(raw, 10)
                        if (Number.isNaN(n) || n <= 0) return
                        setDefaultStalledDays(n)
                      }}
                      className="w-[120px] px-2 pr-12 py-1.5 border border-surface-border rounded-[6px] text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono uppercase text-grey-50" style={{ letterSpacing: '0.08em' }}>
                      days
                    </span>
                  </div>
                  {defaultStalledDays === null && (
                    <span className="text-[11px] text-grey-50">
                      using platform default ({STALE_DETECTION_DEFAULT_DAYS} days)
                    </span>
                  )}
                </label>

                <p className="text-[11px] text-grey-50 mt-3">
                  You can add pipeline-specific or stage-specific stale rules later if needed.
                </p>
              </div>
            )}
          </section>

          {/* Section B — Statuses list */}
          <section>
            <div className="text-[13px] font-semibold text-ink mb-1">Statuses</div>
            <p className="text-[12px] text-grey-40 mb-4">
              Built-in statuses can&apos;t be edited or removed — their behavior is wired into the cron and analytics. Custom statuses are manual-only labels you can use as additional buckets.
            </p>

            <div className="rounded-[10px] border border-surface-border divide-y divide-surface-divider">
              {CANDIDATE_STATUSES.map((s) => {
                const meta = STATUS_DISPLAY[s]
                return (
                  <div key={s} className="px-4 py-3 flex items-start gap-3">
                    <div className="shrink-0 pt-0.5"><Badge tone={meta.tone}>{meta.label}</Badge></div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] text-grey-15">{STATUS_DESCRIPTIONS[s]}</div>
                    </div>
                    <span className="shrink-0 text-[10px] font-mono uppercase text-grey-50" style={{ letterSpacing: '0.08em' }}>built-in</span>
                  </div>
                )
              })}
              {customStatuses.map((s) => (
                <div key={s.id} className="px-4 py-3 flex items-center gap-3">
                  <input
                    type="text"
                    value={s.label}
                    onChange={(e) => updateCustomStatus(s.id, { label: e.target.value })}
                    placeholder="Status label"
                    className="flex-1 min-w-0 px-2 py-1.5 border border-surface-border rounded-[6px] text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                  />
                  <select
                    value={s.tone}
                    onChange={(e) => updateCustomStatus(s.id, { tone: e.target.value as CandidateStatusTone })}
                    className="shrink-0 px-2 py-1.5 border border-surface-border rounded-[6px] text-[12px] text-ink bg-white"
                  >
                    {TONE_OPTIONS.map((t) => <option key={t.tone} value={t.tone}>{t.label}</option>)}
                  </select>
                  <button
                    onClick={() => removeCustomStatus(s.id)}
                    title="Remove status"
                    className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-grey-50 hover:text-[color:var(--danger-fg)] hover:bg-[color:var(--danger-bg)] text-base leading-none"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={addCustomStatus}
              className="mt-3 text-[12px] px-3 py-1.5 rounded-[8px] border border-dashed border-surface-border text-grey-35 hover:border-grey-50 hover:text-ink"
            >
              + Add custom status
            </button>
          </section>
        </div>

        <div className="shrink-0 px-6 py-4 border-t border-surface-divider flex items-center justify-between gap-3">
          <div className="text-[12px] text-[color:var(--danger-fg)]">{error}</div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
