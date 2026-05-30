'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/design'
import {
  type FunnelStage,
  type StageTrigger,
  type StageTriggerEvent,
  STAGE_TONE_OPTIONS,
  makeStageId,
  normalizeStages,
} from '@/lib/funnel-stages'

interface TargetOption { id: string; label: string }
interface TargetCatalog { flows: TargetOption[]; trainings: TargetOption[] }

const EVENT_LABELS: Record<StageTriggerEvent, string> = {
  flow_passed:        'Flow passed',
  flow_completed:     'Flow completed',
  training_started:   'Training started',
  training_completed: 'Training completed',
  meeting_scheduled:  'Interview scheduled',
  meeting_rescheduled:'Interview rescheduled',
  meeting_confirmed:  'Interview confirmed by candidate (SMS)',
  meeting_cancelled:  'Interview cancelled by candidate (SMS)',
  meeting_started:    'Interview started',
  meeting_ended:      'Interview ended',
  meeting_no_show:    'Interview no-show',
  recording_ready:    'Interview recording ready',
  transcript_ready:   'Interview transcript ready',
  background_check_passed:       'Background check passed',
  background_check_failed:       'Background check failed',
  background_check_needs_review: 'Background check — needs review',
}

function eventTargetKind(event: StageTriggerEvent): 'flow' | 'training' | null {
  if (event.startsWith('flow_')) return 'flow'
  if (event.startsWith('training_')) return 'training'
  return null
}

function describeTrigger(t: StageTrigger, catalog: TargetCatalog | null): string {
  const evt = EVENT_LABELS[t.event] ?? t.event
  const kind = eventTargetKind(t.event)
  if (!kind) return evt
  if (!t.targetId) return `${evt} (any)`
  const list = kind === 'flow' ? catalog?.flows : catalog?.trainings
  const found = list?.find((x) => x.id === t.targetId)
  return `${evt} — ${found?.label ?? t.targetId.slice(0, 6)}`
}

interface Props {
  open: boolean
  onClose: () => void
  // The pipeline whose stages this drawer edits. null means "the caller
  // hasn't loaded pipelines yet" — drawer disables Save in that case.
  // Stages are persisted via PATCH /api/pipelines/[id] (not workspace.settings).
  pipelineId: string | null
  pipelineName?: string
  // Pipeline Transitions v2 opt-in (Pipeline.transitionsV2Enabled). When true,
  // the V1 trigger editor is disabled in-place and a V2 rule editor appears
  // per stage. The toggle itself stays on /dashboard/pipelines (we read,
  // never write here) so the recruiter has one canonical place to flip it.
  transitionsV2Enabled?: boolean
  stages: FunnelStage[]
  candidateCounts: Record<string, number>
  onSaved: (stages: FunnelStage[]) => void
}

// Shape of a PipelineTransitionRule as returned by /api/pipelines/[id]/transition-rules.
// Kept minimal — only the fields the drawer reads/writes.
interface TransitionRule {
  id: string
  pipelineId: string
  fromStageId: string | null
  eventType: string
  targetId: string | null
  toStageId: string
  priority: number
  allowBackward: boolean
  enabled: boolean
}

// Per-stage "add rule" form state. Keyed by stageId in the drawer.
interface DraftRule {
  eventType: StageTriggerEvent
  fromStageId: string  // '' = Any
  targetMode: 'any' | 'specific'
  targetId: string
  priority: number
  allowBackward: boolean
  enabled: boolean
}
const emptyDraft: DraftRule = {
  eventType: 'flow_completed',
  fromStageId: '',
  targetMode: 'any',
  targetId: '',
  priority: 0,
  allowBackward: false,
  enabled: true,
}

type DeleteTarget = { stage: FunnelStage; count: number } | null

