/**
 * Candidates — kanban view with user-configurable funnel stages.
 *
 * Stages are stored on Workspace.settings.funnelStages and managed inline via
 * StageSettingsDrawer (gear icon in the page header). Drag-drop writes the
 * stage's id straight into Session.pipelineStatus.
 *
 * Legacy hardcoded statuses (passed, scheduled, training_completed, etc.)
 * still flow into the right default stage via mapLegacyStatusToStageId, so
 * existing candidates render correctly even before the workspace customizes.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Badge, Button, Card, PageHeader, WipBadge } from '@/components/design'
import { CandidateDrawer, type CandidateDrawerCandidate } from './_CandidateDrawer'
import {
  DEFAULT_FUNNEL_STAGES,
  type FunnelStage,
  normalizeStages,
  resolveStage,
} from '@/lib/funnel-stages'
import {
  STATUS_DISPLAY,
  DISPOSITION_DISPLAY,
  normalizeCustomStatuses,
  type CandidateStatus,
  type CandidateDispositionReason,
  type CustomStatus,
} from '@/lib/candidate-status'
import {
  BUILTIN_CANDIDATE_SOURCES,
  normalizeCustomSources,
} from '@/lib/sources'
import { StageSettingsDrawer } from './_StageSettingsDrawer'
import { StatusSettingsDrawer } from './_StatusSettingsDrawer'

interface Candidate {
  id: string; candidateName: string | null; candidateEmail: string | null; candidatePhone: string | null
  outcome: string | null; pipelineStatus: string | null; rejectionReason: string | null
  status: CandidateStatus | null
  dispositionReason: CandidateDispositionReason | null
  stalledAt: string | null; lostAt: string | null; hiredAt: string | null
  startedAt: string; finishedAt: string | null
  source: string | null; addedManually: boolean; answerCount: number; submissionCount: number
  trainingStatus: string | null; trainingCompletedAt: string | null
  schedulingEvents: number; lastSchedulingEvent: string | null
  flow: { id: string; name: string } | null
  ad: { id: string; name: string; source: string } | null
  isRebook?: boolean
  nextMeetingAt?: string | null
  interestingAt?: string | null
  // Most recent past timeline event (training/scheduling/automation), summarized
  // server-side so the card can show "where this candidate is right now"
  // without each row pulling its own timeline.
  latestStep?: { label: string; at: string } | null
}

// Status tabs above the kanban. The "Active" tab — the default view —
// includes both 'active' and 'waiting' so candidates parked waiting for an
// external action (e.g. a training to be scheduled) still show up. "All"
// disables the filter entirely. Order roughly mirrors the candidate
// lifecycle so recruiters can scan left to right. Each tab carries its
// own accent color (matching the status tone vocabulary) so the row reads
// as a colored legend at a glance.
//
// `BUILT_IN_STATUS_TABS` is the static set; `useStatusTabs(customStatuses)`
// inside the component splices in workspace-defined custom-status tabs
// after Hired and before Lost, so the final All tab stays last.
type StatusTab = { key: string; label: string; statuses: string[] | null; color: string }
const BUILT_IN_STATUS_TABS: StatusTab[] = [
  { key: 'active',  label: 'Active',  statuses: ['active', 'waiting'], color: 'var(--brand-primary)' },
  { key: 'stalled', label: 'Stalled', statuses: ['stalled'],            color: '#D97706'             },
  { key: 'nurture', label: 'Nurture', statuses: ['nurture'],            color: 'var(--neutral-fg)'   },
  { key: 'hired',   label: 'Hired',   statuses: ['hired'],              color: 'var(--success-fg)'   },
  { key: 'lost',    label: 'Lost',    statuses: ['lost'],               color: 'var(--danger-fg)'    },
  { key: 'all',     label: 'All',     statuses: null,                   color: 'var(--neutral-fg)'   },
]
const STATUS_TONE_TO_COLOR: Record<string, string> = {
  neutral: 'var(--neutral-fg)',
  brand:   'var(--brand-primary)',
  success: 'var(--success-fg)',
  warn:    '#D97706',
  info:    '#2563EB',
  danger:  'var(--danger-fg)',
}
function buildStatusTabs(customStatuses: CustomStatus[]): StatusTab[] {
  const customTabs: StatusTab[] = customStatuses.map((c) => ({
    key: c.id,
    label: c.label,
    statuses: [c.id],
    color: STATUS_TONE_TO_COLOR[c.tone] ?? 'var(--neutral-fg)',
  }))
  // Splice custom tabs in before "All" so All stays the last entry.
  const allIdx = BUILT_IN_STATUS_TABS.findIndex((t) => t.key === 'all')
  if (allIdx === -1) return [...BUILT_IN_STATUS_TABS, ...customTabs]
  return [
    ...BUILT_IN_STATUS_TABS.slice(0, allIdx),
    ...customTabs,
    ...BUILT_IN_STATUS_TABS.slice(allIdx),
  ]
}

// Built-in sources used by the candidate "Add" modal and pipeline filter come
// from the shared @/lib/sources module — same source of truth as the Ads
// page (with 'manual' added for hand-created candidates).
const BUILTIN_SOURCES = BUILTIN_CANDIDATE_SOURCES

// Background tint for the disposition pill, keyed by the candidate's
// current status. Pulls the existing rejection-pill (red) and adds amber
// for stalled — same color vocabulary as the funnel stage tones.
const DISPOSITION_TINT: Partial<Record<CandidateStatus, { bg: string; text: string; border: string }>> = {
  stalled: { bg: 'bg-amber-50',  text: 'text-amber-800',  border: 'border-amber-200' },
  lost:    { bg: 'bg-red-50',    text: 'text-red-700',    border: 'border-red-200'   },
  hired:   { bg: 'bg-green-50',  text: 'text-green-700',  border: 'border-green-200' },
  nurture: { bg: 'bg-surface-light', text: 'text-grey-15', border: 'border-surface-border' },
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!isFinite(ms) || ms < 0) return null
  return Math.floor(ms / (24 * 60 * 60 * 1000))
}

// Compact "X ago" for the per-card latest-step line. Coarsens up the unit so
// the card stays narrow ("3h", "2d", "5w") instead of wrapping.
function shortAgo(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!isFinite(ms) || ms < 0) return null
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  return `${w}w ago`
}

interface Flow { id: string; name: string; pipelineId?: string | null }
interface PipelineSummary {
  id: string
  name: string
  isDefault: boolean
  stages: FunnelStage[]
  flowCount: number
  transitionsV2Enabled: boolean
}

const STAGE_SORT_KEY = 'hiringflow:kanban-stage-sorts'

export default function CandidatesPage() {
  const router = useRouter()
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [flows, setFlows] = useState<Flow[]>([])
  const [stages, setStages] = useState<FunnelStage[]>(DEFAULT_FUNNEL_STAGES)
  // Pipelines list for the workspace. Pipeline picker controls which stage
  // set (kanban columns) is shown — different roles (Cleaner with onboarding
  // vs. Dispatcher without) get different layouts. The selected pipeline's
  // stages override the legacy Workspace.settings.funnelStages.
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([])
  // Hydrate the picker synchronously from localStorage so the first
  // /api/candidates fetch goes out with the right pipeline filter — otherwise
  // we render ALL candidates for one tick, then re-fetch once pipelines load,
  // which looked like a 10s glitch on slow networks.
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      const saved = window.localStorage.getItem('hiringflow:pipeline')
      // 'all' is a sentinel for "no pipeline filter" — store it as null so
      // the request goes out without a pipelineId param.
      if (!saved || saved === 'all') return null
      return saved
    } catch { return null }
  })
  // Gate the first candidates fetch until the pipelines list resolves — covers
  // first-time visitors (no localStorage value) so they don't get a momentary
  // "all candidates" flash before the default pipeline kicks in.
  const [pipelinesLoaded, setPipelinesLoaded] = useState(false)
  // Cached count of PipelineTransitionRule rows for the selected pipeline.
  // Drives the "rule-based movement is on but no movement rules" warning on
  // the empty-state setup card. Null = not yet fetched (or no pipeline);
  // -1 = fetch failed (treated as "unknown", warning suppressed).
  const [selectedPipelineRuleCount, setSelectedPipelineRuleCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [flowFilter, setFlowFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  // Stage filter — narrows the list to a single funnel stage (kanban column).
  // Stage ids are pipeline-scoped, so this resets whenever the pipeline
  // selection changes. Most useful in table view; in kanban it just empties
  // the other columns, which is fine.
  const [stageFilter, setStageFilter] = useState('')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  // Toggle: when true, only show recruiter-starred candidates (interestingAt
  // not null). Persisted in localStorage so the recruiter's shortlist view
  // sticks across refreshes.
  const [interestingOnly, setInterestingOnly] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [hoverCol, setHoverCol] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [statusSettingsOpen, setStatusSettingsOpen] = useState(false)
  const [customStatuses, setCustomStatuses] = useState<CustomStatus[]>([])
  const [customSources, setCustomSources] = useState<string[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  // Right-side quick-preview drawer. Opens when the recruiter clicks a
  // candidate card; the existing full-detail page at /dashboard/candidates/[id]
  // is still available via the "Open full detail" CTA at the bottom of the
  // drawer. State lives at the page level so the drawer survives sort/filter
  // re-renders.
  const [previewCandidate, setPreviewCandidate] = useState<CandidateDrawerCandidate | null>(null)
  // View mode toggle. Kanban is the default; table is a flat list with
  // checkboxes for bulk operations (move-to-stage, delete) and sortable
  // columns. Persisted so the recruiter's preferred view sticks across
  // sessions.
  const [view, setView] = useState<'kanban' | 'table'>(() => {
    if (typeof window === 'undefined') return 'kanban'
    try {
      const saved = window.localStorage.getItem('hiringflow:candidates-view')
      return saved === 'table' ? 'table' : 'kanban'
    } catch { return 'kanban' }
  })
  // Table-view state — selection set for bulk actions and column sort.
  // Selection clears whenever the filtered candidate list changes so we
  // never carry an id that's no longer visible.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<'name' | 'email' | 'status' | 'stage' | 'flow' | 'source' | 'startedAt' | 'nextMeetingAt'>('startedAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  // Per-stage sort direction. 'asc' = oldest first (FIFO follow-up — the
  // current default), 'desc' = newest first. Persisted in localStorage so
  // the choice survives page reloads. Stages without an entry default to asc.
  const [stageSorts, setStageSorts] = useState<Record<string, 'asc' | 'desc'>>({})
  // Status tab — controls which candidates render on the board. Default is
  // 'active', which the API maps to status IN ('active','waiting'). 'all'
  // disables the filter. Persisted in localStorage so the tab survives
  // refreshes (recruiters who live on the Stalled tab get to keep it).
  const [statusTab, setStatusTab] = useState<string>('active')
  // Counts keyed by built-in CandidateStatus AND custom status ids. The
  // tab strip reads this map; a missing key renders as 0.
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({
    active: 0, waiting: 0, stalled: 0, nurture: 0, lost: 0, hired: 0,
  })
  // A card must be explicitly clicked ("picked up") before its drag handle
  // activates. Until then the card is treated as part of the board so the
  // mousedown initiates a horizontal pan instead of an HTML5 drag.
  const [selectedCard, setSelectedCard] = useState<string | null>(null)
  // Bulk email modal — opened from the table view's bulk action footer.
  // Recipients are whatever ids are in selectedIds at open time.
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false)

  // Click-and-drag horizontal pan on the kanban background. Skips when the
  // mousedown originates on a *selected* card (data-card is set conditionally)
  // or any interactive element so card DnD and buttons keep working.
  const kanbanRef = useRef<HTMLDivElement | null>(null)
  const panState = useRef<{ startX: number; startScroll: number } | null>(null)
  const movedDuringPan = useRef(false)
  const [panning, setPanning] = useState(false)

  const onPanMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-card], button, a, input, select, textarea, [data-no-pan]')) return
    const el = kanbanRef.current
    if (!el) return
    panState.current = { startX: e.clientX, startScroll: el.scrollLeft }
    movedDuringPan.current = false
    setPanning(true)
  }

  useEffect(() => {
    if (!panning) return
    const onMove = (ev: MouseEvent) => {
      const el = kanbanRef.current
      const ps = panState.current
      if (!el || !ps) return
      if (Math.abs(ev.clientX - ps.startX) > 3) movedDuringPan.current = true
      el.scrollLeft = ps.startScroll - (ev.clientX - ps.startX)
    }
    const onUp = () => { panState.current = null; setPanning(false) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [panning])

  // Esc cancels the current pickup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedCard(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // When kanban is mounted and a stage filter is active, scroll the matching
  // column into view. Without this, switching from list-with-stage-filter back
  // to kanban can leave the filtered stage far off-screen on the right and
  // the recruiter sees an empty board until they pan over manually.
  useEffect(() => {
    if (view !== 'kanban' || !stageFilter) return
    const scroll = () => {
      const el = kanbanRef.current?.querySelector(`[data-stage-column="${CSS.escape(stageFilter)}"]`) as HTMLElement | null
      if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    }
    const raf = requestAnimationFrame(scroll)
    return () => cancelAnimationFrame(raf)
  }, [view, stageFilter, stages])

  // Auto-scroll the board horizontally while a card is being dragged near
  // (or past) either edge. Native HTML5 drag won't pan the container on its
  // own, so we track the cursor via `drag` + `dragover` and bump scrollLeft
  // each frame.
  //
  // Why disable scroll-snap during the drag: the kanban has `snap-x` and
  // each column has `snap-start`. With snap on, every programmatic
  // scrollLeft write was getting reverted back to the previous snap point,
  // so the board never actually moved. Restoring snap on dragend.
  useEffect(() => {
    if (!dragging) return
    const el = kanbanRef.current
    if (!el) return
    const prevSnap = el.style.scrollSnapType
    el.style.scrollSnapType = 'none'
    let pointerX = -1
    let raf = 0
    const EDGE = 140
    const MAX_SPEED = 32
    const onMove = (ev: DragEvent) => {
      if (ev.clientX === 0 && ev.clientY === 0) return
      pointerX = ev.clientX
    }
    const tick = () => {
      if (pointerX >= 0) {
        const rect = el.getBoundingClientRect()
        const distLeft = pointerX - rect.left
        const distRight = rect.right - pointerX
        if (distLeft < EDGE) {
          const factor = Math.min(1, Math.max(0, 1 - distLeft / EDGE))
          el.scrollLeft -= MAX_SPEED * factor
        } else if (distRight < EDGE) {
          const factor = Math.min(1, Math.max(0, 1 - distRight / EDGE))
          el.scrollLeft += MAX_SPEED * factor
        }
      }
      raf = requestAnimationFrame(tick)
    }
    // Safety net: if the dragged card unmounts mid-drag (e.g. after drop the
    // card moves columns and React swaps DOM nodes), its onDragEnd never
    // fires. A window-level dragend reliably clears the state.
    const onDragEnd = () => { setDragging(null); setHoverCol(null); setSelectedCard(null) }
    window.addEventListener('dragover', onMove, true)
    window.addEventListener('drag', onMove, true)
    window.addEventListener('dragend', onDragEnd, true)
    window.addEventListener('drop', onDragEnd, true)
    raf = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('dragover', onMove, true)
      window.removeEventListener('drag', onMove, true)
      window.removeEventListener('dragend', onDragEnd, true)
      window.removeEventListener('drop', onDragEnd, true)
      cancelAnimationFrame(raf)
      el.style.scrollSnapType = prevSnap
    }
  }, [dragging])

  useEffect(() => {
    fetch('/api/flows').then((r) => r.json()).then(setFlows).catch(() => {})
    // Pull workspace settings for status / source customizations only. Stages
    // come from the selected pipeline now (see the pipelines fetch below).
    fetch('/api/workspace/settings')
      .then((r) => r.json())
      .then((d) => {
        const settings = (d?.settings as { customStatuses?: unknown; customSources?: unknown } | null) ?? null
        setCustomStatuses(normalizeCustomStatuses(settings?.customStatuses))
        setCustomSources(normalizeCustomSources(settings?.customSources))
      })
      .catch(() => {})
    // Pipelines + initial stage selection. The default pipeline always
    // exists (auto-created on first read). Restore the last-picked pipeline
    // from localStorage if it's still around; otherwise fall back to the
    // workspace default. Stages tracked separately so per-pipeline column
    // editing stays a single source of truth.
    fetch('/api/pipelines')
      .then((r) => r.json())
      .then((rows: PipelineSummary[]) => {
        setPipelines(rows)
        let initialId: string | null = null
        let useAll = false
        try {
          const saved = localStorage.getItem('hiringflow:pipeline')
          if (saved === 'all') useAll = true
          else if (saved && rows.find((p) => p.id === saved)) initialId = saved
        } catch {}
        if (useAll) {
          setSelectedPipelineId(null)
          const def = rows.find((p) => p.isDefault) ?? rows[0]
          if (def) setStages(def.stages)
        } else {
          if (!initialId) initialId = rows.find((p) => p.isDefault)?.id ?? rows[0]?.id ?? null
          setSelectedPipelineId(initialId)
          const picked = rows.find((p) => p.id === initialId)
          if (picked) setStages(picked.stages)
        }
        setPipelinesLoaded(true)
      })
      .catch(() => { setPipelinesLoaded(true) })
    // Restore per-stage sort prefs from prior visits.
    try {
      const raw = localStorage.getItem(STAGE_SORT_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const cleaned: Record<string, 'asc' | 'desc'> = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (v === 'asc' || v === 'desc') cleaned[k] = v
        }
        setStageSorts(cleaned)
      }
    } catch {}
    // Restore the previously-selected tab. We can't validate against
    // workspace custom statuses here yet (they're loaded async above), but
    // any unknown saved tab is harmless — buildStatusTabs always renders
    // the active/built-in set, and we just won't highlight a missing tab.
    try {
      const raw = localStorage.getItem('hiringflow:status-tab')
      if (raw) setStatusTab(raw)
    } catch {}
  }, [])

  useEffect(() => {
    try { localStorage.setItem('hiringflow:status-tab', statusTab) } catch {}
  }, [statusTab])

  useEffect(() => {
    try { localStorage.setItem('hiringflow:candidates-view', view) } catch {}
  }, [view])

  // Drop the selection set whenever the filter inputs change (or the user
  // flips between kanban and table). The selected ids would otherwise refer
  // to rows that may no longer be in the visible list.
  useEffect(() => {
    setSelectedIds(new Set())
  }, [view, statusTab, flowFilter, sourceFilter, stageFilter, search, interestingOnly, selectedPipelineId])

  // Stage ids are scoped to a pipeline; switching pipelines invalidates
  // whatever stage was selected.
  useEffect(() => {
    setStageFilter('')
  }, [selectedPipelineId])

  // Debounce the search input → search state so results refresh as the
  // recruiter types instead of requiring Enter / blur. 250ms is fast enough
  // to feel live, slow enough to dedupe per-keystroke fetches. We trim so a
  // stray leading/trailing space (e.g. paste from clipboard) doesn't blank
  // the result list — DB names occasionally have trailing whitespace too.
  useEffect(() => {
    const trimmed = searchInput.trim()
    if (trimmed === search) return
    const t = window.setTimeout(() => setSearch(trimmed), 250)
    return () => window.clearTimeout(t)
  }, [searchInput, search])

  // Movement-rule count for the selected pipeline. Only fetched when
  // rule-based movement is on — under legacy mode the count is meaningless
  // (V1 stage triggers live on the stage row, not in this table). Drives
  // the "no movement rules" warning on the empty-state setup card.
  useEffect(() => {
    if (!selectedPipelineId) { setSelectedPipelineRuleCount(null); return }
    const picked = pipelines.find((p) => p.id === selectedPipelineId)
    if (!picked?.transitionsV2Enabled) { setSelectedPipelineRuleCount(null); return }
    let cancelled = false
    fetch(`/api/pipelines/${selectedPipelineId}/transition-rules`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: unknown[]) => { if (!cancelled) setSelectedPipelineRuleCount(Array.isArray(rows) ? rows.length : -1) })
      .catch(() => { if (!cancelled) setSelectedPipelineRuleCount(-1) })
    return () => { cancelled = true }
  }, [selectedPipelineId, pipelines])

  // Whenever the pipeline selection changes, persist + swap the visible
  // stage list. Stages drive every kanban column header / drop target so
  // this is the chokepoint — no other code path should setStages.
  useEffect(() => {
    try { localStorage.setItem('hiringflow:pipeline', selectedPipelineId ?? 'all') } catch {}
    if (selectedPipelineId === null) {
      // "All" pipelines — keep showing the default pipeline's columns so
      // cards from any pipeline still have somewhere to land.
      const def = pipelines.find((p) => p.isDefault) ?? pipelines[0]
      if (def) setStages(def.stages)
      return
    }
    const picked = pipelines.find((p) => p.id === selectedPipelineId)
    if (picked) setStages(picked.stages)
  }, [selectedPipelineId, pipelines])

  const setStageSort = (stageId: string, direction: 'asc' | 'desc') => {
    setStageSorts((cur) => {
      const next = { ...cur, [stageId]: direction }
      try { localStorage.setItem(STAGE_SORT_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }

  const statusTabs = useMemo(() => buildStatusTabs(customStatuses), [customStatuses])

  const load = useCallback((opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    const params = new URLSearchParams()
    if (flowFilter) params.set('flowId', flowFilter)
    else if (selectedPipelineId) params.set('pipelineId', selectedPipelineId)
    if (sourceFilter) params.set('source', sourceFilter)
    if (stageFilter) params.set('status', stageFilter)
    if (search) params.set('search', search)
    if (interestingOnly) params.set('interesting', '1')
    const tab = statusTabs.find((t) => t.key === statusTab)
    if (tab && tab.statuses) params.set('candidateStatus', tab.statuses.join(','))
    fetch(`/api/candidates?${params}`)
      .then((r) => r.json())
      .then((d: Candidate[]) => { setCandidates(d); setLoading(false) })

    // Counts for the tab pills — fetched separately with the SAME flow /
    // source / search filters but no status filter, then bucketed
    // client-side. Keeps every tab's badge accurate regardless of which
    // tab is active.
    const countParams = new URLSearchParams()
    if (flowFilter) countParams.set('flowId', flowFilter)
    else if (selectedPipelineId) countParams.set('pipelineId', selectedPipelineId)
    if (sourceFilter) countParams.set('source', sourceFilter)
    if (search) countParams.set('search', search)
    fetch(`/api/candidates?${countParams}`)
      .then((r) => r.json())
      .then((all: Candidate[]) => {
        const buckets: Record<string, number> = {
          active: 0, waiting: 0, stalled: 0, nurture: 0, lost: 0, hired: 0,
        }
        for (const c of customStatuses) buckets[c.id] = 0
        for (const c of all) {
          const s = c.status ?? 'active'
          if (s in buckets) buckets[s] += 1
        }
        setStatusCounts(buckets)
      })
      .catch(() => {})
  }, [flowFilter, sourceFilter, stageFilter, search, statusTab, statusTabs, customStatuses, interestingOnly, selectedPipelineId])

  useEffect(() => {
    // Don't fire the first candidates fetch until the pipeline picker is
    // resolved — otherwise the request goes out with no pipelineId and the
    // user briefly sees candidates from every pipeline.
    if (!pipelinesLoaded) return
    load()
  }, [load, pipelinesLoaded])

  // Auto-refresh: pick up server-side stage changes (meeting_ended,
  // recording_ready, etc.) without requiring the recruiter to hard-refresh.
  // Polls every 30s while the tab is visible and refetches instantly on
  // focus. Skipped while a card is mid-drag so the optimistic update isn't
  // clobbered.
  const draggingRef = useRef(false)
  useEffect(() => { draggingRef.current = dragging !== null }, [dragging])
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      if (draggingRef.current) return
      load({ silent: true })
    }
    const onVisible = () => { if (document.visibilityState === 'visible') tick() }
    const id = window.setInterval(tick, 30_000)
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  const updateStatus = async (id: string, pipelineStatus: string) => {
    setCandidates((prev) => prev.map((c) => c.id === id ? { ...c, pipelineStatus } : c))
    await fetch(`/api/candidates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineStatus }),
    })
  }

  // Star / un-star — optimistic. Persisted as `interestingAt` (timestamp set
   // when starred, cleared when unstarred). Doesn't move the card on the
   // kanban; only changes the icon and filters when the "Interesting" toggle
   // is on.
  const toggleInteresting = async (c: Candidate) => {
    const next = !c.interestingAt
    const nextIso = next ? new Date().toISOString() : null
    const prev = candidates
    setCandidates((cur) => cur.map((x) => x.id === c.id ? { ...x, interestingAt: nextIso } : x))
    const res = await fetch(`/api/candidates/${c.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interesting: next }),
    })
    if (!res.ok) {
      setCandidates(prev)
    }
  }

  const deleteCandidate = async (c: Candidate) => {
    const name = c.candidateName || c.candidateEmail || 'this candidate'
    if (!confirm(`Delete ${name}? This permanently removes their answers, video submissions, training progress, and scheduled interviews. This cannot be undone.`)) return
    const prev = candidates
    setCandidates((cur) => cur.filter((x) => x.id !== c.id))
    const res = await fetch(`/api/candidates/${c.id}`, { method: 'DELETE' })
    if (!res.ok) {
      setCandidates(prev)
      alert('Failed to delete candidate')
    }
  }

  // Sorted candidate list for the table view. Mirrors `candidates` but
  // re-ordered by the active column. Default sort is "newest applied
  // first" — table viewers usually scan recent activity.
  const tableRows = useMemo(() => {
    const arr = [...candidates]
    const dir = sortDir === 'asc' ? 1 : -1
    const cmpStr = (a: string, b: string) => a.localeCompare(b)
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'name':           return dir * cmpStr((a.candidateName ?? '').toLowerCase(), (b.candidateName ?? '').toLowerCase())
        case 'email':          return dir * cmpStr((a.candidateEmail ?? '').toLowerCase(), (b.candidateEmail ?? '').toLowerCase())
        case 'status':         return dir * cmpStr(a.status ?? 'active', b.status ?? 'active')
        case 'stage':          return dir * cmpStr(resolveStage(a.pipelineStatus, stages).label, resolveStage(b.pipelineStatus, stages).label)
        case 'flow':           return dir * cmpStr((a.flow?.name ?? '').toLowerCase(), (b.flow?.name ?? '').toLowerCase())
        case 'source':         return dir * cmpStr((a.ad?.source || a.source || '').toLowerCase(), (b.ad?.source || b.source || '').toLowerCase())
        case 'nextMeetingAt': {
          // Rows without an upcoming meeting always sink to the bottom so
          // the columns of "scheduled" candidates stay grouped.
          const av = a.nextMeetingAt ? new Date(a.nextMeetingAt).getTime() : null
          const bv = b.nextMeetingAt ? new Date(b.nextMeetingAt).getTime() : null
          if (av === null && bv === null) return 0
          if (av === null) return 1
          if (bv === null) return -1
          return dir * (av - bv)
        }
        case 'startedAt':
        default:               return dir * (new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
      }
    })
    return arr
  }, [candidates, sortKey, sortDir, stages])

  const allSelected = tableRows.length > 0 && selectedIds.size === tableRows.length
  const someSelected = selectedIds.size > 0 && !allSelected

  const toggleRow = (id: string) => {
    setSelectedIds((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = () => {
    setSelectedIds((cur) => (cur.size === tableRows.length ? new Set() : new Set(tableRows.map((c) => c.id))))
  }
  const setSort = (k: typeof sortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'startedAt' || k === 'nextMeetingAt' ? 'desc' : 'asc') }
  }

  // Bulk move — fans out a PATCH per selected id. Optimistic so the rows
  // visibly slide to the new stage before the network round-trip lands.
  const bulkMoveToStage = async (stageId: string) => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setCandidates((prev) => prev.map((c) => (selectedIds.has(c.id) ? { ...c, pipelineStatus: stageId } : c)))
    setSelectedIds(new Set())
    await Promise.allSettled(ids.map((id) => fetch(`/api/candidates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineStatus: stageId }),
    })))
  }

  const bulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    if (!confirm(`Delete ${ids.length} candidate${ids.length === 1 ? '' : 's'}? This permanently removes their answers, video submissions, training progress, and scheduled interviews. This cannot be undone.`)) return
    setCandidates((prev) => prev.filter((c) => !selectedIds.has(c.id)))
    setSelectedIds(new Set())
    await Promise.allSettled(ids.map((id) => fetch(`/api/candidates/${id}`, { method: 'DELETE' })))
  }

  // Group candidates by resolved stage. Legacy statuses fall through to the
  // mapped default stage; unknown ids go to the first stage. Within each
  // column, candidates with an upcoming meeting always come first (soonest
  // first) so urgent interviews stay on top regardless of sort direction;
  // the rest are ordered by Session.startedAt per the per-stage preference
  // (default asc = oldest applied first).
  const grouped = useMemo(() => {
    const g: Record<string, Candidate[]> = Object.fromEntries(stages.map((s) => [s.id, []]))
    for (const c of candidates) {
      const stage = resolveStage(c.pipelineStatus, stages)
      g[stage.id].push(c)
    }
    for (const id of Object.keys(g)) {
      const dir = stageSorts[id] ?? 'asc'
      const mult = dir === 'desc' ? -1 : 1
      g[id].sort((a, b) => {
        const ma = a.nextMeetingAt ? new Date(a.nextMeetingAt).getTime() : null
        const mb = b.nextMeetingAt ? new Date(b.nextMeetingAt).getTime() : null
        if (ma !== null && mb !== null) return ma - mb
        if (ma !== null) return -1
        if (mb !== null) return 1
        return mult * (new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
      })
    }
    return g
  }, [candidates, stages, stageSorts])

  const candidateCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const s of stages) counts[s.id] = grouped[s.id]?.length ?? 0
    return counts
  }, [grouped, stages])

  return (
    <div className="-mx-6 lg:-mx-[132px] -my-6 md:-my-8 flex flex-col" style={{ height: 'calc(100vh - 60px)' }}>
      <PageHeader
        eyebrow={`${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`}
        title="Candidates"
        description="Drag the board to scroll. Click a candidate to pick it up, then drag to a new stage."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setStatusSettingsOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] border border-surface-border text-[13px] text-ink hover:bg-surface-light transition-colors"
              title="Manage statuses and stalled-detection rules"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
              </svg>
              Statuses
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] border border-surface-border text-[13px] text-ink hover:bg-surface-light transition-colors"
              title="Manage funnel stages"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Stages
            </button>
            <button
              disabled
              title="CSV/Excel export of the current filter selection — coming soon"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] border border-dashed border-grey-35 text-[13px] text-grey-35 cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
              </svg>
              Export
              <WipBadge label="WIP" />
            </button>
            <button
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] bg-brand-500 text-white font-semibold text-[13px] hover:bg-brand-600 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Candidate
            </button>
          </div>
        }
      />

      <div className="flex-1 min-h-0 flex flex-col px-8 py-5">
        {/* Pipeline switcher — each pipeline carries its own ordered stage
            list. Selecting one changes the kanban columns and limits the
            board to candidates whose flow is assigned to this pipeline.
            "+ New pipeline" jumps straight to the pipelines page where the
            recruiter can name + customize stages. */}
        {pipelines.length > 0 && (
          <div data-no-pan className="shrink-0 flex items-center gap-2 mb-3 overflow-x-auto">
            <span className="shrink-0 text-[11px] font-mono uppercase text-grey-35 tracking-wider">Pipeline</span>
            <div className="flex gap-1">
              {pipelines.map((p) => {
                const isActive = p.id === selectedPipelineId
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelectedPipelineId(p.id)}
                    className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border text-[12px] font-medium transition-colors ${
                      isActive
                        ? 'bg-ink text-white border-ink'
                        : 'bg-white text-grey-35 border-surface-border hover:border-grey-50 hover:text-ink'
                    }`}
                    title={p.isDefault ? 'Default pipeline — receives flows with no explicit pipeline assignment' : undefined}
                  >
                    {p.name}
                    <span className={`font-mono text-[10px] tabular-nums ${isActive ? 'text-white/80' : 'text-grey-50'}`}>
                      {p.flowCount}
                    </span>
                  </button>
                )
              })}
              {/* "All" pseudo-pipeline — drops the per-pipeline filter so a
                  recruiter can search a candidate across every flow without
                  hopping pipelines. Stage columns fall back to the default
                  pipeline; cards on stages from other pipelines land in the
                  first column via resolveStage. */}
              <button
                onClick={() => setSelectedPipelineId(null)}
                className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border text-[12px] font-medium transition-colors ${
                  selectedPipelineId === null
                    ? 'bg-ink text-white border-ink'
                    : 'bg-white text-grey-35 border-surface-border hover:border-grey-50 hover:text-ink'
                }`}
                title="Search every pipeline at once"
              >
                All
              </button>
            </div>
            <button
              onClick={() => setSettingsOpen(true)}
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-[8px] text-[12px] text-grey-40 hover:text-ink hover:bg-surface-light"
              title="Set up stages, movement rules, and actions for the selected pipeline"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Set up
            </button>
            <Link
              href="/dashboard/pipelines"
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-[8px] text-[12px] text-grey-40 hover:text-ink hover:bg-surface-light"
              title="Create or edit pipelines"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Manage
            </Link>
          </div>
        )}

        {/* Status tabs — orthogonal to the funnel stages. Default 'Active'
            hides stalled/lost/nurture/hired so the board only shows
            candidates currently in motion. Counts come from the count
            fetch in load() so they always reflect totals across tabs. */}
        <div data-no-pan className="shrink-0 flex gap-1 mb-3 overflow-x-auto">
          {statusTabs.map((tab) => {
            const isActive = statusTab === tab.key
            const count = tab.statuses
              ? tab.statuses.reduce((s, k) => s + (statusCounts[k] ?? 0), 0)
              : Object.values(statusCounts).reduce((s, v) => s + v, 0)
            return (
              <button
                key={tab.key}
                onClick={() => setStatusTab(tab.key)}
                style={isActive ? { background: tab.color, borderColor: tab.color } : undefined}
                className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] font-medium transition-colors ${
                  isActive
                    ? 'text-white'
                    : 'bg-white text-grey-35 border-surface-border hover:border-grey-50 hover:text-ink'
                }`}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: isActive ? 'rgba(255,255,255,0.85)' : tab.color }}
                />
                {tab.label}
                <span className={`font-mono text-[10px] tabular-nums ${isActive ? 'text-white/80' : 'text-grey-50'}`}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        {/* Filters */}
        <div className="shrink-0 flex gap-2.5 mb-5">
          <div className="relative flex-1 max-w-xs">
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSearch(searchInput.trim()) }}
              placeholder="Search by name, email, phone…"
              className="w-full pl-3 pr-8 py-2 border border-surface-border rounded-[10px] text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 bg-white"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => { setSearchInput(''); setSearch('') }}
                aria-label="Clear search"
                className="absolute top-1/2 right-2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-grey-50 hover:text-ink hover:bg-surface-light"
              >
                <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l8 8M14 6l-8 8" />
                </svg>
              </button>
            )}
          </div>
          <select
            value={flowFilter}
            onChange={(e) => setFlowFilter(e.target.value)}
            className="px-3 py-2 border border-surface-border rounded-[10px] text-[13px] text-ink bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          >
            <option value="">All flows</option>
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="px-3 py-2 border border-surface-border rounded-[10px] text-[13px] text-ink bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            title="Filter by funnel stage (kanban column)"
          >
            <option value="">All stages</option>
            {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="px-3 py-2 border border-surface-border rounded-[10px] text-[13px] text-ink bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            title="Filter by candidate source (Indeed, Facebook, etc.)"
          >
            <option value="">All sources</option>
            {BUILTIN_SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            {customSources.length > 0 && (
              <optgroup label="Custom">
                {customSources.map((s) => <option key={s} value={s}>{s}</option>)}
              </optgroup>
            )}
          </select>
          <button
            onClick={() => setInterestingOnly((v) => !v)}
            aria-pressed={interestingOnly}
            title={interestingOnly ? 'Showing only candidates you starred — click to clear' : 'Show only candidates you marked as interesting'}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] text-[13px] border focus:outline-none focus:ring-2 focus:ring-brand-500/40 ${interestingOnly ? 'bg-amber-50 border-amber-300 text-amber-800' : 'bg-white border-surface-border text-grey-35 hover:border-grey-35'}`}
          >
            <span className={interestingOnly ? 'text-amber-500' : 'text-grey-50'}>{interestingOnly ? '★' : '☆'}</span>
            Interesting
          </button>

          {/* View toggle — Kanban (default) vs. Table. Pushed to the right
              edge of the filter row so it reads as a viewport control,
              not a filter. */}
          <div data-no-pan className="ml-auto inline-flex items-center bg-surface-light border border-surface-border rounded-[10px] p-0.5">
            <button
              onClick={() => setView('kanban')}
              aria-pressed={view === 'kanban'}
              title="Kanban view"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[12px] font-medium transition-colors ${view === 'kanban' ? 'bg-white text-ink shadow-sm' : 'text-grey-35 hover:text-ink'}`}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="2.5" width="3.5" height="11" rx="0.8" />
                <rect x="6.5" y="2.5" width="3.5" height="7" rx="0.8" />
                <rect x="11" y="2.5" width="3" height="5" rx="0.8" />
              </svg>
              Kanban
            </button>
            <button
              onClick={() => setView('table')}
              aria-pressed={view === 'table'}
              title="Table view"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[12px] font-medium transition-colors ${view === 'table' ? 'bg-white text-ink shadow-sm' : 'text-grey-35 hover:text-ink'}`}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="3" width="12" height="10" rx="1" />
                <path d="M2 6.5h12M2 10h12M6 6.5v6.5" strokeLinecap="round" />
              </svg>
              Table
            </button>
          </div>
        </div>

        {loading ? (
          <div className="py-14 text-center font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>Loading…</div>
        ) : candidates.length === 0 ? (
          (() => {
            // Empty board — surface the pipeline setup CTA so a brand-new
            // pipeline (created from /dashboard/pipelines and not yet
            // configured) has a clear next step instead of "empty board, now
            // what?". The setup numbered list mirrors the Stages drawer's
            // own setup guide so the recruiter sees the same model.
            const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId)
            const v2On = selectedPipeline?.transitionsV2Enabled === true
            const v2NoRules = v2On && selectedPipelineRuleCount === 0
            return (
              <Card padding={40} className="text-center">
                <div className="w-14 h-14 mx-auto mb-4 bg-brand-50 rounded-xl flex items-center justify-center">
                  <svg className="w-7 h-7" style={{ color: 'var(--brand-primary)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <h2 className="text-[20px] font-semibold text-ink mb-1">No candidates yet</h2>
                <p className="text-grey-35 text-[14px] mb-5">
                  Candidates will appear here once they start a flow{selectedPipeline ? ` assigned to ${selectedPipeline.name}` : ''}.
                </p>
                <div className="max-w-[420px] mx-auto text-left bg-surface-light border border-surface-divider rounded-[10px] px-4 py-3 mb-5">
                  <div className="font-mono text-[10px] uppercase text-grey-50 mb-1.5" style={{ letterSpacing: '0.1em' }}>
                    Pipeline setup
                  </div>
                  <ol className="text-[12px] text-grey-15 leading-snug space-y-0.5">
                    <li><strong>1.</strong> Stages &middot; <span className="text-grey-40">columns candidates move through.</span></li>
                    <li><strong>2.</strong> Movement rules &middot; <span className="text-grey-40">when candidates automatically move.</span></li>
                    <li><strong>3.</strong> Actions &middot; <span className="text-grey-40">messages sent when candidates land.</span></li>
                    <li><strong>4.</strong> Status rules &middot; <span className="text-grey-40">stalled / lost / hired tracking.</span></li>
                  </ol>
                </div>
                {v2NoRules && (
                  <div className="max-w-[420px] mx-auto mb-4 px-3 py-2 rounded-[10px] bg-amber-50 border border-amber-100 text-amber-900 text-[12px] leading-snug text-left">
                    Rule-based movement is enabled, but this pipeline has no movement rules.
                    Candidates will not move automatically until you add some.
                  </div>
                )}
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-[10px] bg-ink text-white text-[13px] font-medium hover:bg-ink/90 transition-colors"
                  >
                    Set up pipeline
                  </button>
                  <button
                    onClick={() => setCreateOpen(true)}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-[10px] border border-surface-border text-[13px] text-ink hover:bg-surface-light transition-colors"
                  >
                    Create candidate
                  </button>
                </div>
              </Card>
            )
          })()
        ) : view === 'kanban' ? (
          <div
            ref={kanbanRef}
            onMouseDown={onPanMouseDown}
            onClick={(e) => {
              // Drop the pickup on a real background click — but not when the
              // click is the tail of a pan gesture (mouse moved before mouseup).
              if (movedDuringPan.current) { movedDuringPan.current = false; return }
              const t = e.target as HTMLElement
              if (t.closest('[data-card-body]')) return
              setSelectedCard(null)
            }}
            className={`flex-1 min-h-0 flex gap-3.5 overflow-x-auto overflow-y-hidden -mx-2 px-2 snap-x select-none transition-[opacity,filter] duration-150 ${
              panning
                ? 'cursor-grabbing [&_*]:!cursor-grabbing opacity-80 brightness-90'
                : 'cursor-grab'
            }`}
          >
            {stages.map((stage) => {
              const items = grouped[stage.id] ?? []
              const isHover = hoverCol === stage.id
              return (
                <div
                  key={stage.id}
                  data-stage-column={stage.id}
                  onDragOver={(e) => { e.preventDefault(); setHoverCol(stage.id) }}
                  onDragLeave={() => setHoverCol((cur) => (cur === stage.id ? null : cur))}
                  onDrop={(e) => {
                    e.preventDefault()
                    const id = e.dataTransfer.getData('text/candidate-id')
                    // Clear drag state here too — when the card is moved to a
                    // different column the source DOM node unmounts and its
                    // onDragEnd may not fire, leaving `dragging` stuck.
                    setHoverCol(null)
                    setDragging(null)
                    setSelectedCard(null)
                    if (!id) return
                    const current = candidates.find((c) => c.id === id)
                    if (!current) return
                    if (resolveStage(current.pipelineStatus, stages).id === stage.id) return
                    updateStatus(id, stage.id)
                  }}
                  className={`shrink-0 w-[300px] h-full snap-start rounded-[14px] border transition-all flex flex-col ${
                    isHover ? 'border-[color:var(--brand-primary)] bg-brand-50/40' : 'border-surface-border bg-white'
                  }`}
                >
                  <div className="shrink-0 px-4 py-3 border-b border-surface-divider flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: stage.color }} />
                      <div className="font-semibold text-[13px] text-ink truncate">{stage.label}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {(() => {
                        const dir = stageSorts[stage.id] ?? 'asc'
                        const next: 'asc' | 'desc' = dir === 'asc' ? 'desc' : 'asc'
                        const label = dir === 'asc' ? 'Oldest first' : 'Newest first'
                        return (
                          <button
                            data-no-pan
                            onClick={(e) => { e.stopPropagation(); setStageSort(stage.id, next) }}
                            onMouseDown={(e) => e.stopPropagation()}
                            title={`Sort by date applied: ${label}. Click to switch.`}
                            aria-label={`Toggle sort direction (currently ${label})`}
                            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-grey-35 hover:bg-surface-light hover:text-ink"
                          >
                            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              {dir === 'asc' ? (
                                <>
                                  <path d="M4 4h7" />
                                  <path d="M4 8h5" />
                                  <path d="M4 12h3" />
                                  <path d="M12 4v8" />
                                  <path d="M14 10l-2 2-2-2" />
                                </>
                              ) : (
                                <>
                                  <path d="M4 4h3" />
                                  <path d="M4 8h5" />
                                  <path d="M4 12h7" />
                                  <path d="M12 12V4" />
                                  <path d="M14 6l-2-2-2 2" />
                                </>
                              )}
                            </svg>
                          </button>
                        )
                      })()}
                      <div className="font-mono text-[11px] text-grey-35" style={{ letterSpacing: '0.06em' }}>
                        {items.length}
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2">
                    {items.length === 0 ? (
                      <div className="text-center py-8 font-mono text-[10px] uppercase text-grey-50" style={{ letterSpacing: '0.12em' }}>
                        Drop here
                      </div>
                    ) : items.map((c) => {
                      const isSelected = selectedCard === c.id
                      return (
                        <div
                          key={c.id}
                          data-card-body
                          {...(isSelected ? { draggable: true, 'data-card': true } : {})}
                          onClick={(e) => {
                            const t = e.target as HTMLElement
                            if (t.closest('a, button')) return
                            setSelectedCard((cur) => (cur === c.id ? null : c.id))
                          }}
                          onDragStart={(e) => {
                            if (!isSelected) { e.preventDefault(); return }
                            e.dataTransfer.setData('text/candidate-id', c.id)
                            e.dataTransfer.effectAllowed = 'move'
                            setDragging(c.id)
                          }}
                          onDragEnd={() => { setDragging(null); setHoverCol(null); setSelectedCard(null) }}
                          className={`group relative rounded-[10px] border bg-white p-3 transition-shadow ${
                            isSelected
                              ? 'border-[color:var(--brand-primary)] ring-2 ring-[color:var(--brand-primary)]/40 shadow-[0_4px_12px_rgba(255,149,0,0.18)] cursor-grab active:cursor-grabbing'
                              : 'border-surface-border cursor-pointer hover:shadow-[0_2px_6px_rgba(26,24,21,0.06)]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <div className="flex items-center gap-1 pr-6 min-w-0">
                              <button
                                onClick={(e) => { e.stopPropagation(); toggleInteresting(c) }}
                                onMouseDown={(e) => e.stopPropagation()}
                                draggable={false}
                                className={`shrink-0 text-[14px] leading-none ${c.interestingAt ? 'text-amber-500 hover:text-amber-600' : 'text-grey-50 hover:text-amber-500'}`}
                                title={c.interestingAt ? 'Remove from interesting' : 'Mark as interesting'}
                                aria-pressed={!!c.interestingAt}
                              >
                                {c.interestingAt ? '★' : '☆'}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setPreviewCandidate({
                                    id: c.id,
                                    candidateName: c.candidateName,
                                    candidateEmail: c.candidateEmail,
                                    pipelineStatus: c.pipelineStatus,
                                    status: c.status,
                                    flow: c.flow,
                                    startedAt: c.startedAt,
                                    nextMeetingAt: c.nextMeetingAt,
                                    latestStep: c.latestStep,
                                  })
                                }}
                                onMouseDown={(e) => e.stopPropagation()}
                                draggable={false}
                                className="font-medium text-[13px] text-ink hover:text-[color:var(--brand-primary)] leading-tight truncate text-left"
                                title="Open preview drawer"
                              >
                                {c.candidateName || 'Anonymous'}
                              </button>
                            </div>
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteCandidate(c) }}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="absolute top-1.5 right-1.5 w-6 h-6 flex items-center justify-center rounded-md text-grey-50 hover:text-[color:var(--danger-fg)] hover:bg-[color:var(--danger-bg)] opacity-0 group-hover:opacity-100 transition-all text-[14px] leading-none"
                              title="Delete candidate"
                              aria-label="Delete candidate"
                            >
                              ×
                            </button>
                          </div>
                          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                            {/* Status badge replaces the stage badge here —
                                the kanban column already labels the stage,
                                so showing it on every card is redundant.
                                Days-since indicator: stalled/lost/hired use
                                their lifecycle stamp; active/waiting/nurture
                                fall back to the application date so the
                                badge is uniformly "<status> · <days>d". */}
                            {(() => {
                              const rawStatus: string = c.status ?? 'active'
                              const builtin = (STATUS_DISPLAY as Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warn' | 'info' | 'danger' }>)[rawStatus]
                              const custom = customStatuses.find((cs) => cs.id === rawStatus)
                              const meta = builtin
                                ? builtin
                                : custom
                                  ? { label: custom.label, tone: custom.tone }
                                  : { label: rawStatus, tone: 'neutral' as const }
                              const stamp = rawStatus === 'stalled' ? c.stalledAt
                                : rawStatus === 'lost' ? c.lostAt
                                : rawStatus === 'hired' ? c.hiredAt
                                : c.startedAt
                              const days = daysSince(stamp)
                              return (
                                <Badge tone={meta.tone}>
                                  {meta.label}{days !== null ? ` · ${days}d` : ''}
                                </Badge>
                              )
                            })()}
                            {/* Structured disposition reason — uses humanized
                                label from DISPOSITION_DISPLAY. Tinted by
                                the candidate's current status so stalled
                                reasons read amber and lost reasons red,
                                consistent with the status badge palette. */}
                            {c.dispositionReason && DISPOSITION_DISPLAY[c.dispositionReason] && (() => {
                              const tint = DISPOSITION_TINT[(c.status ?? 'active') as CandidateStatus]
                                ?? { bg: 'bg-surface-light', text: 'text-grey-15', border: 'border-surface-border' }
                              return (
                                <span
                                  title={`Disposition: ${DISPOSITION_DISPLAY[c.dispositionReason]}`}
                                  className={`inline-flex items-center max-w-[160px] truncate text-[10px] px-2 py-0.5 rounded-full font-medium border ${tint.bg} ${tint.text} ${tint.border}`}
                                >
                                  {DISPOSITION_DISPLAY[c.dispositionReason]}
                                </span>
                              )
                            })()}
                            {c.isRebook && (
                              <span
                                title="This candidate had a prior no-show and re-booked via the follow-up invite"
                                className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium"
                              >
                                Rebook
                              </span>
                            )}
                            {c.addedManually && (
                              <span
                                title="Added manually by a recruiter (did not self-apply through a flow)"
                                className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium"
                              >
                                Manual
                              </span>
                            )}
                            {c.rejectionReason && (
                              <span
                                title={c.rejectionReason}
                                className="inline-flex items-center max-w-[150px] truncate text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium"
                              >
                                {c.rejectionReason}
                              </span>
                            )}
                          </div>
                          {c.candidateEmail && (
                            <div className="font-mono text-[10px] text-grey-35 truncate mb-1.5" style={{ letterSpacing: '0.02em' }}>
                              {c.candidateEmail}
                            </div>
                          )}
                          <div className="flex items-center gap-2 mb-2 text-[11px] text-grey-35">
                            {c.flow?.name && (
                              <span className="truncate max-w-[130px]" title={c.flow.name}>{c.flow.name}</span>
                            )}
                            {(c.source || c.ad?.source) && (
                              <>
                                {c.flow?.name && <span className="text-grey-50">·</span>}
                                <span className="capitalize">{c.ad?.source || c.source}</span>
                              </>
                            )}
                          </div>
                          {c.nextMeetingAt && (
                            <div className="mb-2 text-[11px] text-grey-15">
                              <span className="text-grey-40">Interview:</span>{' '}
                              <span className="font-medium">
                                {new Date(c.nextMeetingAt).toLocaleString(undefined, {
                                  weekday: 'short', month: 'short', day: 'numeric',
                                  hour: 'numeric', minute: '2-digit',
                                })}
                              </span>
                            </div>
                          )}
                          {/* Latest timeline step — mirrors the most recent
                              past event from the candidate detail page's
                              timeline (training / scheduling / automation
                              sends). Gives recruiters a glance at "what
                              just happened with this candidate" without
                              opening the profile. Tooltip shows the full
                              timestamp; visible body is truncated and
                              tagged with a compact "Xh ago" suffix. */}
                          {c.latestStep && (
                            <div
                              className="mb-2 text-[11px] text-grey-15 flex items-center gap-1.5 min-w-0"
                              title={`${c.latestStep.label} · ${new Date(c.latestStep.at).toLocaleString()}`}
                            >
                              <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-grey-50" aria-hidden="true" />
                              <span className="truncate">{c.latestStep.label}</span>
                              {(() => {
                                const ago = shortAgo(c.latestStep.at)
                                return ago ? (
                                  <span className="shrink-0 font-mono text-[10px] text-grey-50" style={{ letterSpacing: '0.02em' }}>
                                    {ago}
                                  </span>
                                ) : null
                              })()}
                            </div>
                          )}
                          <div className="flex items-center justify-between text-[10px] font-mono text-grey-50" style={{ letterSpacing: '0.04em' }}>
                            <span>Applied {new Date(c.startedAt).toLocaleDateString()}</span>
                            <div className="flex gap-2">
                              {c.answerCount > 0 && <span>{c.answerCount}Q</span>}
                              {c.submissionCount > 0 && <span style={{ color: 'var(--brand-fg)' }}>{c.submissionCount}🎥</span>}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col rounded-[14px] border border-surface-border bg-white overflow-hidden">
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="w-full text-[13px] border-separate border-spacing-0">
                <thead className="sticky top-0 bg-surface-light z-10">
                  <tr>
                    <th className="w-9 px-3 py-2.5 text-left border-b border-surface-divider">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = someSelected }}
                        onChange={toggleAll}
                        aria-label="Select all rows"
                        className="cursor-pointer"
                      />
                    </th>
                    <th className="w-8 px-1 py-2.5 border-b border-surface-divider"></th>
                    {([
                      { k: 'name',          label: 'Name',         w: 'min-w-[180px]' },
                      { k: 'email',         label: 'Email',        w: 'min-w-[200px]' },
                      { k: 'status',        label: 'Status',       w: 'min-w-[100px]' },
                      { k: 'stage',         label: 'Stage',        w: 'min-w-[120px]' },
                      { k: 'flow',          label: 'Flow',         w: 'min-w-[140px]' },
                      { k: 'source',        label: 'Source',       w: 'min-w-[110px]' },
                      { k: 'nextMeetingAt', label: 'Next meeting', w: 'min-w-[160px]' },
                      { k: 'startedAt',     label: 'Applied',      w: 'min-w-[110px]' },
                    ] as { k: typeof sortKey; label: string; w: string }[]).map((col) => {
                      const active = sortKey === col.k
                      return (
                        <th
                          key={col.k}
                          onClick={() => setSort(col.k)}
                          className={`${col.w} px-3 py-2.5 text-left text-[11px] font-mono uppercase border-b border-surface-divider cursor-pointer select-none hover:bg-white ${active ? 'text-ink' : 'text-grey-40'}`}
                          style={{ letterSpacing: '0.06em' }}
                          aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                        >
                          <span className="inline-flex items-center gap-1">
                            {col.label}
                            {active && (
                              <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                {sortDir === 'asc' ? <path d="M3 7l3-3 3 3" /> : <path d="M3 5l3 3 3-3" />}
                              </svg>
                            )}
                          </span>
                        </th>
                      )
                    })}
                    <th className="w-10 px-2 py-2.5 border-b border-surface-divider"></th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-6 py-12 text-center font-mono text-[11px] uppercase text-grey-40" style={{ letterSpacing: '0.1em' }}>
                        No candidates match the current filters
                      </td>
                    </tr>
                  ) : tableRows.map((c) => {
                    const checked = selectedIds.has(c.id)
                    const stage = resolveStage(c.pipelineStatus, stages)
                    const rawStatus: string = c.status ?? 'active'
                    const builtin = (STATUS_DISPLAY as Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warn' | 'info' | 'danger' }>)[rawStatus]
                    const custom = customStatuses.find((cs) => cs.id === rawStatus)
                    const statusMeta = builtin
                      ? builtin
                      : custom
                        ? { label: custom.label, tone: custom.tone }
                        : { label: rawStatus, tone: 'neutral' as const }
                    return (
                      <tr
                        key={c.id}
                        onClick={(e) => {
                          const t = e.target as HTMLElement
                          if (t.closest('a, button, input')) return
                          router.push(`/dashboard/candidates/${c.id}`)
                        }}
                        className={`group cursor-pointer transition-colors ${checked ? 'bg-brand-50/40' : 'hover:bg-surface-light'}`}
                      >
                        <td className="px-3 py-2 border-b border-surface-divider align-middle">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleRow(c.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Select ${c.candidateName || c.candidateEmail || 'candidate'}`}
                            className="cursor-pointer"
                          />
                        </td>
                        <td className="px-1 py-2 border-b border-surface-divider align-middle">
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleInteresting(c) }}
                            className={`text-[14px] leading-none ${c.interestingAt ? 'text-amber-500 hover:text-amber-600' : 'text-grey-50 hover:text-amber-500'}`}
                            title={c.interestingAt ? 'Remove from interesting' : 'Mark as interesting'}
                            aria-pressed={!!c.interestingAt}
                          >
                            {c.interestingAt ? '★' : '☆'}
                          </button>
                        </td>
                        <td className="px-3 py-2 border-b border-surface-divider align-middle">
                          <Link
                            href={`/dashboard/candidates/${c.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-medium text-[13px] text-ink hover:text-[color:var(--brand-primary)] truncate inline-block max-w-[220px]"
                          >
                            {c.candidateName || 'Anonymous'}
                          </Link>
                          <div className="flex gap-1 mt-0.5">
                            {c.isRebook && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">Rebook</span>}
                            {c.addedManually && <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">Manual</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2 border-b border-surface-divider align-middle font-mono text-[11px] text-grey-35" style={{ letterSpacing: '0.02em' }}>
                          <span className="truncate inline-block max-w-[240px]">{c.candidateEmail || '—'}</span>
                        </td>
                        <td className="px-3 py-2 border-b border-surface-divider align-middle">
                          <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                        </td>
                        <td className="px-3 py-2 border-b border-surface-divider align-middle">
                          <span className="inline-flex items-center gap-1.5 text-[12px] text-grey-15">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: stage.color }} />
                            <span className="truncate max-w-[120px]">{stage.label}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2 border-b border-surface-divider align-middle text-[12px] text-grey-15">
                          <span className="truncate inline-block max-w-[160px]">{c.flow?.name ?? '—'}</span>
                        </td>
                        <td className="px-3 py-2 border-b border-surface-divider align-middle text-[12px] text-grey-15 capitalize">
                          {c.ad?.source || c.source || '—'}
                        </td>
                        <td className="px-3 py-2 border-b border-surface-divider align-middle text-[12px] text-grey-15">
                          {c.nextMeetingAt ? new Date(c.nextMeetingAt).toLocaleString(undefined, {
                            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                          }) : <span className="text-grey-50">—</span>}
                        </td>
                        <td className="px-3 py-2 border-b border-surface-divider align-middle font-mono text-[11px] text-grey-35" style={{ letterSpacing: '0.02em' }}>
                          {new Date(c.startedAt).toLocaleDateString()}
                        </td>
                        <td className="px-2 py-2 border-b border-surface-divider align-middle text-right">
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteCandidate(c) }}
                            className="w-6 h-6 inline-flex items-center justify-center rounded-md text-grey-50 hover:text-[color:var(--danger-fg)] hover:bg-[color:var(--danger-bg)] opacity-0 group-hover:opacity-100 transition-all text-[14px] leading-none"
                            title="Delete candidate"
                            aria-label="Delete candidate"
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Bulk action bar — appears as a sticky footer inside the
                table container whenever rows are selected. Move-to-stage
                fans out PATCHes; Delete fans out DELETEs. Both are
                optimistic so the table updates before the network
                resolves. */}
            {selectedIds.size > 0 && (
              <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-t border-surface-divider bg-white">
                <span className="text-[12px] text-ink font-medium">
                  {selectedIds.size} selected
                </span>
                <div className="flex items-center gap-1.5 ml-2">
                  <span className="text-[11px] font-mono uppercase text-grey-40" style={{ letterSpacing: '0.08em' }}>Move to</span>
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) bulkMoveToStage(e.target.value) }}
                    className="px-2.5 py-1.5 border border-surface-border rounded-[8px] text-[12px] bg-white text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                  >
                    <option value="">Choose stage…</option>
                    {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </div>
                <button
                  onClick={() => setBulkEmailOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] border border-surface-border text-[12px] text-ink hover:bg-surface-light transition-colors"
                  title="Compose a one-off email to all selected candidates"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3.5" width="12" height="9" rx="1.2" />
                    <path d="M2.5 4.5l5.5 4 5.5-4" />
                  </svg>
                  Email
                </button>
                <button
                  onClick={bulkDelete}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] border border-red-200 text-[12px] text-[color:var(--danger-fg)] hover:bg-[color:var(--danger-bg)] transition-colors"
                >
                  Delete
                </button>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="ml-auto text-[12px] text-grey-40 hover:text-ink"
                >
                  Clear
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <StageSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        pipelineId={selectedPipelineId}
        pipelineName={pipelines.find((p) => p.id === selectedPipelineId)?.name ?? 'Default'}
        transitionsV2Enabled={pipelines.find((p) => p.id === selectedPipelineId)?.transitionsV2Enabled ?? false}
        stages={stages}
        candidateCounts={candidateCounts}
        onSaved={(next) => {
          setStages(next)
          // Mirror the saved stages onto the in-memory pipelines list so
          // the switcher's flow counts / column tooltips stay accurate
          // without a full refetch.
          if (selectedPipelineId) {
            setPipelines((cur) => cur.map((p) =>
              p.id === selectedPipelineId ? { ...p, stages: next } : p,
            ))
          }
          load()
        }}
      />

      <StatusSettingsDrawer
        open={statusSettingsOpen}
        onClose={() => setStatusSettingsOpen(false)}
        initialCustomStatuses={customStatuses}
        onSaved={(next) => {
          setCustomStatuses(next.customStatuses)
          load()
        }}
      />

      <BulkEmailModal
        open={bulkEmailOpen}
        onClose={() => setBulkEmailOpen(false)}
        recipients={candidates.filter((c) => selectedIds.has(c.id))}
        onSent={() => { setBulkEmailOpen(false); setSelectedIds(new Set()) }}
      />

      <NewCandidateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        flows={flows}
        stages={stages}
        defaultFlowId={flowFilter || flows[0]?.id || ''}
        customSources={customSources}
        onCustomSourcesChanged={setCustomSources}
        onCreated={(id) => {
          setCreateOpen(false)
          load()
          router.push(`/dashboard/candidates/${id}`)
        }}
      />
      <CandidateDrawer
        candidate={previewCandidate}
        onClose={() => setPreviewCandidate(null)}
        // Quick actions intentionally undefined for now — render disabled
        // with WIP markers. When the implementations land they get wired
        // here (move stage will call the existing pipelineStatus PATCH,
        // send-message will open the email modal, etc.).
      />
    </div>
  )
}

interface NewCandidateModalProps {
  open: boolean
  onClose: () => void
  flows: Flow[]
  stages: FunnelStage[]
  defaultFlowId: string
  customSources: string[]
  onCustomSourcesChanged: (next: string[]) => void
  onCreated: (id: string) => void
}

function NewCandidateModal({ open, onClose, flows, stages, defaultFlowId, customSources, onCustomSourcesChanged, onCreated }: NewCandidateModalProps) {
  const [flowId, setFlowId] = useState(defaultFlowId)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [stageId, setStageId] = useState(stages[0]?.id ?? 'new')
  const [source, setSource] = useState<string>('manual')
  const [sourceNote, setSourceNote] = useState('')
  const [addingSource, setAddingSource] = useState(false)
  const [newSourceName, setNewSourceName] = useState('')
  const [savingSource, setSavingSource] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setFlowId(defaultFlowId)
    setName('')
    setEmail('')
    setPhone('')
    setStageId(stages[0]?.id ?? 'new')
    setSource('manual')
    setSourceNote('')
    setAddingSource(false)
    setNewSourceName('')
    setError(null)
  }, [open, defaultFlowId, stages])

  // Persists a new custom source on Workspace.settings.customSources, dedup
  // case-insensitively against built-ins and existing customs. Reads current
  // settings first so we don't clobber other keys (funnelStages, etc.).
  const addCustomSource = async () => {
    const trimmed = newSourceName.trim()
    if (!trimmed || savingSource) return
    const existingLower = new Set([
      ...BUILTIN_SOURCES.map((s) => s.id),
      ...customSources.map((s) => s.toLowerCase()),
    ])
    if (existingLower.has(trimmed.toLowerCase())) {
      setError(`Source "${trimmed}" already exists`)
      return
    }
    setSavingSource(true)
    setError(null)
    try {
      const cur = await fetch('/api/workspace/settings').then((r) => r.json()).catch(() => ({}))
      const currentSettings = (cur?.settings && typeof cur.settings === 'object') ? cur.settings : {}
      const nextCustom = [...customSources, trimmed]
      const res = await fetch('/api/workspace/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { ...currentSettings, customSources: nextCustom } }),
      })
      if (!res.ok) throw new Error('Failed to save source')
      onCustomSourcesChanged(nextCustom)
      setSource(trimmed)
      setAddingSource(false)
      setNewSourceName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save source')
    } finally {
      setSavingSource(false)
    }
  }

  if (!open) return null

  const canSubmit = !!flowId && (name.trim() || email.trim() || phone.trim())

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flowId,
          candidateName: name,
          candidateEmail: email,
          candidatePhone: phone,
          pipelineStatus: stageId,
          source,
          sourceNote,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error || 'Failed to create candidate')
      }
      const j = await res.json()
      onCreated(j.id as string)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create candidate')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-[14px] bg-white shadow-xl border border-surface-border"
      >
        <div className="px-5 py-4 border-b border-surface-divider flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink">Add candidate</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-grey-50 hover:text-ink hover:bg-surface-light"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-3.5">
          {flows.length === 0 ? (
            <div className="text-[13px] text-grey-35">
              You need at least one flow before adding a candidate.
            </div>
          ) : (
            <>
              <div>
                <label className="block text-[12px] font-medium text-ink mb-1">Flow</label>
                <select
                  value={flowId}
                  onChange={(e) => setFlowId(e.target.value)}
                  className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                  required
                >
                  {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-[12px] font-medium text-ink mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                  className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-[12px] font-medium text-ink mb-1">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@example.com"
                  className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                />
              </div>

              <div>
                <label className="block text-[12px] font-medium text-ink mb-1">Phone</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 555 123 4567"
                  className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                />
              </div>

              <div>
                <label className="block text-[12px] font-medium text-ink mb-1">Stage</label>
                <select
                  value={stageId}
                  onChange={(e) => setStageId(e.target.value)}
                  className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                >
                  {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-[12px] font-medium text-ink mb-1">Source</label>
                <div className="flex items-center gap-2">
                  <select
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    className="flex-1 px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                  >
                    {BUILTIN_SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                    {customSources.length > 0 && (
                      <optgroup label="Custom">
                        {customSources.map((s) => <option key={s} value={s}>{s}</option>)}
                      </optgroup>
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={() => { setAddingSource(true); setNewSourceName('') }}
                    title="Add custom source"
                    className="w-9 h-9 flex items-center justify-center rounded-[10px] border border-surface-border text-grey-50 hover:text-ink hover:bg-surface-light"
                  >
                    +
                  </button>
                </div>
                {addingSource && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="text"
                      autoFocus
                      value={newSourceName}
                      onChange={(e) => setNewSourceName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addCustomSource() }
                        else if (e.key === 'Escape') { setAddingSource(false); setNewSourceName('') }
                      }}
                      placeholder="e.g. Career Fair"
                      className="flex-1 px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={() => { setAddingSource(false); setNewSourceName('') }}>Cancel</Button>
                    <Button type="button" size="sm" disabled={!newSourceName.trim() || savingSource} onClick={addCustomSource}>
                      {savingSource ? 'Saving…' : 'Add'}
                    </Button>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-[12px] font-medium text-ink mb-1">
                  Where did this lead come from? <span className="text-grey-35 font-normal">(optional)</span>
                </label>
                <textarea
                  value={sourceNote}
                  onChange={(e) => setSourceNote(e.target.value)}
                  rows={2}
                  placeholder="e.g. Referred by Maria, met at the trades expo on Apr 28"
                  className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40 resize-none"
                />
                <p className="mt-1 text-[11px] text-grey-35">
                  Saved as an internal note on the candidate.
                </p>
              </div>

              <p className="text-[11px] text-grey-35">
                At least one of name, email, or phone is required.
              </p>
            </>
          )}

          {error && (
            <div className="text-[12px] px-3 py-2 rounded-[8px] bg-[color:var(--danger-bg)] text-[color:var(--danger-fg)]">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-divider flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!canSubmit || submitting || flows.length === 0}>
            {submitting ? 'Adding…' : 'Add candidate'}
          </Button>
        </div>
      </form>
    </div>
  )
}

interface EmailTemplateLite {
  id: string
  name: string
  subject: string
  bodyHtml: string
  bodyText: string | null
}

interface BulkEmailModalProps {
  open: boolean
  onClose: () => void
  recipients: Candidate[]
  onSent: () => void
}

// One-shot recruiter email to N hand-picked candidates from the table view.
// Distinct from the automation engine: no AutomationExecution rows, no
// stage gating — straight SendGrid send through /api/candidates/bulk-email.
// The "Save as new template" button persists the composed subject + body to
// EmailTemplate so it shows up in future automation step pickers AND in
// the template dropdown on this modal — independently of sending.
function BulkEmailModal({ open, onClose, recipients, onSent }: BulkEmailModalProps) {
  const [templates, setTemplates] = useState<EmailTemplateLite[]>([])
  const [templateId, setTemplateId] = useState('')
  const [subject, setSubject] = useState('')
  const [bodyHtml, setBodyHtml] = useState('')
  const [sending, setSending] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [savedTemplateName, setSavedTemplateName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ sent: number; failed: number } | null>(null)

  useEffect(() => {
    if (!open) return
    setTemplateId('')
    setSubject('')
    setBodyHtml('')
    setSavedTemplateName(null)
    setError(null)
    setResult(null)
    fetch('/api/email-templates')
      .then((r) => r.ok ? r.json() : [])
      .then((rows: EmailTemplateLite[]) => setTemplates(Array.isArray(rows) ? rows : []))
      .catch(() => setTemplates([]))
  }, [open])

  // When the recruiter picks a saved template, prefill subject + body.
  // Re-selecting the empty option doesn't wipe the fields — they keep
  // whatever the recruiter typed, which is the expected "undo" behavior
  // for accidental selections.
  const pickTemplate = (id: string) => {
    setTemplateId(id)
    if (!id) return
    const t = templates.find((x) => x.id === id)
    if (!t) return
    setSubject(t.subject)
    setBodyHtml(t.bodyHtml)
  }

  if (!open) return null

  const withEmail = recipients.filter((c) => !!c.candidateEmail)
  const withoutEmail = recipients.length - withEmail.length
  const canSubmit = subject.trim().length > 0
    && bodyHtml.trim().length > 0
    && withEmail.length > 0

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch('/api/candidates/bulk-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: recipients.map((c) => c.id),
          subject: subject.trim(),
          bodyHtml,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error || 'Failed to send')
      }
      const j = await res.json() as { sent: number; failed: number }
      setResult({ sent: j.sent, failed: j.failed })
      // Auto-close on full success after a brief pause; if any failed, leave
      // the modal open so the recruiter sees the count and can act on it.
      if (j.failed === 0) {
        setTimeout(() => { onSent() }, 900)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  // "Save as new template" — POST the composed subject + body to
  // /api/email-templates directly so the recruiter can stash a reusable
  // copy without sending the bulk email. Prompts for a name (defaults to
  // the subject) and refreshes the template dropdown on success.
  const saveAsNewTemplate = async () => {
    if (!subject.trim() || !bodyHtml.trim() || savingTemplate) return
    const suggested = subject.trim().slice(0, 80)
    const name = window.prompt('Name this template', suggested)
    if (!name?.trim()) return
    setSavingTemplate(true)
    setError(null)
    try {
      const res = await fetch('/api/email-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), subject: subject.trim(), bodyHtml }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error || 'Failed to save template')
      }
      const saved = await res.json() as EmailTemplateLite
      setTemplates((prev) => [saved, ...prev.filter((p) => p.id !== saved.id)])
      setSavedTemplateName(saved.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template')
    } finally {
      setSavingTemplate(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-2xl rounded-[14px] bg-white shadow-xl border border-surface-border flex flex-col max-h-[90vh]"
      >
        <div className="px-5 py-4 border-b border-surface-divider flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Email candidates</h2>
            <p className="mt-0.5 text-[12px] text-grey-35">
              Sending to <strong className="text-ink">{withEmail.length}</strong> of {recipients.length} selected
              {withoutEmail > 0 && <span className="text-amber-600"> · {withoutEmail} missing email</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-grey-50 hover:text-ink hover:bg-surface-light"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3.5">
          <div>
            <label className="block text-[12px] font-medium text-ink mb-1">Start from template</label>
            <select
              value={templateId}
              onChange={(e) => pickTemplate(e.target.value)}
              className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            >
              <option value="">— Blank email —</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <p className="mt-1 text-[11px] text-grey-35">
              Picking a template prefills subject and body. Edits stay local until you Send.
            </p>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-ink mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Update from {{flow_name}}"
              className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              required
            />
          </div>

          <div>
            <label className="block text-[12px] font-medium text-ink mb-1">Body (HTML allowed)</label>
            <textarea
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              rows={10}
              placeholder={'Hi {{candidate_name}},\n\nThanks for applying…'}
              className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40 font-mono"
              required
            />
            <p className="mt-1 text-[11px] text-grey-35">
              Candidate tokens: <code className="px-1 py-0.5 bg-surface-light rounded">{'{{candidate_name}}'}</code>{' '}
              <code className="px-1 py-0.5 bg-surface-light rounded">{'{{candidate_email}}'}</code>{' '}
              <code className="px-1 py-0.5 bg-surface-light rounded">{'{{candidate_phone}}'}</code>{' '}
              <code className="px-1 py-0.5 bg-surface-light rounded">{'{{flow_name}}'}</code>{' '}
              <code className="px-1 py-0.5 bg-surface-light rounded">{'{{source}}'}</code>
            </p>
            <p className="mt-1 text-[11px] text-grey-35">
              Meeting tokens (fill only when the candidate has a booking):{' '}
              <code className="px-1 py-0.5 bg-surface-light rounded">{'{{meeting_date}}'}</code>{' '}
              <code className="px-1 py-0.5 bg-surface-light rounded">{'{{meeting_clock}}'}</code>{' '}
              <code className="px-1 py-0.5 bg-surface-light rounded">{'{{meeting_time}}'}</code>{' '}
              <code className="px-1 py-0.5 bg-surface-light rounded">{'{{meeting_link}}'}</code>
            </p>
          </div>

          <div className="border-t border-surface-divider pt-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!subject.trim() || !bodyHtml.trim() || savingTemplate}
              onClick={saveAsNewTemplate}
            >
              {savingTemplate ? 'Saving…' : 'Save as new template'}
            </Button>
            {savedTemplateName && (
              <p className="mt-2 text-[12px] text-green-700">Saved &ldquo;{savedTemplateName}&rdquo; — pick it from the template dropdown next time.</p>
            )}
          </div>

          {result && (
            <div className={`text-[12px] px-3 py-2 rounded-[8px] ${result.failed === 0 ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-800'}`}>
              Sent {result.sent}{result.failed > 0 ? ` · ${result.failed} failed` : ''}.
              {' '}Delivery status (delivered / bounced) lands on each candidate's timeline within a minute.
            </div>
          )}

          {error && (
            <div className="text-[12px] px-3 py-2 rounded-[8px] bg-[color:var(--danger-bg)] text-[color:var(--danger-fg)]">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-divider flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!canSubmit || sending}>
            {sending ? 'Sending…' : `Send to ${withEmail.length}`}
          </Button>
        </div>
      </form>
    </div>
  )
}
