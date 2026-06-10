'use client'

// Pipelines management page.
//
// Each pipeline owns an ordered stage list (the kanban columns). Roles with
// different hiring loops point flows at different pipelines so the columns
// stay relevant — e.g. Dispatcher pipeline has no "Training" stage, while
// Cleaner does.
//
// One pipeline per workspace is marked default; new flows with
// `pipelineId = null` fall back to that default at runtime. The default
// can't be deleted but can be swapped with another via "Make default".

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader, Card, Button, WipBadge } from '@/components/design'
import type { FunnelStage } from '@/lib/funnel-stages'
import { StageSettingsDrawer } from '@/app/dashboard/candidates/_StageSettingsDrawer'

interface PipelineRow {
  id: string
  name: string
  isDefault: boolean
  stages: FunnelStage[]
  flowCount: number
  transitionsV2Enabled: boolean
  createdAt: string
}

interface FlowRow {
  id: string
  name: string
  pipelineId: string | null
}

// Per-stage data surfaced inside the Stage details panel — fetched from the
// existing transition-rules / automations / workspace-settings endpoints so
// the four sub-cards (auto-move, entry automations, stale, notifications)
// reflect live workspace config instead of WIP placeholders.
interface TransitionRuleLite {
  id: string
  fromStageId: string | null
  toStageId: string
  eventType: string
  targetId: string | null
  priority: number
  enabled: boolean
}

interface AutomationStepLite {
  id: string
  channel: string
  emailDestination: string
  smsDestination: string
  emailDestinationAddress: string | null
  smsDestinationNumber: string | null
}

interface AutomationRuleLite {
  id: string
  name: string
  triggerType: string
  stageId: string | null
  channel: string
  isActive: boolean
  steps: AutomationStepLite[]
}

interface WorkspaceSettingsLite {
  defaultStalledDays: number | null
  senderEmail: string | null
  senderName: string | null
  phone: string | null
}

interface TargetOption { id: string; label: string }
interface TargetCatalog { flows: TargetOption[]; trainings: TargetOption[] }

// Resolves a stage trigger's targetId to a human-readable name (flow name or
// training title) the same way the StageSettingsDrawer renders it. Falls back
// to a short id snippet so the UI never shows a raw uuid.
function resolveTargetLabel(
  event: string,
  targetId: string | null | undefined,
  catalog: TargetCatalog | null,
): string | null {
  if (!targetId) return null
  const isFlow = event.startsWith('flow_')
  const isTraining = event.startsWith('training_')
  if (!isFlow && !isTraining) return null
  const list = isFlow ? catalog?.flows : catalog?.trainings
  const found = list?.find((x) => x.id === targetId)
  return found?.label ?? targetId.slice(0, 6)
}

const STAGE_EVENT_LABELS: Record<string, string> = {
  flow_passed: 'Flow passed',
  flow_completed: 'Flow completed',
  training_started: 'Training started',
  training_completed: 'Training completed',
  meeting_scheduled: 'Interview scheduled',
  meeting_rescheduled: 'Interview rescheduled',
  meeting_confirmed: 'Interview confirmed',
  meeting_cancelled: 'Interview cancelled',
  meeting_started: 'Interview started',
  meeting_ended: 'Interview ended',
  meeting_no_show: 'Interview no-show',
  recording_ready: 'Recording ready',
  transcript_ready: 'Transcript ready',
  background_check_passed: 'Background check passed',
  background_check_failed: 'Background check failed',
  background_check_needs_review: 'Background check — needs review',
  stage_entered: 'Stage entered',
  before_meeting: 'Before meeting',
}

const STALE_FALLBACK_DAYS = 7