export function StageSettingsDrawer({ open, onClose, pipelineId, pipelineName, transitionsV2Enabled = false, stages: initial, candidateCounts, onSaved }: Props) {
  const [stages, setStages] = useState<FunnelStage[]>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null)
  const [reassignTo, setReassignTo] = useState<string>('')
  const [catalog, setCatalog] = useState<TargetCatalog | null>(null)
  const [pickerStageId, setPickerStageId] = useState<string | null>(null)
  const [pickerEvent, setPickerEvent] = useState<StageTriggerEvent>('training_started')
  const [pickerTargetId, setPickerTargetId] = useState<string>('')
  const [backfillPreview, setBackfillPreview] = useState<null | {
    total: number
    byStage: Record<string, number>
  }>(null)
  const [applying, setApplying] = useState(false)
  // ── V2 movement rules state ────────────────────────────────────────────
  // Loaded once per drawer open when rule-based movement is enabled. Empty
  // array means "fetched and no rules exist yet" (used by the empty-state
  // warning); null means "not yet fetched".
  const [v2Rules, setV2Rules] = useState<TransitionRule[] | null>(null)
  const [v2Loading, setV2Loading] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, DraftRule>>({})
  const [v2Busy, setV2Busy] = useState<string | null>(null)  // ruleId or `add:${stageId}`
  // Per-stage "Show legacy auto-move rules" disclosure. When rule-based
  // movement is on, V1 triggers are collapsed by default so the recruiter
  // edits one model at a time — but they can still inspect what's there
  // during migration. Keyed by stageId.
  const [legacyShown, setLegacyShown] = useState<Record<string, boolean>>({})
  // stage_entered automations for the current pipeline. Drives the "What
  // happens after they arrive" section on each stage card. Fetched once per
  // drawer open via /api/automations?pipelineId=... and filtered client-side
  // (no new API surface — see decision 1 in the UX scope).
  const [stageActions, setStageActions] = useState<Array<{
    id: string
    name: string
    stageId: string | null
    channel: string
    isActive: boolean
  }> | null>(null)

  useEffect(() => {
    if (!open || !transitionsV2Enabled || !pipelineId) { setV2Rules(null); return }
    let cancelled = false
    setV2Loading(true)
    fetch(`/api/pipelines/${pipelineId}/transition-rules`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : []))
      .then((rules: TransitionRule[]) => { if (!cancelled) setV2Rules(rules) })
      .catch(() => { if (!cancelled) setV2Rules([]) })
      .finally(() => { if (!cancelled) setV2Loading(false) })
    return () => { cancelled = true }
  }, [open, transitionsV2Enabled, pipelineId])

  // Load stage_entered automations once per drawer open (only when V2 is on
  // — V1 doesn't use the stage_entered trigger). Fetch all automations for
  // the pipeline, then filter client-side to triggerType==='stage_entered'.
  useEffect(() => {
    if (!open || !transitionsV2Enabled || !pipelineId) { setStageActions(null); return }
    let cancelled = false
    fetch(`/api/automations?pipelineId=${encodeURIComponent(pipelineId)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : []))
      .then((rules: Array<{ id: string; name: string; triggerType: string; stageId: string | null; channel: string; isActive: boolean }>) => {
        if (cancelled) return
        const actions = rules
          .filter((r) => r.triggerType === 'stage_entered')
          .map((r) => ({ id: r.id, name: r.name, stageId: r.stageId, channel: r.channel, isActive: r.isActive }))
        setStageActions(actions)
      })
      .catch(() => { if (!cancelled) setStageActions([]) })
    return () => { cancelled = true }
  }, [open, transitionsV2Enabled, pipelineId])

  useEffect(() => { setStages(initial) }, [initial, open])

  useEffect(() => {
    if (!open) return
    fetch('/api/funnel-stage-targets', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setCatalog({ flows: d.flows ?? [], trainings: d.trainings ?? [] }) })
      .catch(() => {})
  }, [open])

  if (!open) return null

  const updateStage = (id: string, patch: Partial<FunnelStage>) => {
    setStages((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  const addTrigger = (stageId: string, trigger: StageTrigger) => {
    setStages((prev) => prev.map((s) => {
      if (s.id !== stageId) return s
      const next = [...(s.triggers ?? []), trigger]
      // Dedupe identical triggers (same event + target).
      const seen = new Set<string>()
      const deduped = next.filter((t) => {
        const k = `${t.event}|${t.targetId ?? ''}`
        if (seen.has(k)) return false
        seen.add(k); return true
      })
      return { ...s, triggers: deduped }
    }))
  }

  const removeTrigger = (stageId: string, idx: number) => {
    setStages((prev) => prev.map((s) => {
      if (s.id !== stageId) return s
      const triggers = (s.triggers ?? []).filter((_, i) => i !== idx)
      return { ...s, triggers: triggers.length ? triggers : undefined }
    }))
  }

  const openPicker = (stageId: string) => {
    setPickerStageId(stageId)
    setPickerEvent('training_started')
    setPickerTargetId('')
  }
  const closePicker = () => setPickerStageId(null)
  const confirmPicker = () => {
    if (!pickerStageId) return
    const kind = eventTargetKind(pickerEvent)
    addTrigger(pickerStageId, {
      event: pickerEvent,
      ...(kind && pickerTargetId ? { targetId: pickerTargetId } : {}),
    })
    closePicker()
  }

  const addStage = () => {
    const label = `Stage ${stages.length + 1}`
    const id = makeStageId(label, stages)
    setStages((prev) => [
      ...prev,
      { id, label, tone: 'neutral', color: 'var(--neutral-fg)', order: prev.length },
    ])
  }

  // ── V2 rule CRUD ────────────────────────────────────────────────────────
  // All API calls return the freshly-persisted row(s); we update local state
  // from the response so optimistic-vs-server divergence is impossible.
  // Errors surface via setError and revert nothing — the local list and the
  // server stay aligned because we only mutate on success.
  const setDraft = (stageId: string, patch: Partial<DraftRule>) => {
    setDrafts((prev) => ({
      ...prev,
      [stageId]: { ...(prev[stageId] ?? emptyDraft), ...patch },
    }))
  }

  const addV2Rule = async (stageId: string) => {
    if (!pipelineId) return
    const draft = drafts[stageId] ?? emptyDraft
    setV2Busy(`add:${stageId}`)
    setError(null)
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/transition-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          eventType: draft.eventType,
          fromStageId: draft.fromStageId || null,
          targetId: draft.targetMode === 'specific' && draft.targetId.trim() ? draft.targetId.trim() : null,
          toStageId: stageId,
          priority: draft.priority,
          allowBackward: draft.allowBackward,
          enabled: draft.enabled,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to add rule')
      }
      const created: TransitionRule = await res.json()
      setV2Rules((prev) => [...(prev ?? []), created])
      // Reset the draft for this stage so the add-form clears.
      setDrafts((prev) => { const next = { ...prev }; delete next[stageId]; return next })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add rule')
    } finally {
      setV2Busy(null)
    }
  }

  const patchV2Rule = async (ruleId: string, patch: Partial<TransitionRule>) => {
    if (!pipelineId) return
    setV2Busy(ruleId)
    setError(null)
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/transition-rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to update rule')
      }
      const updated: TransitionRule = await res.json()
      setV2Rules((prev) => (prev ?? []).map((r) => (r.id === ruleId ? updated : r)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update rule')
    } finally {
      setV2Busy(null)
    }
  }

  const deleteV2Rule = async (ruleId: string) => {
    if (!pipelineId) return
    if (!confirm('Delete this transition rule?')) return
    setV2Busy(ruleId)
    setError(null)
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/transition-rules/${ruleId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to delete rule')
      }
      setV2Rules((prev) => (prev ?? []).filter((r) => r.id !== ruleId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete rule')
    } finally {
      setV2Busy(null)
    }
  }

  // Stages that have any V1 trigger configured anywhere. Drives the
  // "Convert legacy triggers to V2 rules" nudge when V2 is enabled but no
  // V2 rules have been created yet — the recruiter has existing V1 config
  // that could seed V2 rules.
  const hasV1Triggers = stages.some((s) => (s.triggers?.length ?? 0) > 0)
  const v2RulesEmpty = transitionsV2Enabled && v2Rules !== null && v2Rules.length === 0

  const move = (id: string, dir: -1 | 1) => {
    setStages((prev) => {
      const idx = prev.findIndex((s) => s.id === id)
      const next = idx + dir
      if (idx < 0 || next < 0 || next >= prev.length) return prev
      const copy = [...prev]
      ;[copy[idx], copy[next]] = [copy[next], copy[idx]]
      return copy.map((s, i) => ({ ...s, order: i }))
    })
  }

  const startDelete = (stage: FunnelStage) => {
    const count = candidateCounts[stage.id] ?? 0
    if (stages.length <= 1) {
      setError('You must have at least one stage')
      return
    }
    if (count === 0) {
      // Hybrid option C — empty stage deletes immediately on confirm.
      if (confirm(`Delete stage "${stage.label}"?`)) {
        setStages((prev) => prev.filter((s) => s.id !== stage.id).map((s, i) => ({ ...s, order: i })))
      }
      return
    }
    // Populated — force pick a target.
    const firstOther = stages.find((s) => s.id !== stage.id)?.id ?? ''
    setReassignTo(firstOther)
    setDeleteTarget({ stage, count })
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    if (!reassignTo) { setError('Pick a stage to move candidates to'); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/candidates/reassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromStatus: deleteTarget.stage.id, toStatus: reassignTo }),
      })
      if (!res.ok) throw new Error('Reassign failed')
      setStages((prev) =>
        prev.filter((s) => s.id !== deleteTarget.stage.id).map((s, i) => ({ ...s, order: i })),
      )
      setDeleteTarget(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reassign failed')
    } finally {
      setSaving(false)
    }
  }

  const save = async () => {
    if (!pipelineId) {
      setError('No pipeline selected')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ stages }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Save failed (${res.status}): ${text.slice(0, 160)}`)
      }
      const body = await res.json().catch(() => ({}))
      const persisted = Array.isArray(body?.stages) ? body.stages : null
      if (!persisted || persisted.length !== stages.length) {
        throw new Error(`Save did not persist (server returned ${persisted ? persisted.length : 'no'} stages)`)
      }
      const saved = normalizeStages(persisted)
      onSaved(saved)
      // After persisting stages, run a dry-run backfill against the saved
      // triggers. If anything would move, surface a confirmation modal so
      // the user can decide whether to re-apply triggers retroactively.
      try {
        const drf = await fetch('/api/funnel-stages/backfill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ commit: false }),
        })
        if (drf.ok) {
          const j = await drf.json()
          if (j.total > 0) {
            setBackfillPreview({ total: j.total, byStage: j.byStage ?? {} })
            return // keep drawer open to show the preview modal
          }
        }
      } catch { /* ignore — settings already saved */ }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const applyBackfill = async () => {
    setApplying(true)
    try {
      await fetch('/api/funnel-stages/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ commit: true }),
      })
      setBackfillPreview(null)
      // Re-fire onSaved so the page re-fetches candidates with their new
      // pipeline_status values. Stages haven't changed since the save, but
      // onSaved triggers a load() on the page side.
      onSaved(stages)
      onClose()
    } catch {
      setError('Re-apply failed')
    } finally {
      setApplying(false)
    }
  }

  const skipBackfill = () => {
    setBackfillPreview(null)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative ml-auto h-full w-full max-w-[480px] bg-white shadow-xl flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 py-4 border-b border-surface-divider flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase text-grey-50" style={{ letterSpacing: '0.1em' }}>Stages · {pipelineName ?? 'Default'}</div>
            <h2 className="font-semibold text-[16px] text-ink truncate">Funnel stages</h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-2">
          {/* Pipeline setup guide — compact 4-step strip that teaches the
              model recruiters are working in (Stages → Movement → Actions →
              Status). Drawer is where the confusion happens, so the guide
              lives here rather than on the pipelines list page. */}
          <div className="mb-3 rounded-[10px] border border-surface-divider bg-surface-light px-3 py-2">
            <div className="font-mono text-[9px] uppercase text-grey-50 mb-1.5" style={{ letterSpacing: '0.1em' }}>
              Pipeline setup
            </div>
            <ol className="text-[11px] text-grey-15 leading-snug space-y-0.5">
              <li><strong>1. Stages</strong> &middot; <span className="text-grey-40">columns candidates move through.</span></li>
              <li><strong>2. Movement rules</strong> &middot; <span className="text-grey-40">when candidates automatically move.</span></li>
              <li><strong>3. Actions</strong> &middot; <span className="text-grey-40">messages, links, trainings, notifications after stage entry.</span></li>
              <li><strong>4. Status rules</strong> &middot; <span className="text-grey-40">stalled / lost / hired tracking (edited from the Statuses drawer).</span></li>
            </ol>
          </div>
          {transitionsV2Enabled && (
            <div className="mb-3 px-3 py-2.5 rounded-[10px] bg-brand-50 border border-brand-100 text-brand-900 text-[12px] leading-snug">
              <div className="font-medium mb-0.5">Rule-based movement is on for this pipeline</div>
              <div className="text-brand-800">
                Candidates move only when a movement rule matches. If no rule matches, they stay put.
                Turn off from <a href="/dashboard/pipelines" className="underline">Pipelines</a> to return to legacy auto-move.
              </div>
              {v2RulesEmpty && (
                <div className="mt-2 pt-2 border-t border-brand-100/70 text-amber-900 bg-amber-50/40 -mx-3 -mb-2.5 px-3 py-2 rounded-b-[10px]">
                  <div className="font-medium">No movement rules yet</div>
                  <div className="text-amber-800 mt-0.5">
                    Rule-based movement is enabled but this pipeline has no movement rules.
                    Candidates will <strong>not</strong> automatically move between stages until you add some below.
                    {hasV1Triggers && (
                      <span> Existing legacy rules can be converted later via the backfill script.</span>
                    )}
                  </div>
                </div>
              )}
              {v2Loading && (
                <div className="mt-1.5 text-[11px] text-brand-700">Loading movement rules…</div>
              )}
            </div>
          )}
          {stages.map((s, idx) => {
            const count = candidateCounts[s.id] ?? 0
            return (
              <div
                key={s.id}
                className="rounded-[10px] border border-surface-border bg-white p-3"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} />
                  <input
                    value={s.label}
                    onChange={(e) => updateStage(s.id, { label: e.target.value })}
                    className="flex-1 px-2 py-1.5 border border-surface-border rounded-md text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                  />
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => move(s.id, -1)}
                      disabled={idx === 0}
                      className="w-7 h-7 flex items-center justify-center text-grey-35 hover:text-ink hover:bg-surface-light rounded disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Move up"
                    >↑</button>
                    <button
                      onClick={() => move(s.id, 1)}
                      disabled={idx === stages.length - 1}
                      className="w-7 h-7 flex items-center justify-center text-grey-35 hover:text-ink hover:bg-surface-light rounded disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Move down"
                    >↓</button>
                    <button
                      onClick={() => startDelete(s)}
                      className="w-7 h-7 flex items-center justify-center text-[color:var(--danger-fg)] hover:bg-[color:var(--danger-bg)] rounded"
                      title="Delete stage"
                    >×</button>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex gap-1">
                    {STAGE_TONE_OPTIONS.map((opt) => (
                      <button
                        key={opt.tone}
                        onClick={() => updateStage(s.id, { tone: opt.tone, color: opt.color })}
                        title={opt.label}
                        className={`w-5 h-5 rounded-full border-2 transition-all ${
                          s.tone === opt.tone ? 'border-ink scale-110' : 'border-transparent'
                        }`}
                        style={{ background: opt.color }}
                      />
                    ))}
                  </div>
                  <div className="font-mono text-[10px] uppercase text-grey-50" style={{ letterSpacing: '0.08em' }}>
                    {count} candidate{count === 1 ? '' : 's'}
                  </div>
                </div>

                {/* ── How candidates reach this stage (V1 mode) ──
                    Plain rename of the legacy "Auto-move when…" section.
                    Only shown when rule-based movement is OFF for this
                    pipeline; under V2, the section below this owns it. */}
                {!transitionsV2Enabled && (
                  <div className="mt-3 pt-3 border-t border-surface-divider">
                    <div className="font-mono text-[9px] uppercase text-grey-50 mb-2" style={{ letterSpacing: '0.1em' }}>
                      How candidates reach this stage
                    </div>
                    {(s.triggers ?? []).length === 0 ? (
                      <div className="text-[11px] text-grey-50 mb-2">No movement rules — candidates only move here manually.</div>
                    ) : (
                      <div className="space-y-1 mb-2">
                        {(s.triggers ?? []).map((t, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 bg-surface-light rounded-md px-2 py-1">
                            <span className="text-[11px] text-ink truncate">{describeTrigger(t, catalog)}</span>
                            <button
                              onClick={() => removeTrigger(s.id, i)}
                              className="shrink-0 text-grey-35 hover:text-[color:var(--danger-fg)] text-[12px] w-5 h-5 flex items-center justify-center"
                              title="Remove movement rule"
                            >×</button>
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => openPicker(s.id)}
                      className="text-[11px] text-grey-35 hover:text-ink underline-offset-2 hover:underline"
                    >
                      + Add movement rule
                    </button>
                  </div>
                )}

                {/* ── How candidates reach this stage (V2 mode) ──
                    Lists PipelineTransitionRule rows whose toStageId points
                    at this stage. Persisted via /api/pipelines/[id]/transition-rules
                    independently of the stages save below. */}
                {transitionsV2Enabled && (
                  <div className="mt-3 pt-3 border-t border-surface-divider">
                    <div className="font-mono text-[9px] uppercase text-grey-50 mb-2" style={{ letterSpacing: '0.1em' }}>
                      How candidates reach this stage
                    </div>
                    {(() => {
                      const stageRules = (v2Rules ?? []).filter((r) => r.toStageId === s.id)
                      if (stageRules.length === 0) {
                        return <div className="text-[11px] text-grey-50 mb-2">No movement rules — candidates only move here manually.</div>
                      }
                      return (
                        <div className="space-y-1 mb-2">
                          {stageRules.map((r) => (
                            <div key={r.id} className="bg-surface-light rounded-md px-2 py-1.5 text-[11px]">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-ink truncate">
                                  <strong>{EVENT_LABELS[r.eventType as StageTriggerEvent] ?? r.eventType}</strong>
                                  {r.fromStageId && (
                                    <> from <em>{stages.find((x) => x.id === r.fromStageId)?.label ?? r.fromStageId}</em></>
                                  )}
                                  {!r.fromStageId && <> from any stage</>}
                                  {r.targetId && <> · target <code className="text-[10px]">{r.targetId.slice(0, 8)}</code></>}
                                </span>
                                <div className="shrink-0 flex items-center gap-1">
                                  <label className="inline-flex items-center gap-1 text-[10px] text-grey-50">
                                    <input
                                      type="checkbox"
                                      checked={r.enabled}
                                      disabled={v2Busy === r.id}
                                      onChange={(e) => patchV2Rule(r.id, { enabled: e.target.checked })}
                                      className="h-3 w-3"
                                    />
                                    on
                                  </label>
                                  <button
                                    onClick={() => deleteV2Rule(r.id)}
                                    disabled={v2Busy === r.id}
                                    className="text-grey-35 hover:text-[color:var(--danger-fg)] w-5 h-5 flex items-center justify-center"
                                    title="Delete movement rule"
                                  >×</button>
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 mt-1 text-[10px] text-grey-50">
                                <span>priority {r.priority}</span>
                                <label className="inline-flex items-center gap-1">
                                  <input
                                    type="checkbox"
                                    checked={r.allowBackward}
                                    disabled={v2Busy === r.id}
                                    onChange={(e) => patchV2Rule(r.id, { allowBackward: e.target.checked })}
                                    className="h-3 w-3"
                                  />
                                  allow backward movement
                                </label>
                              </div>
                            </div>
                          ))}
                        </div>
                      )
                    })()}

                    {/* Add-rule inline form. Wildcard target is the default;
                        the recruiter can opt into a Specific target via the
                        dropdown (raw id input — no entity picker in this
                        pass per UX scope). */}
                    {(() => {
                      const draft = drafts[s.id] ?? emptyDraft
                      const adding = v2Busy === `add:${s.id}`
                      return (
                        <div className="mt-2 p-2 bg-white border border-dashed border-surface-border rounded-md space-y-1.5 text-[11px]">
                          <div className="text-[10px] text-grey-40 mb-0.5">Move candidate here when:</div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <label className="inline-flex items-center gap-1 text-grey-50">
                              Event
                              <select
                                value={draft.eventType}
                                onChange={(e) => setDraft(s.id, { eventType: e.target.value as StageTriggerEvent })}
                                className="px-1.5 py-1 border border-surface-border rounded text-[11px] bg-white"
                              >
                                {(Object.keys(EVENT_LABELS) as StageTriggerEvent[]).map((ev) => (
                                  <option key={ev} value={ev}>{EVENT_LABELS[ev]}</option>
                                ))}
                              </select>
                            </label>
                            <label className="inline-flex items-center gap-1 text-grey-50">
                              From
                              <select
                                value={draft.fromStageId}
                                onChange={(e) => setDraft(s.id, { fromStageId: e.target.value })}
                                className="px-1.5 py-1 border border-surface-border rounded text-[11px] bg-white"
                              >
                                <option value="">Any stage</option>
                                {stages.filter((x) => x.id !== s.id).map((x) => (
                                  <option key={x.id} value={x.id}>{x.label}</option>
                                ))}
                              </select>
                            </label>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <label className="inline-flex items-center gap-1 text-grey-50">
                              Target
                              <select
                                value={draft.targetMode}
                                onChange={(e) => setDraft(s.id, { targetMode: e.target.value as 'any' | 'specific', targetId: '' })}
                                className="px-1.5 py-1 border border-surface-border rounded text-[11px] bg-white"
                              >
                                <option value="any">Any</option>
                                <option value="specific">Specific</option>
                              </select>
                            </label>
                            {draft.targetMode === 'specific' && (
                              <input
                                type="text"
                                placeholder="Flow / training / config id"
                                value={draft.targetId}
                                onChange={(e) => setDraft(s.id, { targetId: e.target.value })}
                                className="flex-1 min-w-[140px] px-1.5 py-1 border border-surface-border rounded text-[11px] bg-white"
                              />
                            )}
                            <label className="inline-flex items-center gap-1 text-grey-50">
                              Priority
                              <input
                                type="number"
                                value={draft.priority}
                                onChange={(e) => setDraft(s.id, { priority: parseInt(e.target.value) || 0 })}
                                className="w-14 px-1.5 py-1 border border-surface-border rounded text-[11px] bg-white"
                              />
                            </label>
                            <label className="inline-flex items-center gap-1 text-grey-50">
                              <input
                                type="checkbox"
                                checked={draft.allowBackward}
                                onChange={(e) => setDraft(s.id, { allowBackward: e.target.checked })}
                                className="h-3 w-3"
                              />
                              Allow backward movement
                            </label>
                            <label className="inline-flex items-center gap-1 text-grey-50">
                              <input
                                type="checkbox"
                                checked={draft.enabled}
                                onChange={(e) => setDraft(s.id, { enabled: e.target.checked })}
                                className="h-3 w-3"
                              />
                              Enabled
                            </label>
                          </div>
                          <button
                            onClick={() => addV2Rule(s.id)}
                            disabled={adding || (draft.targetMode === 'specific' && !draft.targetId.trim())}
                            className="text-[11px] text-brand-700 hover:text-brand-900 underline-offset-2 hover:underline disabled:text-grey-40 disabled:no-underline disabled:cursor-not-allowed"
                          >
                            {adding ? 'Adding…' : '+ Add movement rule'}
                          </button>
                        </div>
                      )
                    })()}
                  </div>
                )}

                {/* ── What happens after they arrive (V2 only) ──
                    Surfaces stage_entered AutomationRule rows pinned to
                    this (pipeline, stage). "+ Add action" deep-links to
                    /dashboard/automations with prefill params; the
                    automations page auto-opens the new-rule modal with
                    triggerType/pipelineId/stageId set. */}
                {transitionsV2Enabled && (
                  <div className="mt-3 pt-3 border-t border-surface-divider">
                    <div className="font-mono text-[9px] uppercase text-grey-50 mb-2" style={{ letterSpacing: '0.1em' }}>
                      What happens after they arrive
                    </div>
                    {stageActions === null ? (
                      <div className="text-[11px] text-grey-50 mb-2">Loading actions…</div>
                    ) : (() => {
                      const actions = stageActions.filter((a) => a.stageId === s.id)
                      if (actions.length === 0) {
                        return <div className="text-[11px] text-grey-50 mb-2">No actions yet — nothing happens automatically when candidates land here.</div>
                      }
                      return (
                        <div className="space-y-1 mb-2">
                          {actions.map((a) => (
                            <div key={a.id} className="flex items-center justify-between gap-2 bg-surface-light rounded-md px-2 py-1 text-[11px]">
                              <span className="text-ink truncate">
                                {a.name}
                                <span className="text-grey-50"> · {a.channel}</span>
                                {!a.isActive && <span className="ml-1 text-amber-700">(paused)</span>}
                              </span>
                              <a
                                href={`/dashboard/automations?ruleId=${a.id}`}
                                className="shrink-0 text-grey-35 hover:text-ink underline-offset-2 hover:underline text-[10px]"
                              >
                                Edit
                              </a>
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                    {pipelineId && (
                      <a
                        href={`/dashboard/automations?triggerType=stage_entered&pipelineId=${encodeURIComponent(pipelineId)}&stageId=${encodeURIComponent(s.id)}`}
                        className="text-[11px] text-brand-700 hover:text-brand-900 underline-offset-2 hover:underline"
                      >
                        + Add action
                      </a>
                    )}
                  </div>
                )}

                {/* ── Legacy auto-move (V2 only, collapsed) ──
                    Read-only view of V1 stage.triggers[] kept around during
                    migration so the recruiter can see what the legacy system
                    would have done. Hidden by default; expanded per-stage
                    via legacyShown state. */}
                {transitionsV2Enabled && (s.triggers?.length ?? 0) > 0 && (
                  <div className="mt-3 pt-3 border-t border-surface-divider">
                    <button
                      onClick={() => setLegacyShown((prev) => ({ ...prev, [s.id]: !prev[s.id] }))}
                      className="text-[10px] text-grey-50 hover:text-grey-15 underline-offset-2 hover:underline"
                    >
                      {legacyShown[s.id] ? '− Hide' : '+ Show'} legacy auto-move rules ({s.triggers?.length ?? 0})
                    </button>
                    {legacyShown[s.id] && (
                      <div className="mt-2 space-y-1 opacity-70">
                        {(s.triggers ?? []).map((t, i) => (
                          <div key={i} className="bg-surface-light rounded-md px-2 py-1 text-[11px] text-ink">
                            {describeTrigger(t, catalog)}
                          </div>
                        ))}
                        <div className="text-[10px] text-grey-50 italic mt-1">
                          Read-only while rule-based movement is on. Use the movement rules above to control how candidates reach this stage.
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          <button
            onClick={addStage}
            className="w-full py-2.5 rounded-[10px] border border-dashed border-surface-border text-[13px] text-grey-35 hover:text-ink hover:border-ink/40 hover:bg-surface-light transition-colors"
          >
            + Add stage
          </button>
        </div>

        {error && (
          <div className="shrink-0 mx-5 mb-3 px-3 py-2 rounded-md text-[12px] text-[color:var(--danger-fg)] bg-[color:var(--danger-bg)]">
            {error}
          </div>
        )}

        {pickerStageId && (() => {
          const kind = eventTargetKind(pickerEvent)
          const targetList = kind === 'flow' ? catalog?.flows : kind === 'training' ? catalog?.trainings : null
          return (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center p-5">
              <div className="bg-white rounded-[12px] shadow-xl w-full max-w-[400px] p-5">
                <h3 className="font-semibold text-[15px] text-ink mb-3">Add movement rule</h3>
                <label className="block text-[11px] font-mono uppercase text-grey-50 mb-1.5" style={{ letterSpacing: '0.08em' }}>Event</label>
                <select
                  value={pickerEvent}
                  onChange={(e) => { setPickerEvent(e.target.value as StageTriggerEvent); setPickerTargetId('') }}
                  className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] text-ink bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40 mb-3"
                >
                  {(Object.keys(EVENT_LABELS) as StageTriggerEvent[]).map((ev) => (
                    <option key={ev} value={ev}>{EVENT_LABELS[ev]}</option>
                  ))}
                </select>
                {kind && (
                  <>
                    <label className="block text-[11px] font-mono uppercase text-grey-50 mb-1.5" style={{ letterSpacing: '0.08em' }}>
                      {kind === 'flow' ? 'Flow' : 'Training'}
                    </label>
                    <select
                      value={pickerTargetId}
                      onChange={(e) => setPickerTargetId(e.target.value)}
                      className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] text-ink bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40 mb-4"
                    >
                      <option value="">Any {kind}</option>
                      {(targetList ?? []).map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                  </>
                )}
                <div className="flex justify-end gap-2 mt-2">
                  <Button variant="ghost" onClick={closePicker}>Cancel</Button>
                  <Button variant="primary" onClick={confirmPicker}>Add</Button>
                </div>
              </div>
            </div>
          )
        })()}

        {backfillPreview && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center p-5">
            <div className="bg-white rounded-[12px] shadow-xl w-full max-w-[420px] p-5">
              <h3 className="font-semibold text-[15px] text-ink mb-1">
                Re-apply triggers to existing candidates?
              </h3>
              <p className="text-[13px] text-grey-35 mb-3">
                Based on your saved triggers, {backfillPreview.total} candidate{backfillPreview.total === 1 ? '' : 's'} would move:
              </p>
              <div className="space-y-1 mb-4 max-h-[200px] overflow-y-auto">
                {Object.entries(backfillPreview.byStage).map(([stageId, count]) => {
                  const stage = stages.find((s) => s.id === stageId)
                  return (
                    <div key={stageId} className="flex items-center justify-between bg-surface-light rounded-md px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: stage?.color ?? 'var(--neutral-fg)' }} />
                        <span className="text-[12px] text-ink">{stage?.label ?? stageId}</span>
                      </div>
                      <span className="font-mono text-[11px] text-grey-35">{count}</span>
                    </div>
                  )
                })}
              </div>
              <p className="text-[11px] text-grey-50 mb-3">
                Skipping leaves existing candidates where they are; future events will still auto-move them.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={skipBackfill} disabled={applying}>Skip</Button>
                <Button variant="primary" onClick={applyBackfill} disabled={applying}>
                  {applying ? 'Applying…' : 'Re-apply'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {deleteTarget && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center p-5">
            <div className="bg-white rounded-[12px] shadow-xl w-full max-w-[400px] p-5">
              <h3 className="font-semibold text-[15px] text-ink mb-1">
                Delete &ldquo;{deleteTarget.stage.label}&rdquo;?
              </h3>
              <p className="text-[13px] text-grey-35 mb-4">
                {deleteTarget.count} candidate{deleteTarget.count === 1 ? '' : 's'} {deleteTarget.count === 1 ? 'is' : 'are'} in this stage. Move them to:
              </p>
              <select
                value={reassignTo}
                onChange={(e) => setReassignTo(e.target.value)}
                className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] text-ink bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40 mb-4"
              >
                {stages.filter((s) => s.id !== deleteTarget.stage.id).map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={saving}>Cancel</Button>
                <Button variant="primary" onClick={confirmDelete} disabled={saving}>
                  {saving ? 'Moving…' : `Move & delete`}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