export default function PipelinesPage() {
  const [pipelines, setPipelines] = useState<PipelineRow[]>([])
  const [flows, setFlows] = useState<FlowRow[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [seedFromId, setSeedFromId] = useState<string>('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  // Delete-confirmation modal state. The recruiter must type DELETE to enable
  // the action button — this prevents accidental destruction even if the
  // delete button gets misclicked. confirmInput is reset every time the
  // modal opens.
  const [deleteTarget, setDeleteTarget] = useState<PipelineRow | null>(null)
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('')
  // Stage Settings drawer mounted right on this page so the recruiter can
  // configure a pipeline without first navigating to the kanban. Used both
  // for the per-card "Set up" button AND auto-opened immediately after a
  // successful create so the recruiter doesn't land on an unconfigured
  // pipeline with no obvious next step.
  const [setupTarget, setSetupTarget] = useState<PipelineRow | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Editor state — the new top section. Selected pipeline drives the
  // visual stage map; selected stage drives the details + candidates
  // panels. Both default to the workspace's default pipeline and its
  // first stage once the API responds. `selectedStageId` is a string
  // (stage id) rather than the FunnelStage object so it survives
  // refetches without going stale.
  const [editorPipelineId, setEditorPipelineId] = useState<string | null>(null)
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null)
  const [stageCandidates, setStageCandidates] = useState<Array<{ id: string; candidateName: string | null; flow: { name: string } | null }>>([])
  const [stageCandidatesLoading, setStageCandidatesLoading] = useState(false)

  // Stage details data (per-pipeline, re-fetched when the recruiter switches
  // pipelines). Each panel filters this in-memory by the currently selected
  // stage id rather than hitting the API on every click.
  const [transitionRules, setTransitionRules] = useState<TransitionRuleLite[]>([])
  const [transitionRulesLoading, setTransitionRulesLoading] = useState(false)
  const [automations, setAutomations] = useState<AutomationRuleLite[]>([])
  const [automationsLoading, setAutomationsLoading] = useState(false)
  // Workspace-wide knobs (stalled threshold, recruiter email). Fetched once
  // per page mount — these don't change when the recruiter switches pipelines.
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettingsLite | null>(null)
  // Flow + training names so the Auto-move rules list can render
  // "Flow passed — Application Form" instead of a raw uuid. Same endpoint the
  // StageSettingsDrawer uses for its trigger picker.
  const [targetCatalog, setTargetCatalog] = useState<TargetCatalog | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [pRes, fRes] = await Promise.all([
      fetch('/api/pipelines'),
      fetch('/api/flows'),
    ])
    if (pRes.ok) setPipelines(await pRes.json())
    if (fRes.ok) setFlows(await fRes.json())
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Pick a default selected pipeline + stage once data lands. Keeps the
  // editor view "always populated" rather than empty until the recruiter
  // picks a pipeline manually.
  useEffect(() => {
    if (editorPipelineId || pipelines.length === 0) return
    const def = pipelines.find((p) => p.isDefault) ?? pipelines[0]
    setEditorPipelineId(def.id)
    setSelectedStageId(def.stages[0]?.id ?? null)
  }, [pipelines, editorPipelineId])

  const editorPipeline = useMemo(
    () => pipelines.find((p) => p.id === editorPipelineId) ?? null,
    [pipelines, editorPipelineId],
  )
  const selectedStage = useMemo(
    () => editorPipeline?.stages.find((s) => s.id === selectedStageId) ?? null,
    [editorPipeline, selectedStageId],
  )

  // Fetch the candidates-in-selected-stage panel data. The candidates list
  // endpoint already filters by pipelineStatus, so we reuse it instead of
  // adding a new aggregate. Limited to first 25 — this panel is at-a-glance,
  // not a full board.
  useEffect(() => {
    if (!editorPipelineId || !selectedStageId) {
      setStageCandidates([])
      return
    }
    setStageCandidatesLoading(true)
    const params = new URLSearchParams({
      pipelineId: editorPipelineId,
      status: selectedStageId,
    })
    fetch(`/api/candidates?${params.toString()}`)
      .then((r) => r.ok ? r.json() : [])
      .then((rows: Array<{ id: string; candidateName: string | null; flow: { name: string } | null }>) => {
        setStageCandidates(rows.slice(0, 25))
      })
      .catch(() => setStageCandidates([]))
      .finally(() => setStageCandidatesLoading(false))
  }, [editorPipelineId, selectedStageId])

  // Fetch transition rules + automations whenever the recruiter switches
  // pipelines. Both endpoints scope by pipelineId so we get exactly the rows
  // that could land or fire on stages in this pipeline.
  useEffect(() => {
    if (!editorPipelineId) {
      setTransitionRules([])
      setAutomations([])
      return
    }
    setTransitionRulesLoading(true)
    fetch(`/api/pipelines/${editorPipelineId}/transition-rules`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: TransitionRuleLite[]) => setTransitionRules(rows))
      .catch(() => setTransitionRules([]))
      .finally(() => setTransitionRulesLoading(false))

    setAutomationsLoading(true)
    fetch(`/api/automations?pipelineId=${encodeURIComponent(editorPipelineId)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: AutomationRuleLite[]) => setAutomations(rows))
      .catch(() => setAutomations([]))
      .finally(() => setAutomationsLoading(false))
  }, [editorPipelineId])

  // Flow + training catalog: once per page mount. Lets us resolve
  // FunnelStage trigger targetIds to flow/training names.
  useEffect(() => {
    fetch('/api/funnel-stage-targets')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setTargetCatalog({ flows: d.flows ?? [], trainings: d.trainings ?? [] })
      })
      .catch(() => {})
  }, [])

  // Workspace settings: once per page mount. Carries defaultStalledDays and
  // senderEmail which drive the Stale rule + Notifications sub-cards.
  useEffect(() => {
    fetch('/api/workspace/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: WorkspaceSettingsLite | null) => {
        if (data) {
          setWorkspaceSettings({
            defaultStalledDays: data.defaultStalledDays ?? null,
            senderEmail: data.senderEmail ?? null,
            senderName: data.senderName ?? null,
            phone: data.phone ?? null,
          })
        }
      })
      .catch(() => {})
  }, [])

  // Derived per-stage slices. `stageTransitionRules` only includes rules whose
  // `toStageId` matches the selected stage — that's the "candidates land here
  // when…" list. `stageEntryAutomations` filters to rules pinned with
  // stage_entered + selected stageId — the "what happens after they arrive"
  // list. `stageNotificationSteps` walks those rules' steps and picks the
  // ones whose destination is the workspace recruiter (company-side) so the
  // Notifications card surfaces just the recruiter-bound sends.
  const stageTransitionRules = useMemo(
    () => (selectedStageId ? transitionRules.filter((r) => r.toStageId === selectedStageId) : []),
    [transitionRules, selectedStageId],
  )

  // Combined "how candidates reach this stage" list. Sources:
  //  - V1: FunnelStage.triggers[] (always present, even when V2 is off — this
  //        is the only movement model for V1 pipelines).
  //  - V2: PipelineTransitionRule rows with toStageId = selectedStage.id.
  // We label each entry with its source so the recruiter knows where to edit
  // it (the StageSettingsDrawer shows V1 vs V2 in separate sections).
  type MovementRow = {
    key: string
    source: 'v1' | 'v2'
    eventType: string
    targetLabel: string | null
    fromLabel: string | null
    enabled: boolean
  }
  const stageMovementRules = useMemo<MovementRow[]>(() => {
    if (!selectedStage) return []
    const v1Rows: MovementRow[] = (selectedStage.triggers ?? []).map((t, i) => ({
      key: `v1-${i}-${t.event}-${t.targetId ?? ''}`,
      source: 'v1',
      eventType: t.event,
      targetLabel: resolveTargetLabel(t.event, t.targetId, targetCatalog),
      fromLabel: null,
      enabled: true,
    }))
    const v2Rows: MovementRow[] = stageTransitionRules.map((r) => ({
      key: `v2-${r.id}`,
      source: 'v2',
      eventType: r.eventType,
      targetLabel: resolveTargetLabel(r.eventType, r.targetId, targetCatalog),
      fromLabel: r.fromStageId
        ? (editorPipeline?.stages.find((x) => x.id === r.fromStageId)?.label ?? r.fromStageId)
        : 'any stage',
      enabled: r.enabled,
    }))
    return [...v1Rows, ...v2Rows]
  }, [selectedStage, stageTransitionRules, targetCatalog, editorPipeline])
  const stageEntryAutomations = useMemo(
    () => (selectedStageId
      ? automations.filter((a) => a.triggerType === 'stage_entered' && a.stageId === selectedStageId)
      : []),
    [automations, selectedStageId],
  )
  const stageNotificationSteps = useMemo(() => {
    const out: Array<{ ruleId: string; ruleName: string; channel: string; address: string }> = []
    for (const rule of stageEntryAutomations) {
      for (const step of rule.steps ?? []) {
        if ((step.channel === 'email' || step.channel === 'both') && step.emailDestination === 'company') {
          out.push({
            ruleId: rule.id,
            ruleName: rule.name,
            channel: 'email',
            address: workspaceSettings?.senderEmail || step.emailDestinationAddress || '—',
          })
        }
        if ((step.channel === 'sms' || step.channel === 'both') && step.smsDestination === 'company') {
          out.push({
            ruleId: rule.id,
            ruleName: rule.name,
            channel: 'sms',
            address: workspaceSettings?.phone || step.smsDestinationNumber || '—',
          })
        }
      }
    }
    return out
  }, [stageEntryAutomations, workspaceSettings])

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, seedFromPipelineId: seedFromId || undefined }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to create')
      }
      const created: PipelineRow = await res.json()
      setNewName('')
      setSeedFromId('')
      await load()
      // Auto-open the setup drawer for the just-created pipeline so the
      // recruiter has an immediate next step instead of staring at an
      // unconfigured card. They can close without saving if they wanted
      // to wait — closing doesn't undo the create.
      setSetupTarget(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  const makeDefault = async (id: string) => {
    setBusyId(id)
    try {
      const res = await fetch(`/api/pipelines/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ makeDefault: true }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to set default')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusyId(null)
    }
  }

  const rename = async (id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusyId(id)
    try {
      const res = await fetch(`/api/pipelines/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to rename')
      }
      setRenameTarget(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusyId(null)
    }
  }

  // Opens the typed-confirmation modal. Backend protection (default pipeline
  // cannot be deleted) is enforced at the API; the UI inlines that check
  // here too so the recruiter gets immediate feedback instead of a 409 round
  // trip.
  const requestDelete = (p: PipelineRow) => {
    if (p.isDefault) {
      setError('Promote another pipeline to default before deleting this one.')
      return
    }
    setError(null)
    setDeleteConfirmInput('')
    setDeleteTarget(p)
  }

  // Executes the delete after the recruiter has typed DELETE in the modal.
  const confirmDelete = async () => {
    if (!deleteTarget) return
    if (deleteConfirmInput !== 'DELETE') return
    const p = deleteTarget
    setBusyId(p.id)
    try {
      const res = await fetch(`/api/pipelines/${p.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to delete')
      }
      setDeleteTarget(null)
      setDeleteConfirmInput('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusyId(null)
    }
  }

  // Per-pipeline V2 opt-in toggle. Optimistic update so the section
  // expand/collapse feels instant; if the PATCH fails we revert and surface
  // the error in the page-level banner.
  const toggleV2 = async (id: string, next: boolean) => {
    setPipelines((cur) => cur.map((p) => (p.id === id ? { ...p, transitionsV2Enabled: next } : p)))
    try {
      const res = await fetch(`/api/pipelines/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transitionsV2Enabled: next }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to update')
      }
    } catch (err) {
      // Revert on failure.
      setPipelines((cur) => cur.map((p) => (p.id === id ? { ...p, transitionsV2Enabled: !next } : p)))
      setError(err instanceof Error ? err.message : 'Failed to toggle V2')
    }
  }

  const reassignFlow = async (flowId: string, pipelineId: string | null) => {
    const res = await fetch(`/api/flows/${flowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineId }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setError(d?.error || 'Failed to reassign flow')
      return
    }
    // Optimistic update so the panel reflects the move immediately. The
    // pipeline flow-counts come from a separate /api/pipelines fetch — we
    // refresh both so the badges stay in sync.
    setFlows((cur) => cur.map((f) => f.id === flowId ? { ...f, pipelineId } : f))
    fetch('/api/pipelines').then((r) => r.json()).then(setPipelines).catch(() => {})
  }

  return (
    <div>
      <PageHeader
        eyebrow={editorPipeline ? `${editorPipeline.stages.length} stages` : `${pipelines.length} pipeline${pipelines.length === 1 ? '' : 's'}`}
        title="Pipeline"
        description="Configure the stages a candidate moves through. Each stage has its own movement rules and entry automations."
        actions={
          <div className="flex items-center gap-2">
            {/* Pipeline selector. Drives the visual stage map below. */}
            <select
              value={editorPipelineId ?? ''}
              onChange={(e) => {
                const id = e.target.value || null
                setEditorPipelineId(id)
                const p = pipelines.find((x) => x.id === id)
                setSelectedStageId(p?.stages[0]?.id ?? null)
              }}
              className="px-3 py-2 border border-surface-border rounded-[10px] text-[13px] text-ink bg-white"
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
            <button
              onClick={() => editorPipeline && setSetupTarget(editorPipeline)}
              disabled={!editorPipeline}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] border border-surface-border text-[13px] text-ink hover:bg-surface-light disabled:opacity-50"
              title="Open the Stages drawer to add, rename, reorder, or delete stages"
            >
              + Add Stage
            </button>
            <button
              disabled
              title="Bulk save will land when the visual map editor is live. For now use the Stages drawer."
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] border border-dashed border-grey-35 text-[13px] text-grey-35 cursor-not-allowed"
            >
              Save changes
              <WipBadge label="WIP" />
            </button>
            <Link
              href="/dashboard/candidates"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] border border-surface-border text-[13px] text-ink hover:bg-surface-light"
            >
              &larr; Kanban
            </Link>
          </div>
        }
      />

      {error && (
        <div className="mb-4 px-4 py-3 rounded-[10px] bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* === New editor section: visual map + details + candidates === */}
      {editorPipeline && (
        <>
          {/* Visual stage map. Placeholder rendering: a horizontal strip of
              stage chips with arrows between them. The "flowchart" version
              (drag to reorder, branching from a stage to multiple targets) is
              queued — until then the strip lets the recruiter at least click
              a stage to drill in. */}
          <Card padding={20} className="mb-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="font-semibold text-[14px] text-ink">Visual stage map</h2>
                <p className="text-[12px] text-grey-35">Click a stage to inspect its details and current candidates.</p>
              </div>
              <WipBadge label="Drag-to-reorder coming" />
            </div>
            <div className="flex items-center gap-2 overflow-x-auto pb-2">
              {editorPipeline.stages.map((stage, idx) => {
                const isSelected = stage.id === selectedStageId
                return (
                  <div key={stage.id} className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setSelectedStageId(stage.id)}
                      className={`inline-flex items-center gap-2 px-3 py-2 rounded-[10px] border transition-all whitespace-nowrap ${
                        isSelected
                          ? 'border-ink bg-ink text-white shadow-sm'
                          : 'border-surface-border bg-white text-ink hover:border-grey-50'
                      }`}
                    >
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ background: isSelected ? 'white' : stage.color }}
                      />
                      <span className="text-[13px] font-medium">{stage.label}</span>
                    </button>
                    {idx < editorPipeline.stages.length - 1 && (
                      <svg width="20" height="14" viewBox="0 0 20 14" className="text-grey-50 shrink-0">
                        <path d="M2 7h14m0 0l-4-4m4 4l-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Stage details + candidates panel. Spec: middle = stage details
              with Name/Type/Rules; right = candidates currently in selected
              stage. Type field is NEW (not modeled yet on FunnelStage) so
              renders as WIP. Rules sections inherit from the existing
              StageSettingsDrawer which we open via "Edit rules". */}
          {selectedStage && (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 mb-6">
              <Card padding={20}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35 mb-1">Stage details</div>
                    <h2 className="font-semibold text-[16px] text-ink">{selectedStage.label}</h2>
                  </div>
                  <button
                    onClick={() => editorPipeline && setSetupTarget(editorPipeline)}
                    className="text-[12px] px-2.5 py-1 rounded-[8px] border border-surface-border text-ink hover:bg-surface-light"
                  >
                    Edit in drawer →
                  </button>
                </div>

                <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-[13px] mb-4">
                  <dt className="text-grey-35">Name</dt>
                  <dd className="text-ink">{selectedStage.label}</dd>
                  <dt className="text-grey-35">Stage id</dt>
                  <dd className="font-mono text-[12px] text-grey-15">{selectedStage.id}</dd>
                  <dt className="text-grey-35">Order</dt>
                  <dd className="text-ink">{selectedStage.order}</dd>
                  <dt className="text-grey-35 flex items-center gap-1">
                    Type <WipBadge label="WIP" />
                  </dt>
                  <dd className="text-grey-35">
                    Active / Hired / Lost classification — not modeled yet.
                  </dd>
                  <dt className="text-grey-35">Entry triggers</dt>
                  <dd className="text-ink">
                    {selectedStage.triggers && selectedStage.triggers.length > 0
                      ? selectedStage.triggers.map((t) => t.event).join(', ')
                      : <span className="text-grey-35">None configured</span>
                    }
                  </dd>
                </dl>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Auto-move rules: combined view of V1 FunnelStage.triggers
                      (the only movement model when transitionsV2Enabled is off)
                      and V2 PipelineTransitionRule rows. Each row is labeled
                      with its source so the recruiter knows which editor in
                      the drawer owns it. */}
                  <div className="rounded-[12px] border border-surface-border p-4 bg-white">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-semibold text-[13px] text-ink">
                        Auto-move rules
                        {stageMovementRules.length > 0 && (
                          <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full bg-surface-light text-[10px] font-mono text-grey-15 tabular-nums">
                            {stageMovementRules.length}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-[12px] text-grey-35 mb-2">
                      Movement rules that land candidates in this stage.
                    </div>
                    {transitionRulesLoading ? (
                      <div className="text-[12px] text-grey-40">Loading…</div>
                    ) : stageMovementRules.length === 0 ? (
                      <div className="text-[12px] text-grey-40">
                        No movement rules — candidates only land here manually.
                      </div>
                    ) : (
                      <ul className="space-y-1.5">
                        {stageMovementRules.slice(0, 4).map((row) => (
                          <li
                            key={row.key}
                            className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-[8px] bg-surface-light text-[12px]"
                          >
                            <span className="text-ink truncate">
                              <strong>{STAGE_EVENT_LABELS[row.eventType] ?? row.eventType}</strong>
                              {row.targetLabel && (
                                <span className="text-grey-35"> — {row.targetLabel}</span>
                              )}
                              {row.fromLabel && (
                                <span className="text-grey-35"> · from {row.fromLabel}</span>
                              )}
                            </span>
                            <span className="shrink-0 flex items-center gap-1">
                              {row.source === 'v2' && (
                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] ${
                                  row.enabled ? 'bg-green-50 text-green-700' : 'bg-grey-50/20 text-grey-35'
                                }`}>
                                  {row.enabled ? 'on' : 'off'}
                                </span>
                              )}
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-surface-border text-grey-15 font-mono text-[9px] uppercase tracking-wide"
                                title={row.source === 'v1' ? 'Legacy stage trigger' : 'Pipeline transition rule (V2)'}
                              >
                                {row.source}
                              </span>
                            </span>
                          </li>
                        ))}
                        {stageMovementRules.length > 4 && (
                          <li className="text-[11px] text-grey-35 px-2">
                            + {stageMovementRules.length - 4} more…
                          </li>
                        )}
                      </ul>
                    )}
                    <button
                      onClick={() => editorPipeline && setSetupTarget(editorPipeline)}
                      className="mt-2 text-[11px] text-brand-700 hover:text-brand-900 underline-offset-2 hover:underline"
                    >
                      Manage in drawer →
                    </button>
                  </div>

                  {/* Stage entry automations: AutomationRule rows pinned to
                      (this pipeline, this stage) with triggerType='stage_entered'.
                      Fire once a candidate lands here (after movement rules
                      have done their work). +Add deep-links to the automations
                      page with prefill params. */}
                  <div className="rounded-[12px] border border-surface-border p-4 bg-white">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-semibold text-[13px] text-ink">
                        Stage entry automations
                        {stageEntryAutomations.length > 0 && (
                          <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full bg-surface-light text-[10px] font-mono text-grey-15 tabular-nums">
                            {stageEntryAutomations.length}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-[12px] text-grey-35 mb-2">
                      Fire when a candidate enters this stage.
                    </div>
                    {automationsLoading ? (
                      <div className="text-[12px] text-grey-40">Loading…</div>
                    ) : stageEntryAutomations.length === 0 ? (
                      <div className="text-[12px] text-grey-40">
                        No automations pinned to this stage.
                      </div>
                    ) : (
                      <ul className="space-y-1.5">
                        {stageEntryAutomations.slice(0, 4).map((a) => {
                          const stepCount = a.steps?.length ?? 0
                          return (
                            <li key={a.id}>
                              <a
                                href={`/dashboard/automations?ruleId=${a.id}`}
                                className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-[8px] bg-surface-light hover:bg-surface-border text-[12px]"
                              >
                                <span className="text-ink truncate">
                                  {a.name}
                                  <span className="text-grey-35"> · {a.channel} · {stepCount} step{stepCount === 1 ? '' : 's'}</span>
                                </span>
                                {!a.isActive && (
                                  <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px]">paused</span>
                                )}
                              </a>
                            </li>
                          )
                        })}
                        {stageEntryAutomations.length > 4 && (
                          <li className="text-[11px] text-grey-35 px-2">
                            + {stageEntryAutomations.length - 4} more…
                          </li>
                        )}
                      </ul>
                    )}
                    {editorPipelineId && selectedStageId && (
                      <a
                        href={`/dashboard/automations?triggerType=stage_entered&pipelineId=${encodeURIComponent(editorPipelineId)}&stageId=${encodeURIComponent(selectedStageId)}`}
                        className="mt-2 inline-block text-[11px] text-brand-700 hover:text-brand-900 underline-offset-2 hover:underline"
                      >
                        + Add automation →
                      </a>
                    )}
                  </div>

                  {/* Stale rule: stalled detector is workspace-wide today
                      (Workspace.defaultStalledDays). Show the current value
                      so the recruiter knows what threshold governs THIS
                      stage; per-stage override stays a WipBadge until modeled. */}
                  <div className="rounded-[12px] border border-surface-border p-4 bg-white">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-semibold text-[13px] text-ink">Stale rule</div>
                      <WipBadge label="Per-stage override coming" />
                    </div>
                    <div className="text-[12px] text-grey-35 mb-2">
                      Candidates with no progress for this many days flip to <strong>Stalled</strong>.
                    </div>
                    {!workspaceSettings ? (
                      <div className="text-[12px] text-grey-40">Loading…</div>
                    ) : (
                      <div className="px-2 py-1.5 rounded-[8px] bg-surface-light text-[12px] text-ink">
                        <strong className="tabular-nums">
                          {workspaceSettings.defaultStalledDays ?? STALE_FALLBACK_DAYS}
                        </strong>{' '}
                        day{(workspaceSettings.defaultStalledDays ?? STALE_FALLBACK_DAYS) === 1 ? '' : 's'}
                        {workspaceSettings.defaultStalledDays === null && (
                          <span className="ml-1 text-grey-35">(workspace default)</span>
                        )}
                      </div>
                    )}
                    <Link
                      href="/dashboard/candidates"
                      className="mt-2 inline-block text-[11px] text-brand-700 hover:text-brand-900 underline-offset-2 hover:underline"
                      title="Open the Statuses drawer from the kanban to edit the workspace stalled threshold"
                    >
                      Edit in Statuses drawer →
                    </Link>
                  </div>

                  {/* Notifications: recruiter-bound sends inside the
                      stage_entered automations above. We surface each step
                      whose emailDestination or smsDestination is 'company' so
                      the recruiter sees exactly who'll get pinged when
                      candidates land here, and at what address
                      (Workspace.senderEmail / Workspace.phone). */}
                  <div className="rounded-[12px] border border-surface-border p-4 bg-white">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-semibold text-[13px] text-ink">
                        Notifications
                        {stageNotificationSteps.length > 0 && (
                          <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full bg-surface-light text-[10px] font-mono text-grey-15 tabular-nums">
                            {stageNotificationSteps.length}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-[12px] text-grey-35 mb-2">
                      Recruiter-side pings when candidates enter this stage.
                    </div>
                    {automationsLoading ? (
                      <div className="text-[12px] text-grey-40">Loading…</div>
                    ) : stageNotificationSteps.length === 0 ? (
                      <div className="text-[12px] text-grey-40">
                        No recruiter notifications wired up.
                        {!workspaceSettings?.senderEmail && (
                          <span> Set a sender email in Workspace settings first.</span>
                        )}
                      </div>
                    ) : (
                      <ul className="space-y-1.5">
                        {stageNotificationSteps.slice(0, 4).map((n, idx) => (
                          <li
                            key={`${n.ruleId}-${idx}`}
                            className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-[8px] bg-surface-light text-[12px]"
                          >
                            <span className="text-ink truncate">
                              {n.ruleName}
                              <span className="text-grey-35"> · {n.channel} → {n.address}</span>
                            </span>
                          </li>
                        ))}
                        {stageNotificationSteps.length > 4 && (
                          <li className="text-[11px] text-grey-35 px-2">
                            + {stageNotificationSteps.length - 4} more…
                          </li>
                        )}
                      </ul>
                    )}
                    {editorPipelineId && selectedStageId && (
                      <a
                        href={`/dashboard/automations?triggerType=stage_entered&pipelineId=${encodeURIComponent(editorPipelineId)}&stageId=${encodeURIComponent(selectedStageId)}&emailDestination=company`}
                        className="mt-2 inline-block text-[11px] text-brand-700 hover:text-brand-900 underline-offset-2 hover:underline"
                      >
                        + Add notification →
                      </a>
                    )}
                  </div>
                </div>
              </Card>

              <Card padding={20}>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-semibold text-[14px] text-ink">In this stage</h2>
                  {stageCandidates.length > 0 && (
                    <Link
                      href={`/dashboard/candidates?pipelineId=${editorPipeline.id}&status=${selectedStage.id}`}
                      className="text-[12px] text-grey-35 hover:text-ink underline"
                    >
                      Open in kanban
                    </Link>
                  )}
                </div>
                {stageCandidatesLoading ? (
                  <div className="text-[13px] text-grey-35">Loading…</div>
                ) : stageCandidates.length === 0 ? (
                  <div className="text-[13px] text-grey-35">No candidates currently in this stage.</div>
                ) : (
                  <ul className="space-y-1.5">
                    {stageCandidates.map((c) => (
                      <li key={c.id}>
                        <Link
                          href={`/dashboard/candidates/${c.id}`}
                          className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-[8px] hover:bg-surface-light"
                        >
                          <span className="text-[13px] text-ink truncate">{c.candidateName || 'Anonymous'}</span>
                          {c.flow && (
                            <span className="text-[11px] text-grey-35 truncate shrink-0 max-w-[120px]">{c.flow.name}</span>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          )}
        </>
      )}

      {/* === Existing pipeline library section, kept under its own header === */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-[15px] text-ink">Pipeline library</h2>
          <p className="text-[12px] text-grey-35">Create, rename, archive, and reassign flows across pipelines.</p>
        </div>
      </div>

      <Card padding={20} className="mb-6">
        <h2 className="font-semibold text-[14px] text-ink mb-3">New pipeline</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Pipeline name (e.g. Dispatcher, Cleaner)"
            className="flex-1 min-w-[200px] px-3 py-2 border border-surface-border rounded-[10px] text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 bg-white"
            onKeyDown={(e) => { if (e.key === 'Enter') create() }}
          />
          <select
            value={seedFromId}
            onChange={(e) => setSeedFromId(e.target.value)}
            className="px-3 py-2 border border-surface-border rounded-[10px] text-[13px] text-ink bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            title="Copy stages from an existing pipeline as a starting point"
          >
            <option value="">Start from platform defaults</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>Copy stages from "{p.name}"</option>
            ))}
          </select>
          <Button variant="primary" size="sm" onClick={create} disabled={creating || !newName.trim()}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </Card>

      {loading ? (
        <div className="text-center py-10 text-grey-40 text-sm">Loading…</div>
      ) : (
        <div className="space-y-4">
          {pipelines.map((p) => {
            const isBusy = busyId === p.id
            const assigned = flows.filter((f) => f.pipelineId === p.id)
            const fallbackFlows = p.isDefault ? flows.filter((f) => f.pipelineId === null) : []
            const allAssigned = [...assigned, ...fallbackFlows]
            return (
              <Card key={p.id} padding={20}>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2 min-w-0">
                    {renameTarget?.id === p.id ? (
                      <input
                        type="text"
                        value={renameTarget.name}
                        onChange={(e) => setRenameTarget({ id: p.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') rename(p.id, renameTarget!.name)
                          if (e.key === 'Escape') setRenameTarget(null)
                        }}
                        className="px-2 py-1 border border-surface-border rounded-[8px] text-[14px] font-semibold text-ink"
                        autoFocus
                      />
                    ) : (
                      <h3 className="font-semibold text-[15px] text-ink truncate">{p.name}</h3>
                    )}
                    {p.isDefault && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-medium border border-amber-200">
                        Default
                      </span>
                    )}
                    <span className="font-mono text-[11px] text-grey-40 tabular-nums">
                      {p.stages.length} stage{p.stages.length === 1 ? '' : 's'} · {allAssigned.length} flow{allAssigned.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {renameTarget?.id === p.id ? (
                      <>
                        <button onClick={() => rename(p.id, renameTarget.name)} disabled={isBusy} className="text-xs px-3 py-1 rounded-[8px] bg-ink text-white">Save</button>
                        <button onClick={() => setRenameTarget(null)} className="text-xs px-3 py-1 rounded-[8px] text-grey-40 hover:text-ink">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => setSetupTarget(p)}
                          className="text-xs px-3 py-1 rounded-[8px] border border-surface-border text-grey-35 hover:border-grey-50 hover:text-ink"
                          title="Edit stages, movement rules, and actions for this pipeline"
                        >
                          Set up
                        </button>
                        <button
                          onClick={() => setRenameTarget({ id: p.id, name: p.name })}
                          className="text-xs px-3 py-1 rounded-[8px] border border-surface-border text-grey-35 hover:border-grey-50 hover:text-ink"
                        >
                          Rename
                        </button>
                        {!p.isDefault && (
                          <button
                            onClick={() => makeDefault(p.id)}
                            disabled={isBusy}
                            className="text-xs px-3 py-1 rounded-[8px] border border-surface-border text-grey-35 hover:border-grey-50 hover:text-ink"
                            title="Promote this pipeline to default. Flows with no explicit pipeline assignment will use it."
                          >
                            Make default
                          </button>
                        )}
                        {!p.isDefault && (
                          <button
                            onClick={() => requestDelete(p)}
                            disabled={isBusy}
                            className="text-xs px-3 py-1 rounded-[8px] text-red-600 hover:bg-red-50"
                          >
                            Delete
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/*
                  Rule-based movement (V2 internally). When on, candidates
                  moving through this pipeline are driven by explicit
                  movement rules (PipelineTransitionRule) defined per stage
                  in the Stages drawer, instead of the legacy auto-move
                  config. Off by default — pipelines with no movement rules
                  MUST stay off or candidates get stuck.
                */}
                <div className="flex items-center justify-between gap-2 mb-3 px-3 py-2 rounded-[10px] bg-surface-light border border-surface-divider">
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-ink">
                      Rule-based movement
                    </div>
                    <div className="text-[11px] text-grey-40 leading-snug mt-0.5">
                      When enabled, candidates move automatically only when a movement rule matches.
                      If no rule matches, candidates stay in their current stage.
                      Edit movement rules per stage from the kanban &rarr; Stages.
                    </div>
                  </div>
                  <label className="shrink-0 inline-flex items-center gap-2 cursor-pointer">
                    <span className="text-[11px] text-grey-35">{p.transitionsV2Enabled ? 'On' : 'Off'}</span>
                    <input
                      type="checkbox"
                      checked={p.transitionsV2Enabled}
                      onChange={(e) => toggleV2(p.id, e.target.checked)}
                      className="h-4 w-4"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap gap-1.5 mb-4">
                  {p.stages.map((s) => {
                    // Natural endpoints don't need entry triggers — `new` is
                    // where every candidate starts; `hired` / `rejected` are
                    // terminal manual moves. Surface the warning only on
                    // mid-funnel stages that have no triggers configured.
                    const isEndpoint = s.id === 'new' || s.id === 'hired' || s.id === 'rejected'
                    const missingTriggers = !isEndpoint && (s.triggers?.length ?? 0) === 0
                    return (
                      <span
                        key={s.id}
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] ${
                          missingTriggers
                            ? 'bg-amber-50 border border-amber-200 text-amber-900'
                            : 'bg-surface-light border border-surface-border text-grey-15'
                        }`}
                        title={missingTriggers ? 'No entry trigger configured — candidates won’t auto-advance into this stage' : undefined}
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
                        {s.label}
                        {missingTriggers && <span className="ml-0.5 text-amber-700 font-medium" aria-hidden="true">!</span>}
                      </span>
                    )
                  })}
                </div>

                {/*
                  Entry-trigger warning. A pipeline whose stages all have empty
                  `triggers` won't auto-advance candidates on system events
                  (meeting_scheduled, training_completed, etc.) — the kanban
                  card stays put and recruiters have to drag it manually. New
                  pipelines created from platform defaults start in this state;
                  the warning is what reminds you to wire the entry triggers
                  via the Stages drawer.
                */}
                {!p.stages.some((s) => (s.triggers?.length ?? 0) > 0) && (
                  <div className="mb-4 px-3 py-2.5 rounded-[10px] bg-amber-50 border border-amber-200 text-amber-800 text-[12px] leading-snug">
                    <div className="font-medium mb-0.5">No stage entry triggers configured</div>
                    <div className="text-amber-700">
                      Candidates won&apos;t auto-advance between columns on system events (meeting scheduled, training completed, etc.).{' '}
                      <Link href="/dashboard/candidates" className="underline hover:text-amber-900">
                        Open kanban
                      </Link>{' '}
                      with this pipeline selected and click <b>Stages</b> to wire entry triggers.
                    </div>
                  </div>
                )}

                <div>
                  <div className="font-mono text-[10px] uppercase text-grey-50 mb-2" style={{ letterSpacing: '0.1em' }}>
                    Assigned flows
                  </div>
                  {allAssigned.length === 0 ? (
                    <div className="text-xs text-grey-40">No flows assigned yet.</div>
                  ) : (
                    <ul className="space-y-1.5">
                      {allAssigned.map((f) => (
                        <li key={f.id} className="flex items-center justify-between gap-2 text-sm">
                          <span className="text-grey-15">
                            {f.name}
                            {f.pipelineId === null && p.isDefault && (
                              <span className="ml-2 text-[10px] text-grey-50">(via fallback)</span>
                            )}
                          </span>
                          <select
                            value={f.pipelineId ?? ''}
                            onChange={(e) => reassignFlow(f.id, e.target.value === '' ? null : e.target.value)}
                            className="text-xs px-2 py-1 border border-surface-border rounded-[8px] text-grey-35 bg-white"
                          >
                            <option value="">Use default</option>
                            {pipelines.map((opt) => (
                              <option key={opt.id} value={opt.id}>{opt.name}{opt.isDefault ? ' (default)' : ''}</option>
                            ))}
                          </select>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}


      {/* Stage Settings drawer — same component the kanban uses. Mounted
          here so a pipeline can be configured immediately after create
          (auto-opens via setSetupTarget in `create()`) and re-opened
          per-card via the "Set up" button. candidateCounts is empty here
          because we don't fetch per-stage counts on the pipelines page;
          the drawer only uses it for the delete-stage reassignment UI. */}
      <StageSettingsDrawer
        open={setupTarget !== null}
        onClose={() => setSetupTarget(null)}
        pipelineId={setupTarget?.id ?? null}
        pipelineName={setupTarget?.name}
        transitionsV2Enabled={setupTarget?.transitionsV2Enabled ?? false}
        stages={setupTarget?.stages ?? []}
        candidateCounts={{}}
        onSaved={(nextStages) => {
          // Mirror the saved stages back onto the in-memory list so the
          // stage chips update without a full /api/pipelines refetch. The
          // drawer's own save flow doesn't close the drawer on success
          // when there's a backfill preview, so we leave the close to it.
          if (setupTarget) {
            setPipelines((prev) => prev.map((row) =>
              row.id === setupTarget.id ? { ...row, stages: nextStages } : row,
            ))
          }
        }}
      />


      {/* Delete confirmation modal — typed-input guard so an accidental
          click on Delete cannot destroy a pipeline. Default pipeline is
          gated upstream in requestDelete + on the server. */}
      {deleteTarget && (() => {
        const target = deleteTarget
        const flowCount = flows.filter((f) => f.pipelineId === target.id).length
        const fallback = pipelines.find((x) => x.isDefault)
        const fallbackName = fallback?.name ?? 'default'
        const canDelete = deleteConfirmInput === 'DELETE' && busyId !== target.id
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-5 bg-black/40"
            onMouseDown={() => setDeleteTarget(null)}
          >
            <div
              className="bg-white rounded-[12px] shadow-xl w-full max-w-[440px] p-5"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <h3 className="font-semibold text-[15px] text-ink mb-1">Delete pipeline?</h3>
              <p className="text-[13px] text-grey-35 mb-3">
                Pipeline: <strong className="text-ink">{target.name}</strong>
              </p>
              <p className="text-[12px] text-grey-40 leading-snug mb-3">
                This deletes the pipeline&apos;s stages, movement rules, and actions.
                Existing candidates stay in place; flows pointing here fall back to the
                <strong> {fallbackName}</strong> pipeline.
              </p>
              {flowCount > 0 && (
                <div className="mb-3 px-3 py-2 rounded-[10px] bg-amber-50 border border-amber-100 text-amber-900 text-[12px] leading-snug">
                  <strong>{flowCount}</strong> flow{flowCount === 1 ? '' : 's'} currently route candidates to this pipeline.
                  Those candidates will start landing on the {fallbackName} pipeline instead.
                </div>
              )}
              <label className="block text-[12px] text-grey-15 mb-1.5">
                Type <code className="px-1 bg-surface-light rounded font-mono text-[11px]">DELETE</code> to confirm:
              </label>
              <input
                type="text"
                value={deleteConfirmInput}
                onChange={(e) => setDeleteConfirmInput(e.target.value)}
                placeholder="DELETE"
                autoFocus
                className="w-full px-3 py-2 mb-4 border border-surface-border rounded-[10px] text-[13px] text-ink font-mono focus:outline-none focus:ring-2 focus:ring-red-500/40"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setDeleteTarget(null)}
                  disabled={busyId === target.id}
                  className="text-xs px-3 py-2 rounded-[8px] text-grey-35 hover:text-ink hover:bg-surface-light"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDelete}
                  disabled={!canDelete}
                  className="text-xs px-4 py-2 rounded-[8px] bg-red-600 text-white font-medium hover:bg-red-700 disabled:bg-grey-50/40 disabled:text-grey-40 disabled:cursor-not-allowed"
                >
                  {busyId === target.id ? 'Deleting…' : 'Delete pipeline'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
