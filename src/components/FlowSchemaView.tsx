'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'

interface Video {
  id: string
  filename: string
  url: string
}

interface Option {
  id: string
  optionText: string
  nextStepId: string | null
}

interface Step {
  id: string
  title: string
  videoId: string | null
  video: Video | null
  questionText: string | null
  stepOrder: number
  stepType: string
  questionType: string
  combinedWithId?: string | null
  buttonConfig?: { enabled?: boolean; text?: string; nextStepId?: string | null } | null
  hideEndArrow?: boolean
  options: Option[]
}

interface FlowSchemaViewProps {
  steps: Step[]
  startMessage?: string
  endMessage?: string
  onStepClick?: (stepId: string) => void
  onStepPreview?: (stepId: string) => void
  onDeleteStep?: (stepId: string) => void
  onOptionUpdate?: (optionId: string, data: { nextStepId: string | null }) => void
  onConnectSteps?: (fromStepId: string, toStepId: string) => void
  onChangeFirstStep?: (stepId: string) => void
  onAddStep?: () => void
  onInsertStepOnArrow?: (
    info:
      | { kind: 'option'; optionId: string; fromStepId: string; toStepId: string }
      | { kind: 'button'; fromStepId: string; toStepId: string }
      | { kind: 'start'; toStepId: string }
      | { kind: 'end'; fromStepId: string }
  ) => void
  onButtonConfigUpdate?: (stepId: string, nextStepId: string | null) => void
  onClearStartScreen?: () => void
  onClearEndScreen?: () => void
  // Suppress THIS step's implicit End arrow (leaf step). Only affects the
  // arrow for the given step — other leaves and the End card itself stay
  // put. Called when the recruiter presses Delete on an implicit End arrow.
  onSuppressEndArrow?: (stepId: string) => void
  // Combine two existing steps into a "combined" pair — one screen with
  // both. Fires when the recruiter has multi-selected exactly 2 cards
  // and clicks the Combine action.
  onCombineSteps?: (aId: string, bId: string) => void
  selectedStepId?: string | null
  // Persisted canvas layout from the server: { [stepId | '__start__' | '__end__']: {x,y} }.
  // When provided on first render (or when the prop reference changes), those
  // positions are used instead of the BFS-computed defaults.
  initialPositions?: Record<string, { x: number; y: number }> | null
  // Fired after a drag finishes (single card or group) with the full current
  // positions map. The parent can debounce + persist to the DB.
  onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void
}

interface NodePos {
  x: number
  y: number
}

type InteractionMode =
  | { type: 'idle' }
  | { type: 'panning'; startX: number; startY: number; panStartX: number; panStartY: number }
  | { type: 'dragging'; stepId: string; offsetX: number; offsetY: number; startScreenX: number; startScreenY: number }
  | { type: 'dragging_group'; stepIds: string[]; offsets: Record<string, { x: number; y: number }> }
  | { type: 'marquee'; startCx: number; startCy: number; currentCx: number; currentCy: number }
  | { type: 'connecting'; fromStepId: string; fromX: number; fromY: number; mouseX: number; mouseY: number }
  | { type: 'reconnecting'; optionId: string; fromStepId: string; fromX: number; fromY: number; mouseX: number; mouseY: number }
  | { type: 'reconnecting_source'; optionId: string; targetStepId: string; toX: number; toY: number; mouseX: number; mouseY: number }
  | { type: 'reconnecting_button'; fromStepId: string; fromX: number; fromY: number; mouseX: number; mouseY: number }
  | { type: 'reconnecting_button_source'; oldFromStepId: string; targetStepId: string; toX: number; toY: number; mouseX: number; mouseY: number }
  | { type: 'reconnecting_start'; fromX: number; fromY: number; mouseX: number; mouseY: number }
  | { type: 'reconnecting_end'; fromStepId: string; fromX: number; fromY: number; mouseX: number; mouseY: number }

interface SelectedArrow {
  optionId: string
  stepId: string
  kind?: 'option' | 'start' | 'end' | 'button'
}

const BUTTON_ARROW_SENTINEL = '__button_arrow__'
const SELECTED_COLOR = '#2563eb' // blue-600 — clearly distinct from the orange default
const HOVER_COLOR = '#111827'    // gray-900 — hover state, distinct from both default and selected

// Trace helper for debugging user-reported flow builder issues. Every
// mutation and mode transition is logged with a [flow] prefix and inline
// JSON so the user can filter DevTools console and paste back. Rip these
// out once the current investigation is done.
const flowTrace = (topic: string, data?: unknown) => {
  const payload = data !== undefined
    ? ' ' + (() => { try { return JSON.stringify(data) } catch { return '[unserializable]' } })()
    : ''
  // eslint-disable-next-line no-console
  console.log(`[flow] ${topic}${payload}`)
}

const NODE_W = 280
const THUMB_H = 140
const NODE_H = 30 + THUMB_H + 40 // 210: title bar + thumb + answer bar
const PORT_R = 8
const H_GAP = 120
const V_GAP = 70

// Single output port on the right side of the card
function getOutputPort(pos: NodePos, w = NODE_W, h = NODE_H): { x: number; y: number } {
  return { x: pos.x + w, y: pos.y + h / 2 }
}

function getInputPort(pos: NodePos, _w = NODE_W, h = NODE_H): { x: number; y: number } {
  return { x: pos.x, y: pos.y + h / 2 }
}

function getOptionOutputY(step: Step, optionIndex: number, pos: NodePos, h = NODE_H): number {
  const count = step.options.length
  if (count <= 1) return pos.y + h / 2
  const margin = 30
  const range = h - margin * 2
  return pos.y + margin + (optionIndex / (count - 1)) * range
}

function dist(x1: number, y1: number, x2: number, y2: number) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
}

const START_ID = '__start__'
const END_ID = '__end__'
const SPECIAL_W = 160
const SPECIAL_H = 80

export default function FlowSchemaView({
  steps,
  startMessage,
  endMessage,
  onStepClick,
  onStepPreview,
  onDeleteStep,
  onOptionUpdate,
  onConnectSteps,
  onChangeFirstStep,
  onAddStep,
  onInsertStepOnArrow,
  onButtonConfigUpdate,
  onClearStartScreen,
  onClearEndScreen,
  onSuppressEndArrow,
  onCombineSteps,
  selectedStepId,
  initialPositions,
  onPositionsChange,
}: FlowSchemaViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [positions, setPositions] = useState<Record<string, NodePos>>(() => initialPositions ?? {})
  // Track which initialPositions snapshot we've already absorbed, so a
  // subsequent fetch returning the same data doesn't clobber user edits.
  const hydratedFromRef = useRef<typeof initialPositions>(initialPositions ?? null)
  useEffect(() => {
    if (!initialPositions) return
    if (hydratedFromRef.current === initialPositions) return
    hydratedFromRef.current = initialPositions
    setPositions((prev) => {
      // Merge — keep any in-memory positions for steps that weren't saved yet,
      // overlay with the freshly-loaded saved positions.
      return { ...prev, ...initialPositions }
    })
  }, [initialPositions])
  const [thumbnails, setThumbnails] = useState<Record<string, HTMLCanvasElement>>({})
  const [screenImages, setScreenImages] = useState<Record<string, HTMLImageElement>>({}) // stepId -> loaded image for screen steps
  const [videoAspects, setVideoAspects] = useState<Record<string, number>>({}) // stepId -> width/height ratio
  const [pan, setPan] = useState({ x: 40, y: 40 })
  const [scale, setScale] = useState(1)
  const [debugConnections, setDebugConnections] = useState(false)
  const [mode, setMode] = useState<InteractionMode>({ type: 'idle' })
  const [hoveredPort, setHoveredPort] = useState<string | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  // Cards selected via right-drag marquee. Persists after the drag ends so
  // the user can then left-drag any one of them to move the whole group.
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set())
  const [hoveredArrow, setHoveredArrow] = useState<
    | { kind: 'option'; optionId: string; fromStepId: string }
    | { kind: 'button'; fromStepId: string }
    | { kind: 'start' }
    | { kind: 'end'; fromStepId: string }
    | null
  >(null)
  const [selectedArrow, setSelectedArrow] = useState<SelectedArrow | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; optionId: string; stepId: string } | null>(null)
  // Port-click popup: shown when the user clicks (without dragging) an
  // output or input port. Lists all other steps + End (for output) so the
  // user can pick a target instead of dragging a connection.
  const [portPicker, setPortPicker] = useState<
    | { screenX: number; screenY: number; kind: 'out'; fromStepId: string }
    | { screenX: number; screenY: number; kind: 'in'; targetStepId: string }
    | null
  >(null)

  // Refs for animation loop access
  const posRef = useRef(positions)
  posRef.current = positions
  const modeRef = useRef(mode)
  modeRef.current = mode
  // Wheel handler is registered once (useEffect [] deps) but needs current
  // pan/scale to zoom around the cursor position. Read via refs so we
  // don't re-register on every pan/scale change.
  const panRef = useRef(pan)
  panRef.current = pan
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  // Port mousedown → pending state (no draft yet). Promotes to a proper
  // `connecting` mode only after the cursor drifts past DRAFT_MIN_DRIFT.
  // A quick click-and-release (no drift) resolves as the port picker.
  type PendingPort = {
    kind: 'out' | 'in'
    stepId: string
    startCx: number
    startCy: number
    startScreenX: number
    startScreenY: number
  }
  const pendingPortRef = useRef<PendingPort | null>(null)
  // Fit-on-mount: when the view opens (component mounts) fit the whole
  // flow into the viewport so the user sees everything without hunting.
  // Guarded by a ref so we only auto-fit ONCE per mount — subsequent
  // step edits shouldn't yank the user's view.
  const hasAutoFittedRef = useRef(false)

  // Combined-pair port re-anchoring. When step A is combined with a
  // partner B (A.combinedWithId = B) and B sits to the right of A in
  // the canvas, the visual "combined box" is [A ⋅ B]. Connections
  // OUT of the pair should leave from B's right port (rightmost),
  // connections IN should enter A's left port (leftmost). Data (which
  // step owns the connection) is unchanged — only rendering shifts.
  const getVisualRightmost = useCallback((stepId: string): string => {
    const step = steps.find((s) => s.id === stepId)
    if (!step) return stepId
    const partnerId = (step as any).combinedWithId as string | null | undefined
    if (partnerId) {
      const sp = positions[stepId]
      const pp = positions[partnerId]
      if (sp && pp && pp.x > sp.x) return partnerId
    }
    // Also check reverse pairing: some other step declares us as its partner.
    const reverse = steps.find((s) => (s as any).combinedWithId === stepId)
    if (reverse) {
      const sp = positions[stepId]
      const rp = positions[reverse.id]
      if (sp && rp && rp.x > sp.x) return reverse.id
    }
    return stepId
  }, [steps, positions])
  const getVisualLeftmost = useCallback((stepId: string): string => {
    const step = steps.find((s) => s.id === stepId)
    if (!step) return stepId
    const partnerId = (step as any).combinedWithId as string | null | undefined
    if (partnerId) {
      const sp = positions[stepId]
      const pp = positions[partnerId]
      if (sp && pp && pp.x < sp.x) return partnerId
    }
    const reverse = steps.find((s) => (s as any).combinedWithId === stepId)
    if (reverse) {
      const sp = positions[stepId]
      const rp = positions[reverse.id]
      if (sp && rp && rp.x < sp.x) return reverse.id
    }
    return stepId
  }, [steps, positions])
  // In-app confirmation modal. Replaces browser confirm() so the dialog
  // matches the app chrome instead of the OS/browser default.
  const [confirmDialog, setConfirmDialog] = useState<
    | { title: string; description?: string; confirmLabel: string; destructive?: boolean; onConfirm: () => void }
    | null
  >(null)

  // Keyboard: Delete/Backspace deletes selected step
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

        flowTrace('key.delete', { selectedArrow, selectedStepId })

        // Arrow selection wins over step selection — clicking an arrow
        // doesn't clear the previously-selected step, so if we let step
        // deletion take priority, users trying to delete a connection
        // get asked about the unrelated step they'd clicked earlier.
        if (selectedArrow) {
          e.preventDefault()
          const arrow = selectedArrow
          setConfirmDialog({
            title: 'Remove this connection?',
            confirmLabel: 'Remove',
            destructive: true,
            onConfirm: () => {
              flowTrace('key.delete.arrow.confirm', { kind: arrow.kind })
              if (arrow.kind === 'end') {
                // Explicit button→__end__ just clears the button target.
                // Implicit end arrow: set hideEndArrow=true on THIS step so
                // only its arrow disappears; End card and other leaves' End
                // arrows stay put.
                const src = steps.find((s) => s.id === arrow.stepId)
                const isExplicitButtonToEnd =
                  (src as any)?.buttonConfig?.nextStepId === '__end__'
                flowTrace('key.delete.arrow.end', {
                  stepId: arrow.stepId,
                  isExplicitButtonToEnd,
                  action: isExplicitButtonToEnd ? 'onButtonConfigUpdate(null)' : 'onSuppressEndArrow(stepId)',
                })
                if (isExplicitButtonToEnd) {
                  onButtonConfigUpdate?.(arrow.stepId, null)
                } else {
                  onSuppressEndArrow?.(arrow.stepId)
                }
              } else if (arrow.kind === 'button') {
                flowTrace('key.delete.arrow.button', { stepId: arrow.stepId })
                onButtonConfigUpdate?.(arrow.stepId, null)
              } else if (arrow.kind === 'start') {
                flowTrace('key.delete.arrow.start')
                onClearStartScreen?.()
              } else if (arrow.kind === 'option' || !arrow.kind) {
                flowTrace('key.delete.arrow.option', { optionId: (arrow as any).optionId })
                onOptionUpdate?.((arrow as any).optionId, { nextStepId: null })
              }
              setSelectedArrow(null)
            },
          })
        } else if (selectedStepId && selectedStepId !== START_ID && selectedStepId !== END_ID) {
          // Only delete if the step actually exists in the current steps array
          const stepExists = steps.some(s => s.id === selectedStepId)
          if (!stepExists) {
            flowTrace('key.delete.step.skipped', { reason: 'step not in current list', selectedStepId })
            return
          }
          e.preventDefault()
          const sid = selectedStepId
          const stepTitle = steps.find((s) => s.id === sid)?.title || 'this step'
          setConfirmDialog({
            title: 'Delete this step?',
            description: `"${stepTitle}" and every connection touching it will be removed. Candidate history on this step will also be deleted.`,
            confirmLabel: 'Delete',
            destructive: true,
            onConfirm: () => {
              flowTrace('key.delete.step.confirm', { selectedStepId: sid })
              onDeleteStep?.(sid)
            },
          })
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedStepId, selectedArrow, onDeleteStep, onOptionUpdate, onButtonConfigUpdate, onClearStartScreen, onClearEndScreen, onSuppressEndArrow])

  // Trace selection changes so we know what's selected when the user hits Delete.
  useEffect(() => {
    flowTrace('selection.arrow', selectedArrow)
  }, [selectedArrow])
  useEffect(() => {
    flowTrace('selection.step', { selectedStepId })
  }, [selectedStepId])
  // Trace mode transitions so we can tell if a drag/reconnect/pan actually
  // ended (mode → idle) or is stuck. Only logs kind, not full mode object,
  // to keep the stream readable.
  useEffect(() => {
    flowTrace('mode', { type: mode.type })
  }, [mode.type])

  // Find terminal options (options with no nextStepId) and submission steps
  const getTerminalOptionIds = useCallback(() => {
    const ids: string[] = []
    for (const step of steps) {
      if (step.stepType === 'submission') continue // submission steps are terminal by nature
      for (const opt of step.options) {
        if (!opt.nextStepId) ids.push(opt.id)
      }
    }
    return ids
  }, [steps])

  // Implicit "End" arrows connect from every reachable step that has no
  // forward connections — i.e. every leaf of the flow's reachable graph.
  // Multiple branches can each terminate in End independently.
  const getEndStepIds = useCallback((): Set<string> => {
    const result = new Set<string>()
    if (steps.length === 0) return result
    const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
    const reachable = new Set<string>()
    const queue = [sorted[0].id]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (reachable.has(id)) continue
      reachable.add(id)
      const step = steps.find((s) => s.id === id)
      if (!step) continue
      for (const o of step.options) {
        if (o.nextStepId && o.nextStepId !== '__end__' && !reachable.has(o.nextStepId)) {
          queue.push(o.nextStepId)
        }
      }
      const btn = step.buttonConfig?.nextStepId
      if (btn && btn !== '__end__' && !reachable.has(btn)) queue.push(btn)
    }
    reachable.forEach((id) => {
      const step = steps.find((s) => s.id === id)
      if (!step) return
      const hasOptionForward = step.options.some(
        (o) => o.nextStepId && o.nextStepId !== '__end__'
      )
      const btn = step.buttonConfig?.nextStepId
      const hasButtonForward = !!btn && btn !== '__end__'
      if (!hasOptionForward && !hasButtonForward) result.add(id)
    })
    return result
  }, [steps])

  // Backward-compat single-step variant: pick the one with highest stepOrder
  // among the terminal set. Used by the End-arrow click selection path.
  const getEndStepId = useCallback((): string | null => {
    const ids = getEndStepIds()
    if (ids.size === 0) return null
    const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (ids.has(sorted[i].id)) return sorted[i].id
    }
    return null
  }, [steps, getEndStepIds])

  // "Tidy" layout — path decomposition.
  //   Row 0: start from the earliest step (by stepOrder), follow its
  //          primary successor chain (button → first option → nothing)
  //          across the canvas until it terminates or hits a step
  //          that's already placed.
  //   Row 1..N: pick the next unplaced step and start a new chain
  //          underneath. Rinse and repeat until every step has a slot.
  //   Column count is the longest row; End sits one column past that.
  const computeTidyLayout = useCallback((): Record<string, NodePos> => {
    if (steps.length === 0) {
      return {
        [START_ID]: { x: 0, y: 0 },
        [END_ID]: { x: SPECIAL_W + H_GAP, y: 0 },
      }
    }
    const posMap: Record<string, NodePos> = {}
    const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
    const stepById = new Map(sorted.map((s) => [s.id, s]))

    // Depth = length of the longest chain rooted at a given step. Follow
    // every option/button (not just the first) and take the max, so the
    // primary chain we walk below is truly the longest, not just the
    // first-arrived. Cache + cycle-guarded.
    const depthCache = new Map<string, number>()
    const inProgress = new Set<string>()
    const depth = (id: string): number => {
      const cached = depthCache.get(id)
      if (cached !== undefined) return cached
      if (inProgress.has(id)) return 0  // cycle guard
      inProgress.add(id)
      const s = stepById.get(id)
      if (!s) { inProgress.delete(id); depthCache.set(id, 0); return 0 }
      let best = 0
      for (const o of s.options) {
        if (o.nextStepId && o.nextStepId !== '__end__' && stepById.has(o.nextStepId)) {
          best = Math.max(best, depth(o.nextStepId))
        }
      }
      const btn = (s as any).buttonConfig?.nextStepId
      if (btn && btn !== '__end__' && stepById.has(btn)) {
        best = Math.max(best, depth(btn))
      }
      const d = 1 + best
      inProgress.delete(id)
      depthCache.set(id, d)
      return d
    }

    // primarySuccessor picks whichever forward connection (button OR any
    // option) leads to the DEEPEST downstream chain — that's how row 0
    // becomes the longest possible path from the start, and how each
    // subsequent row's walk stays as long as possible.
    const primarySuccessor = (s: typeof sorted[0]): string | null => {
      const candidates: string[] = []
      const btn = (s as any).buttonConfig?.nextStepId
      if (btn && btn !== '__end__' && stepById.has(btn)) candidates.push(btn)
      for (const o of s.options) {
        if (o.nextStepId && o.nextStepId !== '__end__' && stepById.has(o.nextStepId)) candidates.push(o.nextStepId)
      }
      let best: string | null = null
      let bestDepth = -1
      for (const c of candidates) {
        const d = depth(c)
        if (d > bestDepth) { bestDepth = d; best = c }
      }
      return best
    }

    const placed = new Set<string>()
    const rawRows: string[][] = []
    for (const startStep of sorted) {
      if (placed.has(startStep.id)) continue
      const row: string[] = []
      let current: typeof sorted[0] | null = startStep
      // Walk the primary chain until it terminates or loops into a
      // placed step. Guard against pathological cycles by also
      // checking `row` (a step can appear at most once per row).
      const rowSeen = new Set<string>()
      while (current && !placed.has(current.id) && !rowSeen.has(current.id)) {
        placed.add(current.id)
        rowSeen.add(current.id)
        row.push(current.id)
        const nextId = primarySuccessor(current)
        current = nextId ? (stepById.get(nextId) ?? null) : null
      }
      rawRows.push(row)
    }

    // Row 0 = main chain (longest). Among the remaining branches, sort
    // by TOTAL DOWNSTREAM REACH of each branch's first card — not by
    // local row length. Path decomposition truncates rows when they
    // hit already-placed cards, so row.length underestimates how "big"
    // a branch really is. downstreamReach walks every option/button
    // from the branch source and counts reachable steps.
    const downstreamReach = (startId: string): number => {
      const seen = new Set<string>()
      const queue: string[] = [startId]
      while (queue.length) {
        const id = queue.shift()!
        if (seen.has(id)) continue
        seen.add(id)
        const s = stepById.get(id)
        if (!s) continue
        for (const o of s.options) {
          if (o.nextStepId && o.nextStepId !== '__end__' && !seen.has(o.nextStepId)) queue.push(o.nextStepId)
        }
        const btn = (s as any).buttonConfig?.nextStepId
        if (btn && btn !== '__end__' && !seen.has(btn)) queue.push(btn)
      }
      return seen.size
    }
    const rowsByLenDesc = [...rawRows].sort((a, b) => b.length - a.length)
    const main = rowsByLenDesc[0]
    const branchesShortFirst = rowsByLenDesc
      .slice(1)
      .sort((a, b) => downstreamReach(a[0]) - downstreamReach(b[0]))
    const rows = main ? [main, ...branchesShortFirst] : rowsByLenDesc

    const TIDY_H_GAP = 60

    // For each row (except 0), find its "branch parent" — a step in an
    // earlier row that points to this row's first card via option/button.
    // We record BOTH the parent's row index and its column so we can:
    //   - vertically stack this row just below its parent
    //   - horizontally align this row under the parent's column
    // Use the RIGHTMOST parent (largest col) to match the user's rule
    // "top the very right double connection."
    const rowParent = new Map<number, { row: number; col: number }>()
    for (let r = 1; r < rows.length; r++) {
      const firstStepId = rows[r][0]
      let best: { row: number; col: number } | null = null
      for (let pr = 0; pr < r; pr++) {
        for (let pc = 0; pc < rows[pr].length; pc++) {
          const pStep = stepById.get(rows[pr][pc])
          if (!pStep) continue
          const btn = (pStep as any).buttonConfig?.nextStepId
          const hits = btn === firstStepId ||
            pStep.options.some((o) => o.nextStepId === firstStepId)
          if (!hits) continue
          if (!best || pc > best.col) best = { row: pr, col: pc }
        }
      }
      if (best) rowParent.set(r, best)
    }

    // Per user: a branch sits under the card that comes AFTER the branch
    // source in the main chain, not under the source itself. So the
    // startCol for a branch is parent.col + 1.
    // ORPHAN rows (no incoming edge from any earlier row) use the same
    // algorithm as connected cards: place at the column matching their
    // first step's position in the overall stepOrder sequence, so they
    // sit next to where they would be if connected — not always pinned
    // to column 0.
    const stepIndexById = new Map<string, number>()
    sorted.forEach((s, i) => stepIndexById.set(s.id, i))
    const startColFor = (r: number): number => {
      const p = rowParent.get(r)
      if (p) return p.col + 1
      // Orphan: place at column derived from the first step's stepOrder
      // position (1-based to leave col 0 for Start).
      const idx = stepIndexById.get(rows[r][0]) ?? 0
      return idx
    }

    // Compute the effective ROW INDEX and COLUMN OFFSET for each row.
    // Main chain: (rowIdx=0, startCol=0).
    // Secondary: startCol = parent's col; rowIdx = parent's rowIdx + 1
    //   PLUS a collision offset — if two branches want the same slot
    //   and overlap horizontally, the later one gets pushed one row
    //   deeper. This keeps every branch just below its parent while
    //   preventing rows from stacking on top of each other.
    const rowInfo = new Map<number, { rowIdx: number; startCol: number }>()
    rowInfo.set(0, { rowIdx: 0, startCol: 0 })
    // Occupancy: for each rowIdx, which column ranges are taken.
    const rowOccupancy = new Map<number, Array<[number, number]>>()
    const claimRow = (row: string[], startCol: number): number => {
      const endCol = startCol + row.length - 1
      // Find lowest rowIdx (>= 1) that has no overlap in [startCol..endCol].
      // Row 0 is always taken by the main chain.
      let ri = 1
      while (true) {
        const ranges = rowOccupancy.get(ri) ?? []
        const overlaps = ranges.some(([a, b]) => !(endCol < a || startCol > b))
        if (!overlaps) {
          rowOccupancy.set(ri, [...ranges, [startCol, endCol]])
          return ri
        }
        ri++
      }
    }
    // Main chain claims row 0.
    rowOccupancy.set(0, [[0, rows[0].length - 1]])
    for (let r = 1; r < rows.length; r++) {
      const startCol = startColFor(r)
      const rowIdx = claimRow(rows[r], startCol)
      rowInfo.set(r, { rowIdx, startCol })
    }

    // Subtle rising staircase inside each row (matches reference).
    const RISE_PER_COL = 24
    // Base gap between rows; per-row extra padding is added on top when
    // this row is a target for long-span connections (see below).
    const TIDY_V_GAP_BASE = 100
    // Extra vertical padding per column of horizontal connection span.
    // A connection from col A to col B has to arc across |B - A| columns;
    // longer spans need more vertical breathing room so the bezier
    // clears earlier cards without clipping. 12 px per column tuned so
    // a 5-col span adds ~60 px, a 10-col span adds ~120 px.
    const SPAN_PAD_PER_COL = 12

    // Track the max bottom-Y placed in each column so far. A later row's
    // baseline in each of its columns must clear this.
    const colMaxBottom = new Map<number, number>()
    const rowBaseline = new Map<number, number>()

    // For each row, find the maximum horizontal-span of any incoming
    // connection (source in an earlier row → target in this row).
    // A wider incoming arc needs more vertical room — a bezier from
    // (sx, sy) to (tx, ty) sweeps ~half the vertical delta at midpoint,
    // so bigger horizontal span = wider arc = more room needed.
    const rowIncomingSpan = new Map<number, number>()
    for (let r = 1; r < rows.length; r++) {
      let maxSpan = 0
      for (const targetId of rows[r]) {
        for (let pr = 0; pr < r; pr++) {
          for (let pc = 0; pc < rows[pr].length; pc++) {
            const pStep = stepById.get(rows[pr][pc])
            if (!pStep) continue
            const points =
              (pStep as any).buttonConfig?.nextStepId === targetId ||
              pStep.options.some((o) => o.nextStepId === targetId)
            if (!points) continue
            const parentInfo = rowInfo.get(pr) ?? { rowIdx: pr, startCol: 0 }
            const parentCol = parentInfo.startCol + pc
            const targetInfo = rowInfo.get(r) ?? { rowIdx: r, startCol: 0 }
            const tc = rows[r].indexOf(targetId)
            const targetCol = targetInfo.startCol + Math.max(0, tc)
            const span = Math.abs(targetCol - parentCol)
            if (span > maxSpan) maxSpan = span
          }
        }
      }
      rowIncomingSpan.set(r, maxSpan)
    }

    let maxCol = 0
    let maxBaseline = 0
    rows.forEach((row, r) => {
      const info = rowInfo.get(r) ?? { rowIdx: r, startCol: 0 }
      const chainRise = (row.length - 1) * RISE_PER_COL
      // Row's effective vertical gap = base + extra padding for the
      // widest incoming connection to this row.
      const incomingSpan = rowIncomingSpan.get(r) ?? 0
      const effectiveVGap = TIDY_V_GAP_BASE + incomingSpan * SPAN_PAD_PER_COL
      let baseline: number
      if (r === 0) {
        baseline = 0
      } else {
        let req = 0
        for (let c = 0; c < row.length; c++) {
          const col = info.startCol + c
          const priorBottom = colMaxBottom.get(col) ?? -Infinity
          if (priorBottom === -Infinity) continue
          const need = priorBottom + effectiveVGap - chainRise + c * RISE_PER_COL
          if (need > req) req = need
        }
        baseline = req
      }
      rowBaseline.set(r, baseline)
      if (baseline > maxBaseline) maxBaseline = baseline
      row.forEach((stepId, c) => {
        const col = info.startCol + c
        if (col > maxCol) maxCol = col
        const y = baseline + chainRise - c * RISE_PER_COL
        posMap[stepId] = {
          x: (col + 1) * (NODE_W + TIDY_H_GAP),  // col 0 reserved for Start
          y,
        }
        const bottom = y + NODE_H
        const priorBottom = colMaxBottom.get(col) ?? -Infinity
        if (bottom > priorBottom) colMaxBottom.set(col, bottom)
      })
    })

    // Start on the far left, End one column past the rightmost card,
    // both vertically centered against the row band.
    const midY = (maxBaseline) / 2 + NODE_H / 2
    posMap[START_ID] = { x: 0, y: midY - SPECIAL_H / 2 }
    posMap[END_ID] = {
      x: (maxCol + 2) * (NODE_W + TIDY_H_GAP),
      y: midY - SPECIAL_H / 2,
    }
    return posMap
  }, [steps])

  // Compute initial layout
  const computeLayout = useCallback((): Record<string, NodePos> => {
    if (steps.length === 0) {
      // Still show start and end even with no steps
      return {
        [START_ID]: { x: 0, y: 0 },
        [END_ID]: { x: SPECIAL_W + H_GAP, y: 0 },
      }
    }

    const posMap: Record<string, NodePos> = {}
    const visited = new Set<string>()
    const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
    const stepMap = new Map(steps.map((s) => [s.id, s]))

    // Start node: one column before the first step
    const startCol = -1

    const queue: Array<{ stepId: string; col: number; row: number }> = [
      { stepId: sorted[0].id, col: 0, row: 0 },
    ]
    const colRows: Record<number, number> = {}

    while (queue.length > 0) {
      const { stepId, col, row } = queue.shift()!
      if (visited.has(stepId)) continue
      visited.add(stepId)

      const currentRow = colRows[col] ?? 0
      const actualRow = Math.max(row, currentRow)
      colRows[col] = actualRow + 1

      posMap[stepId] = {
        x: col * (NODE_W + H_GAP),
        y: actualRow * (NODE_H + V_GAP),
      }

      const step = stepMap.get(stepId)
      if (step) {
        const optionChildren = step.options
          .map((o) => o.nextStepId)
          .filter((id): id is string => !!id && id !== '__end__')
        const buttonChild = step.buttonConfig?.nextStepId
        const children = [...optionChildren, ...(buttonChild && buttonChild !== '__end__' ? [buttonChild] : [])]
          .filter((id) => !visited.has(id))
          .filter((id, i, arr) => arr.indexOf(id) === i)

        // Combined partner: treat as a "next" step in the chain so we
        // also BFS into anything it points to. Place it in the same row
        // immediately to the right (combine-snap tightens the exact X).
        const partnerId = step.combinedWithId
        if (partnerId && !visited.has(partnerId)) {
          queue.push({ stepId: partnerId, col: col + 1, row: actualRow })
        }

        children.forEach((childId, i) => {
          queue.push({ stepId: childId, col: col + 1, row: actualRow + i })
        })
      }
    }

    // Place unvisited steps
    let extraRow = 0
    const maxRow = Object.values(colRows).reduce((a, b) => Math.max(a, b), 0)
    for (const step of sorted) {
      if (!visited.has(step.id)) {
        posMap[step.id] = {
          x: 0,
          y: (maxRow + extraRow) * (NODE_H + V_GAP),
        }
        extraRow++
      }
    }

    // Place Start node to the left
    const allY = Object.values(posMap).map((p) => p.y)
    const midY = allY.length > 0 ? (Math.min(...allY) + Math.max(...allY)) / 2 : 0
    posMap[START_ID] = {
      x: startCol * (NODE_W + H_GAP) + (NODE_W - SPECIAL_W) / 2,
      y: midY + (NODE_H - SPECIAL_H) / 2,
    }

    // Place End node to the right of the rightmost column
    const maxX = Object.values(posMap)
      .filter((_, i) => Object.keys(posMap)[i] !== START_ID)
      .reduce((max, p) => Math.max(max, p.x), 0)
    posMap[END_ID] = {
      x: maxX + NODE_W + H_GAP + (NODE_W - SPECIAL_W) / 2,
      y: midY + (NODE_H - SPECIAL_H) / 2,
    }

    return posMap
  }, [steps])

  // When the selected step changes, pan the canvas to bring it into view if
  // it isn't already on-screen. Important for newly-created steps that land
  // outside the current viewport (e.g. column-0-stack for unconnected adds).
  const lastPannedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedStepId) return
    if (lastPannedRef.current === selectedStepId) return
    const pos = positions[selectedStepId]
    if (!pos) return
    const container = containerRef.current
    if (!container) return
    lastPannedRef.current = selectedStepId

    const w = container.clientWidth
    const h = container.clientHeight
    const isSpecial = selectedStepId === START_ID || selectedStepId === END_ID
    const stepW = isSpecial ? SPECIAL_W : NODE_W
    const stepH = isSpecial ? SPECIAL_H : NODE_H
    const screenX = pos.x * scale + pan.x
    const screenY = pos.y * scale + pan.y
    const screenRight = screenX + stepW * scale
    const screenBottom = screenY + stepH * scale
    const padding = 40
    const offScreen =
      screenX < padding ||
      screenY < padding ||
      screenRight > w - padding ||
      screenBottom > h - padding
    if (offScreen) {
      setPan({
        x: w / 2 - (pos.x + stepW / 2) * scale,
        y: h / 2 - (pos.y + stepH / 2) * scale,
      })
    }
    // pan/scale read directly so they're current; intentionally not in deps
    // to avoid re-firing on every pan tweak — the lastPannedRef guard is the
    // real protection against re-firing for the same step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStepId, positions])

  // Build the canonical list of option/button connections once per steps
  // change. Within a single source step, button beats option for the same
  // target and duplicate options to the same target collapse to one.
  // Connections from different source steps to the same target are KEPT
  // (they're legitimately different paths) — visual fan-out handles them.
  type Conn = {
    sourceId: string
    targetId: string
    label: string
    kind: 'option' | 'button'
    optionId?: string
  }
  const allConnections = useMemo<Conn[]>(() => {
    const result: Conn[] = []
    for (const step of steps) {
      const byTarget = new Map<string, Conn>()
      const btnNext = (step as any).buttonConfig?.nextStepId
      if (btnNext && btnNext !== '__end__') {
        byTarget.set(btnNext, {
          sourceId: step.id,
          targetId: btnNext,
          label: (step as any).buttonConfig?.text || 'Continue',
          kind: 'button',
        })
      }
      for (const option of step.options) {
        if (!option.nextStepId || option.nextStepId === '__end__') continue
        if (byTarget.has(option.nextStepId)) continue
        byTarget.set(option.nextStepId, {
          sourceId: step.id,
          targetId: option.nextStepId,
          label: option.optionText,
          kind: 'option',
          optionId: option.id,
        })
      }
      byTarget.forEach((conn) => result.push(conn))
    }
    return result
  }, [steps])

  // Stage numbers for the badge/title prefix. Computed by BFS from the
  // first step so that branches at the same depth share a number — a fork
  // counts as one step, not two. Combined partners share their primary's
  // depth (they're conceptually one step). Unreachable steps fall through
  // to sequential numbering at the end.
  const stageNumberByStep = useMemo<Map<string, number>>(() => {
    const result = new Map<string, number>()
    if (steps.length === 0) return result
    const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
    const queue: Array<{ id: string; depth: number }> = [
      { id: sorted[0].id, depth: 1 },
    ]
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!
      if (result.has(id)) continue
      result.set(id, depth)
      const step = steps.find((s) => s.id === id)
      if (!step) continue
      if (step.combinedWithId && !result.has(step.combinedWithId)) {
        queue.push({ id: step.combinedWithId, depth })
      }
      const children = new Set<string>()
      for (const o of step.options) {
        if (o.nextStepId && o.nextStepId !== '__end__') children.add(o.nextStepId)
      }
      const btn = step.buttonConfig?.nextStepId
      if (btn && btn !== '__end__') children.add(btn)
      children.forEach((childId) => {
        if (!result.has(childId)) queue.push({ id: childId, depth: depth + 1 })
      })
    }
    let nextDepth = 1
    result.forEach((d) => { if (d >= nextDepth) nextDepth = d + 1 })
    for (const s of sorted) {
      if (!result.has(s.id)) result.set(s.id, nextDepth++)
    }
    return result
  }, [steps])

  // Lane assignment for backward edges. Each backward edge gets its own
  // horizontal Y "lane" below the cards so loopbacks don't share a channel.
  // Sort by horizontal span (longest first → lowest lane) so long routes
  // tunnel under short ones rather than crossing them.
  const connKey = useCallback((c: Conn) => {
    return c.kind === 'button'
      ? `btn:${c.sourceId}:${c.targetId}`
      : `opt:${c.sourceId}:${c.optionId ?? c.targetId}`
  }, [])
  // Shared helper: for a forward connection from (fromX, fromY) to
  // (toX, toY), return a lane Y that routes the bezier around any cards
  // sitting inside the source→target corridor. The "band" the natural
  // bezier sweeps through is wider than just the endpoint Y range — for
  // connections whose endpoints have very different Y, the curve spans
  // from one Y to the other. Use the FULL endpoint Y range plus 16 px
  // padding as the band, so a card sitting anywhere between the source
  // and target row counts as a blocker.
  const computeDetourLane = useCallback(
    (fromX: number, fromY: number, toX: number, toY: number, excludeIds: Set<string>, debugLabel?: string) => {
      if (toX <= fromX) return undefined
      const minPathY = Math.min(fromY, toY) - 16
      const maxPathY = Math.max(fromY, toY) + 16
      let hasBlocker = false
      let blockerMaxBot = -Infinity
      // Track each endpoint card's Y rect separately so we only override
      // the lane when the blocker-lane would actually land INSIDE the
      // endpoint's rect (i.e. the curve would clip it). Including endpoint
      // bottoms unconditionally makes long-span lanes overshoot.
      const endpointRects: Array<{top: number; bot: number}> = []
      const dbg: Array<{title: string; role: string; x: number; y: number; bot: number; inX: boolean; inY: boolean}> = []
      for (const s of steps) {
        const p = positions[s.id]
        if (!p) continue
        const cardBot = p.y + NODE_H
        const isExcluded = excludeIds.has(s.id)
        const inX = !(p.x + NODE_W <= fromX + 4 || p.x >= toX - 4)
        const inY = !(p.y + NODE_H < minPathY || p.y > maxPathY)
        if (isExcluded) {
          endpointRects.push({ top: p.y, bot: cardBot })
          if (debugLabel) dbg.push({ title: s.title || s.id.slice(0, 6), role: 'ENDPOINT', x: Math.round(p.x), y: Math.round(p.y), bot: Math.round(cardBot), inX, inY })
          continue
        }
        if (!inX) continue
        if (debugLabel) dbg.push({ title: s.title || s.id.slice(0, 6), role: inY ? 'BLOCKER' : 'corridor', x: Math.round(p.x), y: Math.round(p.y), bot: Math.round(cardBot), inX, inY })
        if (!inY) continue
        hasBlocker = true
        if (cardBot > blockerMaxBot) blockerMaxBot = cardBot
      }
      if (!hasBlocker) {
        if (debugLabel) console.log(`[lane] ${debugLabel} no blocker → none`)
        return undefined
      }
      let laneY = blockerMaxBot + 90
      let mode = 'below-blocker'
      const intersectsEndpoint = () =>
        endpointRects.some((r) => laneY > r.top - 10 && laneY < r.bot + 10)
      if (intersectsEndpoint()) {
        // Default lane lands inside an endpoint card. Prefer routing
        // through the GAP between blockerBot and the nearest endpoint
        // top below it — much cleaner than a deep V dip below the
        // target. Only fall back to "below all endpoints" if the gap
        // is too tight to fit a curve.
        let nearestTopBelow = Infinity
        for (const r of endpointRects) {
          if (r.top > blockerMaxBot && r.top < nearestTopBelow) nearestTopBelow = r.top
        }
        const gap = nearestTopBelow - blockerMaxBot
        if (gap >= 20 && nearestTopBelow !== Infinity) {
          laneY = (blockerMaxBot + nearestTopBelow) / 2
          mode = `gap(${Math.round(gap)})`
        } else {
          let maxEndpointBot = -Infinity
          for (const r of endpointRects) if (r.bot > maxEndpointBot) maxEndpointBot = r.bot
          laneY = maxEndpointBot + 90
          mode = 'below-endpoint'
        }
      }
      if (debugLabel) {
        // eslint-disable-next-line no-console
        console.log(`[lane] ${debugLabel} from=(${Math.round(fromX)},${Math.round(fromY)}) to=(${Math.round(toX)},${Math.round(toY)}) blockerBot=${Math.round(blockerMaxBot)} mode=${mode} → laneY=${Math.round(laneY)}`)
        if (dbg.length) console.table(dbg)
      }
      return laneY
    },
    [steps, positions]
  )

  const laneYByConn = useMemo(() => {
    const m = new Map<string, number>()
    if (allConnections.length === 0) return m

    // --- 1) Forward edges that would clip through intermediate cards. ---
    // Backward edges get their natural swing bezier by default; the clip
    // resolver below adds a lane only when the swing actually crosses a
    // non-endpoint card. Previously all backward edges were dumped into a
    // flow-wide sink at maxBottom+80, which for short local loops routed
    // the curve far below all cards where the user couldn't see it.
    const titleFor = (id: string) => steps.find((s) => s.id === id)?.title ?? id.slice(0, 6)
    for (const c of allConnections) {
      const sp = positions[c.sourceId]
      const tp = positions[c.targetId]
      if (!sp || !tp) continue
      if (tp.x <= sp.x) continue
      const out = getOutputPort(sp)
      const inp = getInputPort(tp)
      const label = `"${titleFor(c.sourceId)}" → "${titleFor(c.targetId)}"`
      const lane = computeDetourLane(out.x, out.y, inp.x, inp.y, new Set([c.sourceId, c.targetId]), label)
      if (lane !== undefined) m.set(connKey(c), lane)
    }

    // --- 3) Curve-clip resolver: sample every forward bezier at 60 points;
    //         if it passes inside a non-endpoint card, push the lane below
    //         that card and re-check. Repeat up to 4 rounds.
    const clipsCard = (out: {x: number; y: number}, inp: {x: number; y: number}, laneY: number | undefined, srcId: string, tgtId: string): { bottom: number; hit: string } | null => {
      const [c1x, c1y, c2x, c2y] = laneY !== undefined
        ? (() => {
            const span = Math.abs(inp.x - out.x)
            const cpOff = Math.max(40, span * 0.4)
            return [out.x + cpOff, laneY, inp.x - cpOff, laneY] as const
          })()
        : (() => {
            const dx = Math.abs(inp.x - out.x)
            const cpOff = Math.max(dx * 0.4, 40)
            return [out.x + cpOff, out.y, inp.x - cpOff, inp.y] as const
          })()
      let worstBottom = -Infinity
      let worstTitle = ''
      for (let i = 1; i < 60; i++) {
        const t = i / 60
        const omt = 1 - t
        const bx = omt*omt*omt*out.x + 3*omt*omt*t*c1x + 3*omt*t*t*c2x + t*t*t*inp.x
        const by = omt*omt*omt*out.y + 3*omt*omt*t*c1y + 3*omt*t*t*c2y + t*t*t*inp.y
        for (const s of steps) {
          if (s.id === srcId || s.id === tgtId) continue
          const p = positions[s.id]
          if (!p) continue
          if (bx >= p.x && bx <= p.x + NODE_W && by >= p.y && by <= p.y + NODE_H) {
            const bot = p.y + NODE_H
            if (bot > worstBottom) {
              worstBottom = bot
              worstTitle = s.title || s.id.slice(0, 6)
            }
          }
        }
      }
      return worstBottom > -Infinity ? { bottom: worstBottom, hit: worstTitle } : null
    }
    for (const c of allConnections) {
      const sp = positions[c.sourceId]
      const tp = positions[c.targetId]
      if (!sp || !tp) continue
      const out = getOutputPort(sp)
      const inp = getInputPort(tp)
      // Anchor the "escape depth" at the deeper of source/target bottoms.
      // Pushing lane to (blocker.bot + 44) alone doesn't work when the
      // blocker sits at the same Y as the source: the bezier's DESCENT
      // from source Y down to the lane still passes through the blocker's
      // Y range at an X inside the blocker. Routing below the endpoints'
      // deepest bottom forces the descent to happen well past the
      // blocker's X range, so the curve clears cleanly.
      const endpointFloor = Math.max(sp.y + NODE_H, tp.y + NODE_H)
      let laneY = m.get(connKey(c))
      const trace: Array<{round: number; laneY: number | 'none'; hit: string; bottom: number | 'none'}> = []
      let resolved = true
      for (let round = 0; round < 4; round++) {
        const clip = clipsCard(out, inp, laneY, c.sourceId, c.targetId)
        trace.push({ round, laneY: laneY ?? 'none', hit: clip?.hit ?? '', bottom: clip?.bottom ?? 'none' })
        if (!clip) break
        laneY = Math.max(clip.bottom, endpointFloor) + 44
        if (round === 3) resolved = false
      }
      if (trace.length > 1 || !resolved) {
        // eslint-disable-next-line no-console
        console.warn(`[clip-resolver] "${titleFor(c.sourceId)}" → "${titleFor(c.targetId)}" ${resolved ? 'resolved' : 'STUCK'} in ${trace.length} rounds`)
        console.table(trace)
      }
      if (laneY !== undefined) m.set(connKey(c), laneY)
    }

    return m
  }, [allConnections, positions, connKey, computeDetourLane, steps])

  // Fan-in geometry for every arrow that terminates at the End node.
  // Sources sorted by source Y (top first) → each enters End at a
  // distinct Y on End's left edge matching that order. With matched
  // ordering, natural beziers don't cross. Lane Y comes from the
  // detour helper only when there's an actual blocker in the path.
  const endArrowGeomByStep = useMemo(() => {
    const m = new Map<string, { fromX: number; fromY: number; toX: number; toY: number; laneY?: number }>()
    const endPos = positions[END_ID]
    if (!endPos || endMessage === '') return m

    // End arrows are opt-in: only draw for steps whose Continue button
    // explicitly points to __end__. Implicit "leaf → End" arrows were
    // removed on request — connecting a new card no longer auto-draws
    // a line from its target to End. Recruiter must set buttonConfig
    // .nextStepId = '__end__' (via reconnect to End node) to show one.
    const sourceIds = new Set<string>()
    for (const step of steps) {
      if ((step as any).buttonConfig?.nextStepId === '__end__') {
        sourceIds.add(step.id)
      }
    }

    const sourcesSorted = Array.from(sourceIds)
      .filter((id) => !!positions[id])
      .sort((a, b) => {
        const pa = positions[a]
        const pb = positions[b]
        if (pa.y !== pb.y) return pa.y - pb.y // topmost first
        return pa.x - pb.x
      })
    const N = sourcesSorted.length
    if (N === 0) return m

    // End arrows are drawn as straight lines from source port to
    // End's left-edge center. Two straight lines with a shared
    // endpoint can only meet at that endpoint (two distinct lines
    // share at most one point) — no lane routing needed, and no
    // possibility of crossings before the hub.
    const toX = endPos.x
    const toY = endPos.y + SPECIAL_H / 2
    sourcesSorted.forEach((stepId) => {
      const sp = positions[stepId]
      const fromX = sp.x + NODE_W
      const fromY = sp.y + NODE_H / 2
      m.set(stepId, { fromX, fromY, toX, toY })
    })
    return m
  }, [positions, steps, endMessage, getEndStepIds])

  // Diagnostic log: dump every drawn connection with source/target titles
  // and coordinates whenever the toggle is on or the data changes.
  useEffect(() => {
    if (!debugConnections) return
    const titleFor = (id: string) => steps.find((s) => s.id === id)?.title ?? id.slice(0, 8)
    const rows = allConnections.map((c) => ({
      from: titleFor(c.sourceId),
      to: titleFor(c.targetId),
      kind: c.kind,
      label: c.label,
      sourceId: c.sourceId.slice(0, 8),
      targetId: c.targetId.slice(0, 8),
      optionId: c.optionId?.slice(0, 8) ?? '',
      sourceXY: positions[c.sourceId]
        ? `(${Math.round(positions[c.sourceId].x)}, ${Math.round(positions[c.sourceId].y)})`
        : '?',
      targetXY: positions[c.targetId]
        ? `(${Math.round(positions[c.targetId].x)}, ${Math.round(positions[c.targetId].y)})`
        : '?',
    }))
    // eslint-disable-next-line no-console
    console.log(`[FlowSchemaView] ${rows.length} connections`)
    // eslint-disable-next-line no-console
    console.table(rows)
  }, [debugConnections, allConnections, positions, steps])

  // Layout: preserve user-dragged positions across step edits.
  // Only recompute layout for newly-added IDs (insert/add); existing positions
  // are preserved. Combined partners are snapped adjacent regardless.
  // For newly-added "inserted" steps (exactly one source + one target, both
  // already positioned), drop them adjacent to the source and shift the
  // downstream chain right to make room.
  useEffect(() => {
    setPositions((prev) => {
      const layout = computeLayout()
      const layoutIds = Object.keys(layout)

      // Pass 1: preserve existing positions for STEPS, fall back to layout
      // for new ones. START / END are not preserved here — they're always
      // re-anchored at the chain's edges in pass 4 below so the End node
      // moves rightward when a card is added at the end of the chain.
      const merged: Record<string, NodePos> = {}
      const newIds: string[] = []
      for (const id of layoutIds) {
        if (id === START_ID || id === END_ID) continue
        if (id in prev) {
          merged[id] = prev[id]
        } else {
          merged[id] = layout[id]
          newIds.push(id)
        }
      }

      // Compute the current viewport center in canvas coordinates so a new
      // disconnected step can land where the user is actually looking.
      const container = containerRef.current
      let viewportCenter: NodePos | null = null
      if (container) {
        const w = container.clientWidth
        const h = container.clientHeight
        viewportCenter = {
          x: (w / 2 - pan.x) / scale - NODE_W / 2,
          y: (h / 2 - pan.y) / scale - NODE_H / 2,
        }
      }

      // Pass 2: for each new step, decide where it goes:
      // - Exactly one (preserved) source + one (preserved) target → slot it
      //   between them and shift the downstream chain right (mid-chain insert).
      // - Otherwise → drop at the current viewport center, then spiral
      //   outward in NODE-sized steps until we find a position that doesn't
      //   overlap any existing card. So "+ Add Step" lands where the user is
      //   looking and isn't connected to anything, but still stays clear of
      //   the other cards.
      const slot = NODE_W + H_GAP

      const overlapsExistingCard = (id: string, ax: number, ay: number) => {
        for (const s of steps) {
          if (s.id === id) continue
          const p = merged[s.id]
          if (!p) continue
          if (
            ax < p.x + NODE_W && ax + NODE_W > p.x &&
            ay < p.y + NODE_H && ay + NODE_H > p.y
          ) return true
        }
        return false
      }

      const placeWithoutOverlap = (id: string, startX: number, startY: number) => {
        if (!overlapsExistingCard(id, startX, startY)) {
          merged[id] = { x: startX, y: startY }
          return true
        }
        const dx = NODE_W + H_GAP
        const dy = NODE_H + V_GAP
        for (let r = 1; r <= 12; r++) {
          for (let yi = -r; yi <= r; yi++) {
            for (let xi = -r; xi <= r; xi++) {
              // Only walk the perimeter at this radius
              if (Math.abs(xi) !== r && Math.abs(yi) !== r) continue
              const tx = startX + xi * dx
              const ty = startY + yi * dy
              if (!overlapsExistingCard(id, tx, ty)) {
                merged[id] = { x: tx, y: ty }
                return true
              }
            }
          }
        }
        return false
      }

      for (const id of newIds) {
        const newStep = steps.find((s) => s.id === id)
        if (!newStep) continue
        const sources = steps.filter((s) => {
          if (s.id === id) return false
          const opts = s.options.some((o) => o.nextStepId === id)
          const btn = s.buttonConfig?.nextStepId === id
          return opts || btn
        })
        const targets: string[] = []
        for (const o of newStep.options) {
          if (o.nextStepId && o.nextStepId !== '__end__') targets.push(o.nextStepId)
        }
        const btnTarget = newStep.buttonConfig?.nextStepId
        if (btnTarget && btnTarget !== '__end__') targets.push(btnTarget)
        const uniqueTargets = Array.from(new Set(targets))

        // "+" insert path: any new step with exactly one source step is a
        // mid-chain insert (regardless of how many forward branches it has).
        // Slot it beside the source on the same row.
        // Standalone "+ Add Step" with no source falls through to the
        // viewport-center placement below.
        if (sources.length === 1) {
          const src = merged[sources[0].id]
          if (src) {
            const newX = src.x + slot
            const newY = src.y
            merged[id] = { x: newX, y: newY }

            // Shift downstream only when there's a single forward target —
            // a clean "A → new → B" insertion. Multi-branch question
            // steps don't auto-shift because there's no single "downstream"
            // to follow; the user can manually arrange the branches.
            if (uniqueTargets.length === 1) {
              const tgt = merged[uniqueTargets[0]]
              if (tgt && newX + NODE_W > tgt.x - 4) {
                const shift = newX + slot - tgt.x
                const toShift = new Set<string>()
                const queue = [uniqueTargets[0]]
                while (queue.length > 0) {
                  const sid = queue.shift()!
                  if (toShift.has(sid)) continue
                  toShift.add(sid)
                  const s = steps.find((x) => x.id === sid)
                  if (!s) continue
                  for (const o of s.options) {
                    if (o.nextStepId && o.nextStepId !== '__end__' && !toShift.has(o.nextStepId)) {
                      queue.push(o.nextStepId)
                    }
                  }
                  const cBtn = s.buttonConfig?.nextStepId
                  if (cBtn && cBtn !== '__end__' && !toShift.has(cBtn)) queue.push(cBtn)
                }
                toShift.forEach((sid) => {
                  const p = merged[sid]
                  if (p) merged[sid] = { x: p.x + shift, y: p.y }
                })
              }
            }
            continue
          }
        }

        // No single source → standalone "+ Add Step". Drop at viewport
        // center, with overlap avoidance.
        const start = viewportCenter ?? { x: 0, y: 0 }
        if (placeWithoutOverlap(id, start.x, start.y)) continue
        merged[id] = { ...start }
      }

      // Snap combined-with partners adjacent. If a partner is far away, slide
      // it to sit immediately to the right of its primary so the "Combined"
      // bracket actually engulfs them.
      for (const step of steps) {
        if (!step.combinedWithId) continue
        const myPos = merged[step.id]
        const partnerPos = merged[step.combinedWithId]
        if (!myPos || !partnerPos) continue
        const adjacentX = myPos.x + NODE_W + 20
        const adjacentY = myPos.y
        const isAdjacent =
          Math.abs(partnerPos.x - adjacentX) < 4 && Math.abs(partnerPos.y - adjacentY) < 4
        if (!isAdjacent) {
          merged[step.combinedWithId] = { x: adjacentX, y: adjacentY }
        }
      }

      // Pass 4: re-anchor START and END to bracket the actual chain.
      // This is computed from `merged` (not from prev) so the End node
      // moves right whenever a card is added at the end of the chain.
      const stepXs: number[] = []
      const stepYs: number[] = []
      for (const s of steps) {
        const p = merged[s.id]
        if (!p) continue
        stepXs.push(p.x)
        stepYs.push(p.y)
      }
      if (stepXs.length > 0) {
        const minX = Math.min(...stepXs)
        const maxX = Math.max(...stepXs)
        const minY = Math.min(...stepYs)
        const maxY = Math.max(...stepYs)
        const midY = (minY + maxY) / 2 + (NODE_H - SPECIAL_H) / 2
        merged[START_ID] = {
          x: minX - (NODE_W + H_GAP) + (NODE_W - SPECIAL_W) / 2,
          y: midY,
        }
        merged[END_ID] = {
          x: maxX + NODE_W + H_GAP + (NODE_W - SPECIAL_W) / 2,
          y: midY,
        }
      } else {
        if (layout[START_ID]) merged[START_ID] = layout[START_ID]
        if (layout[END_ID]) merged[END_ID] = layout[END_ID]
      }

      // Avoid spurious re-renders when nothing actually moved
      const prevKeys = Object.keys(prev)
      const mergedKeys = Object.keys(merged)
      if (prevKeys.length === mergedKeys.length) {
        let identical = true
        for (const k of mergedKeys) {
          if (!(k in prev) || prev[k].x !== merged[k].x || prev[k].y !== merged[k].y) {
            identical = false
            break
          }
        }
        if (identical) return prev
      }

      return merged
    })
  }, [computeLayout, steps])

  // Generate video thumbnails with cover-crop. Keyed by video.id so we don't
  // regenerate for every steps-array reference change — only when a new
  // (step.id, video.id) pair appears.
  // We deliberately do NOT set crossOrigin on the video element: doing so
  // requires the video host (S3) to send Access-Control-Allow-Origin, and
  // browsers cache CORS-failure responses aggressively. Without crossOrigin
  // the canvas becomes "tainted", which prevents reading pixel data — but
  // we only DISPLAY the canvas, never read it, so taint is fine.
  const loadedThumbVideoIdsRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const videoEls: HTMLVideoElement[] = []
    let mounted = true

    steps.forEach((step) => {
      const videoUrl = step.video?.url
      const videoId = step.video?.id
      if (!videoUrl || !videoId) return
      if (loadedThumbVideoIdsRef.current.get(step.id) === videoId) return

      const video = document.createElement('video')
      video.preload = 'metadata'
      video.muted = true
      video.playsInline = true
      video.src = videoUrl
      videoEls.push(video)
      video.onloadeddata = () => { video.currentTime = 1 }
      video.onseeked = () => {
        if (!mounted) return
        const vw = video.videoWidth
        const vh = video.videoHeight
        if (!vw || !vh) return
        const THUMB_W = NODE_W - 16
        const THUMB_H_CAP = THUMB_H
        const c = document.createElement('canvas')
        c.width = THUMB_W; c.height = THUMB_H_CAP
        const ctx = c.getContext('2d')
        if (!ctx) return
        const vidRatio = vw / vh
        const thumbRatio = THUMB_W / THUMB_H_CAP
        ctx.fillStyle = '#FFEDD5'
        ctx.fillRect(0, 0, THUMB_W, THUMB_H_CAP)
        let dw, dh, dx, dy
        if (vidRatio > thumbRatio) {
          dw = THUMB_W
          dh = THUMB_W / vidRatio
          dx = 0
          dy = (THUMB_H_CAP - dh) / 2
        } else {
          dh = THUMB_H_CAP
          dw = THUMB_H_CAP * vidRatio
          dx = (THUMB_W - dw) / 2
          dy = 0
        }
        try {
          ctx.drawImage(video, 0, 0, vw, vh, dx, dy, dw, dh)
        } catch {
          return
        }
        const aspect = vw / vh
        loadedThumbVideoIdsRef.current.set(step.id, videoId)
        setThumbnails((prev) => ({ ...prev, [step.id]: c }))
        setVideoAspects((prev) => ({ ...prev, [step.id]: aspect }))
      }
    })

    // Drop entries for steps that no longer exist, so the cache doesn't leak.
    const existingIds = new Set(steps.map((s) => s.id))
    for (const id of Array.from(loadedThumbVideoIdsRef.current.keys())) {
      if (!existingIds.has(id)) loadedThumbVideoIdsRef.current.delete(id)
    }

    return () => {
      mounted = false
      videoEls.forEach((v) => { v.pause(); v.removeAttribute('src'); v.load() })
    }
  }, [steps])

  // Load screen step images
  useEffect(() => {
    steps.forEach((step) => {
      const imgUrl = (step as any).formConfig?.imageUrl
      if (imgUrl && step.stepType === 'info' && !screenImages[step.id]) {
        // No crossOrigin: same reasoning as the thumbnail effect — we only
        // display, never read pixels, so a tainted main canvas is fine.
        const img = new Image()
        img.onload = () => setScreenImages(prev => ({ ...prev, [step.id]: img }))
        img.src = imgUrl
      }
    })
  }, [steps])

  // Convert screen coords to canvas coords
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: (clientX - rect.left - pan.x) / scale,
      y: (clientY - rect.top - pan.y) / scale,
    }
  }, [pan, scale])

  // Hit test: find which step is under the cursor
  const getNodeSize = useCallback((stepId: string) => {
    const a = videoAspects[stepId]
    const isP = a !== undefined && a < 0.8
    return { w: isP ? 180 : NODE_W, h: 30 + (isP ? 200 : THUMB_H) + 40 }
  }, [videoAspects])

  const hitTestNode = useCallback((cx: number, cy: number): string | null => {
    // Check special nodes
    for (const id of [START_ID, END_ID]) {
      const pos = posRef.current[id]
      if (!pos) continue
      if (cx >= pos.x && cx <= pos.x + SPECIAL_W && cy >= pos.y && cy <= pos.y + SPECIAL_H) {
        return id
      }
    }
    for (const step of steps) {
      const pos = posRef.current[step.id]
      if (!pos) continue
      const sz = getNodeSize(step.id)
      if (cx >= pos.x && cx <= pos.x + sz.w && cy >= pos.y && cy <= pos.y + sz.h) {
        return step.id
      }
    }
    return null
  }, [steps])

  // Hit test: find which step's output port (right circle) is under cursor
  const hitTestOutputPort = useCallback((cx: number, cy: number): string | null => {
    for (const step of steps) {
      const pos = posRef.current[step.id]
      if (!pos) continue
      const out = getOutputPort(pos)
      // Full circle, generous radius so the click target is easy to hit.
      if (dist(cx, cy, out.x, out.y) <= PORT_R + 10) {
        return step.id
      }
    }
    return null
  }, [steps])

  // Hit test: find which step's input port (left circle) is under cursor
  const hitTestInputPort = useCallback((cx: number, cy: number): string | null => {
    for (const step of steps) {
      const pos = posRef.current[step.id]
      if (!pos) continue
      const inp = getInputPort(pos)
      if (dist(cx, cy, inp.x, inp.y) <= PORT_R + 10) {
        return step.id
      }
    }
    return null
  }, [steps])

  // Hit test: arrow line (returns the option that owns it)
  // Use combined-pair-aware port positions so hit tests match the
  // drawn arrows. Rendering re-anchors ports for combined pairs to
  // the rightmost / leftmost card of the pair; hit tests must do the
  // same or clicks fall through.
  const visualPortsFor = useCallback(
    (sourceId: string, targetId: string): { out: { x: number; y: number }; inp: { x: number; y: number } } | null => {
      const srcId = getVisualRightmost(sourceId)
      const tgtId = getVisualLeftmost(targetId)
      const srcPos = posRef.current[srcId] ?? posRef.current[sourceId]
      const tgtPos = posRef.current[tgtId] ?? posRef.current[targetId]
      if (!srcPos || !tgtPos) return null
      return { out: getOutputPort(srcPos), inp: getInputPort(tgtPos) }
    },
    [getVisualRightmost, getVisualLeftmost]
  )

  // A connection A→B lives entirely inside a combined pair when A and
  // B are each other's combinedWithId partner. Such an edge is implicit
  // in the "combined box" visualization — drawing it produces a weird
  // loop from B's right port back to A's left port. Skip render + hit
  // tests for these.
  const isIntraCombinedPair = useCallback((aId: string, bId: string): boolean => {
    const a = steps.find((s) => s.id === aId)
    const b = steps.find((s) => s.id === bId)
    if (!a || !b) return false
    return (a as any).combinedWithId === bId || (b as any).combinedWithId === aId
  }, [steps])

  const hitTestArrow = useCallback((cx: number, cy: number): { optionId: string; stepId: string; kind: 'option' | 'button' } | null => {
    for (const step of steps) {
      for (const option of step.options) {
        if (!option.nextStepId) continue
        if (isIntraCombinedPair(step.id, option.nextStepId)) continue
        const ports = visualPortsFor(step.id, option.nextStepId)
        if (!ports) continue
        const lane = laneYByConn.get(`opt:${step.id}:${option.id}`)
        if (isNearBezier(cx, cy, ports.out.x, ports.out.y, ports.inp.x, ports.inp.y, 14, lane)) {
          return { optionId: option.id, stepId: step.id, kind: 'option' }
        }
      }
      const btnNext = (step as any).buttonConfig?.nextStepId
      if (btnNext && btnNext !== '__end__') {
        if (!isIntraCombinedPair(step.id, btnNext)) {
          const ports = visualPortsFor(step.id, btnNext)
          if (ports) {
            const lane = laneYByConn.get(`btn:${step.id}:${btnNext}`)
            if (isNearBezier(cx, cy, ports.out.x, ports.out.y, ports.inp.x, ports.inp.y, 14, lane)) {
              return { optionId: BUTTON_ARROW_SENTINEL, stepId: step.id, kind: 'button' }
            }
          }
        }
      }
    }
    return null
  }, [steps, laneYByConn, visualPortsFor, isIntraCombinedPair])

  // Hit test: arrow target endpoint (near the target input port)
  const hitTestArrowEndpoint = useCallback((cx: number, cy: number): { optionId: string; stepId: string } | null => {
    for (const step of steps) {
      const pos = posRef.current[step.id]
      if (!pos) continue
      for (const option of step.options) {
        if (!option.nextStepId) continue
        const targetPos = posRef.current[option.nextStepId]
        if (!targetPos) continue
        const inp = getInputPort(targetPos)
        if (dist(cx, cy, inp.x, inp.y) <= 18) {
          return { optionId: option.id, stepId: step.id }
        }
      }
    }
    return null
  }, [steps])

  // Draw
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const dpr = window.devicePixelRatio || 1
    const w = container.clientWidth
    const h = container.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // Draw grid
    ctx.save()
    ctx.translate(pan.x, pan.y)
    ctx.scale(scale, scale)

    const gridSize = 30
    const startX = Math.floor(-pan.x / scale / gridSize) * gridSize - gridSize
    const startY = Math.floor(-pan.y / scale / gridSize) * gridSize - gridSize
    const endX = startX + w / scale + gridSize * 2
    const endY = startY + h / scale + gridSize * 2

    ctx.strokeStyle = '#f0f0f0'
    ctx.lineWidth = 0.5
    for (let x = startX; x < endX; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x, startY); ctx.lineTo(x, endY); ctx.stroke()
    }
    for (let y = startY; y < endY; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(startX, y); ctx.lineTo(endX, y); ctx.stroke()
    }

    const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)

    // --- Draw connections ---

    // Start -> first step (skip if start screen removed)
    const startPos = positions[START_ID]
    const isStartArrowSelected = selectedArrow?.kind === 'start'
    if (startPos && sorted.length > 0 && startMessage !== '') {
      const firstPos = positions[sorted[0].id]
      if (firstPos) {
        const fromX = startPos.x + SPECIAL_W
        const fromY = startPos.y + SPECIAL_H / 2
        const toX = firstPos.x
        const toY = firstPos.y + NODE_H / 2
        const startLane = computeDetourLane(fromX, fromY, toX, toY, new Set([sorted[0].id]))
        const isStartHovered = hoveredArrow?.kind === 'start'
        const startLineColor = isStartArrowSelected
          ? SELECTED_COLOR
          : isStartHovered
            ? HOVER_COLOR
            : '#FF9500'
        drawConnection(ctx, fromX, fromY, toX, toY, '', false, startLineColor, startLane, isStartHovered && !isStartArrowSelected, scale)

        const [sMidX, sMidY] = bezierMid(fromX, fromY, toX, toY, startLane)

        if (isStartArrowSelected) {
          drawDragHandle(ctx, toX, toY, SELECTED_COLOR)
          drawDeleteButton(ctx, sMidX, sMidY)
        } else {
          const isPlusHovered = hoveredPort === '__insert_start'
          drawInsertButton(ctx, sMidX, sMidY, isPlusHovered)
        }
      }
    }

    // Connection arrows (option + button) come from `allConnections`,
    // built in the useMemo above. Within a step the button beats the
    // option to the same target; cross-step dupes are NOT removed.
    //
    // All arrows leave from the single OUT port and arrive at the single
    // IN port — same as End arrows — so visual convergence at both ends
    // matches across all connection types. Where arrows would otherwise
    // overlap (backward loopbacks), the lane-routing system below assigns
    // each its own bezier path.
    for (const conn of allConnections) {
      // Intra-pair connections (A → B where they are each other's
      // combined partner) are implicit in the combined box — skip them.
      if (isIntraCombinedPair(conn.sourceId, conn.targetId)) continue
      // For combined pairs, the visual OUT anchors to the rightmost card
      // of the pair (usually the question partner) and the visual IN
      // anchors to the leftmost card (usually the video primary). Data
      // is unchanged — only the port positions shift so lines leave/
      // enter the "combined box" edge instead of an interior seam.
      const visualSourceId = getVisualRightmost(conn.sourceId)
      const visualTargetId = getVisualLeftmost(conn.targetId)
      const sourcePos = positions[visualSourceId] ?? positions[conn.sourceId]
      const targetPos = positions[visualTargetId] ?? positions[conn.targetId]
      if (!sourcePos || !targetPos) continue
      // Every arrow attaches to the step's single OUT and IN ports — same
      // point regardless of how many other arrows leave/enter the same node.
      const out = getOutputPort(sourcePos)
      const inp = getInputPort(targetPos)

      const isSelected =
        conn.kind === 'button'
          ? selectedArrow?.kind === 'button' && selectedArrow.stepId === conn.sourceId
          : selectedArrow?.optionId === conn.optionId

      const laneY = laneYByConn.get(connKey(conn))

      // Button arrows hide their label on the canvas — the "Continue"
      // button itself is already visible on the source card, so a label
      // is redundant. Option arrows keep their answer text.
      const displayLabel = conn.kind === 'button' ? '' : conn.label

      const isHovered = hoveredArrow
        ? conn.kind === 'button'
          ? hoveredArrow.kind === 'button' && hoveredArrow.fromStepId === conn.sourceId
          : hoveredArrow.kind === 'option' && hoveredArrow.optionId === conn.optionId
        : false
      const lineColor = isSelected
        ? SELECTED_COLOR
        : isHovered
          ? HOVER_COLOR
          : '#FF9500'
      drawConnection(ctx, out.x, out.y, inp.x, inp.y, displayLabel, false, lineColor, laneY, isHovered && !isSelected, scale)

      const [midX, midY] = bezierMid(out.x, out.y, inp.x, inp.y, laneY)

      if (isSelected) {
        drawDragHandle(ctx, inp.x, inp.y, SELECTED_COLOR)
        drawDragHandle(ctx, out.x, out.y, SELECTED_COLOR)
        drawDeleteButton(ctx, midX, midY)
      } else {
        const portKey =
          conn.kind === 'button'
            ? `__insert_btn_${conn.sourceId}`
            : `__insert_opt_${conn.optionId}`
        drawInsertButton(ctx, midX, midY, hoveredPort === portKey)
      }

      // Diagnostic annotation under each arrow when debug mode is on
      if (debugConnections) {
        const fromTitle = (steps.find((s) => s.id === conn.sourceId)?.title ?? conn.sourceId).slice(0, 14)
        const toTitle = (steps.find((s) => s.id === conn.targetId)?.title ?? conn.targetId).slice(0, 14)
        const tag = `${fromTitle}→${toTitle} [${conn.kind}]`
        ctx.font = '9px monospace'
        const m = ctx.measureText(tag)
        ctx.fillStyle = 'rgba(15, 23, 42, 0.92)'
        ctx.fillRect(midX - m.width / 2 - 4, midY + 14, m.width + 8, 14)
        ctx.fillStyle = '#fef3c7'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(tag, midX, midY + 21)
      }
    }

    // End connections — geometry computed in endArrowGeomByStep useMemo
    // so hit tests use identical lane / entry Y.
    const endPos = positions[END_ID]
    if (endPos && endMessage !== '') {
      endArrowGeomByStep.forEach((g, stepId) => {
        const isThisEndSelected =
          selectedArrow?.kind === 'end' && selectedArrow.stepId === stepId
        const isThisEndHovered =
          hoveredArrow?.kind === 'end' && hoveredArrow.fromStepId === stepId
        const endLineColor = isThisEndSelected
          ? SELECTED_COLOR
          : isThisEndHovered
            ? HOVER_COLOR
            : '#FF9500'
        // Straight line, not a bezier: with a shared endpoint (End's
        // center), two lines from different sources can meet only at
        // that endpoint. Bezier attempts always weave (see 61fd3b9).
        const s = scale > 0 ? scale : 1
        ctx.beginPath()
        ctx.strokeStyle = endLineColor
        ctx.lineWidth = isThisEndHovered && !isThisEndSelected ? 2.5 : 2
        if (isThisEndHovered && !isThisEndSelected) ctx.setLineDash([8 / s, 5 / s])
        else ctx.setLineDash([])
        ctx.moveTo(g.fromX, g.fromY)
        ctx.lineTo(g.toX, g.toY)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.arc(g.fromX, g.fromY, 5, 0, Math.PI * 2)
        ctx.fillStyle = endLineColor
        ctx.fill()
        ctx.beginPath()
        ctx.arc(g.toX, g.toY, 5, 0, Math.PI * 2)
        ctx.fill()
        const eMidX = (g.fromX + g.toX) / 2
        const eMidY = (g.fromY + g.toY) / 2

        // No delete button here even for explicit button→End arrows —
        // Delete on an End-selected arrow is suppressed globally to avoid
        // clearing the End card by accident (see keyboard handler).
        if (isThisEndSelected) {
          drawDragHandle(ctx, g.fromX, g.fromY, SELECTED_COLOR)
        } else {
          const isPlusHovered = hoveredPort === `__insert_end_${stepId}`
          drawInsertButton(ctx, eMidX, eMidY, isPlusHovered)
        }
      })
    }

    // Draw in-progress connection or reconnection
    const m = modeRef.current
    if (m.type === 'connecting' || m.type === 'reconnecting' || m.type === 'reconnecting_button' || m.type === 'reconnecting_start' || m.type === 'reconnecting_end') {
      drawConnection(ctx, m.fromX, m.fromY, m.mouseX, m.mouseY, '', true)
    }
    if (m.type === 'reconnecting_source' || m.type === 'reconnecting_button_source') {
      drawConnection(ctx, m.mouseX, m.mouseY, m.toX, m.toY, '', true)
    }

    // --- Draw Start node (hidden if message is empty/removed) ---
    const showStart = startMessage !== ''
    if (startPos && showStart) {
      drawSpecialNode(ctx, startPos, 'Start', startMessage || 'Welcome', selectedStepId === START_ID, '#FF9500', '#FFEDD5')
    }

    // --- Draw End node (hidden if message is empty/removed) ---
    const showEnd = endMessage !== ''
    if (endPos && showEnd) {
      drawSpecialNode(ctx, endPos, 'End', endMessage || 'Thank you', selectedStepId === END_ID, '#FF9500', '#FFEDD5')
    }

    // --- Draw combined step brackets (before nodes so they're behind) ---
    for (const step of steps) {
      if (!step.combinedWithId) continue
      const pos1 = positions[step.id]
      const pos2 = positions[step.combinedWithId]
      if (!pos1 || !pos2) continue

      const minX = Math.min(pos1.x, pos2.x) - 6
      const minY = Math.min(pos1.y, pos2.y) - 6
      const maxX = Math.max(pos1.x + NODE_W, pos2.x + NODE_W) + 6
      const maxY = Math.max(pos1.y + NODE_H, pos2.y + NODE_H) + 6

      // If any unrelated card overlaps the bounding box, the rectangle bracket would
      // visually engulf it — fall back to outlining each combined card individually.
      const wouldEngulfOther = steps.some((s) => {
        if (s.id === step.id || s.id === step.combinedWithId) return false
        const p = positions[s.id]
        if (!p) return false
        return !(p.x + NODE_W < minX || p.x > maxX || p.y + NODE_H < minY || p.y > maxY)
      })

      ctx.strokeStyle = '#FF9500'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])

      if (wouldEngulfOther) {
        for (const p of [pos1, pos2]) {
          ctx.beginPath()
          ctx.roundRect(p.x - 6, p.y - 6, NODE_W + 12, NODE_H + 12, 16)
          ctx.stroke()
        }
        ctx.setLineDash([])
        ctx.font = 'bold 9px "Be Vietnam Pro", system-ui'
        ctx.fillStyle = '#FF9500'
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
        for (const p of [pos1, pos2]) {
          ctx.fillText('Combined', p.x + NODE_W / 2, p.y - 8)
        }
      } else {
        ctx.beginPath()
        ctx.roundRect(minX, minY, maxX - minX, maxY - minY, 16)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.font = 'bold 9px "Be Vietnam Pro", system-ui'
        ctx.fillStyle = '#FF9500'
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
        ctx.fillText('Combined', (minX + maxX) / 2, minY - 2)
      }
    }

    // --- Draw step nodes ---
    for (let si = 0; si < steps.length; si++) {
      const step = steps[si]
      const pos = positions[step.id]
      if (!pos) continue
      const stageNum = stageNumberByStep.get(step.id) ?? (sorted.indexOf(step) + 1)
      drawNode(ctx, step, pos, step.id === selectedStepId, thumbnails[step.id], stageNum - 1, videoAspects[step.id], screenImages[step.id])

      // Draw single OUTPUT port (right side). A step is "outgoing" if any
      // of its options has a nextStepId, OR its Continue button points to
      // another step / End — otherwise the port stays hollow.
      const out = getOutputPort(pos)
      const isOutHovered = hoveredPort === `out_${step.id}`
      const buttonNext = (step as any).buttonConfig?.nextStepId
      const hasOutgoing =
        step.options.some((o) => o.nextStepId) ||
        (!!buttonNext && (buttonNext === '__end__' || steps.some((s) => s.id === buttonNext)))
      drawPortCircle(ctx, out.x, out.y, isOutHovered, hasOutgoing)

      // Draw single INPUT port (left side). Same fix on the incoming side —
      // a card can be a target via option.nextStepId OR another card's
      // buttonConfig.nextStepId.
      const inp = getInputPort(pos)
      const isInpHovered = hoveredPort === `inp_${step.id}`
      const hasIncoming =
        steps.some((s) =>
          s.options.some((o) => o.nextStepId === step.id) ||
          (s as any).buttonConfig?.nextStepId === step.id
        ) || step.id === sorted[0]?.id
      drawPortCircle(ctx, inp.x, inp.y, isInpHovered, hasIncoming)
    }

    // Re-draw drag handles for the SELECTED arrow after port circles, so
    // the active orange handle ends up on top of the inactive step port
    // (port circles are drawn after the connection loop, which would
    // otherwise hide the drag handle).
    if (selectedArrow) {
      if (selectedArrow.kind === 'start') {
        const sortedSteps = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
        const fp = sortedSteps[0] ? positions[sortedSteps[0].id] : null
        if (fp) drawDragHandle(ctx, fp.x, fp.y + NODE_H / 2, SELECTED_COLOR)
      } else if (selectedArrow.kind === 'end') {
        const sPos = positions[selectedArrow.stepId]
        if (sPos) drawDragHandle(ctx, sPos.x + NODE_W, sPos.y + NODE_H / 2, SELECTED_COLOR)
      } else {
        // option or button: re-draw both source-out and target-in handles
        const sourceStep = steps.find((s) => s.id === selectedArrow.stepId)
        const sourcePos = sourceStep ? positions[sourceStep.id] : null
        let targetStepId: string | null = null
        if (selectedArrow.kind === 'button') {
          const btnNext = sourceStep?.buttonConfig?.nextStepId
          if (btnNext && btnNext !== '__end__') targetStepId = btnNext
        } else if (sourceStep) {
          const option = sourceStep.options.find((o) => o.id === selectedArrow.optionId)
          if (option?.nextStepId && option.nextStepId !== '__end__') targetStepId = option.nextStepId
        }
        const targetPos = targetStepId ? positions[targetStepId] : null
        if (sourcePos) {
          const o = getOutputPort(sourcePos)
          drawDragHandle(ctx, o.x, o.y, SELECTED_COLOR)
        }
        if (targetPos) {
          const i = getInputPort(targetPos)
          drawDragHandle(ctx, i.x, i.y, SELECTED_COLOR)
        }
      }
    }

    // Draw draft connection line while dragging — but only once the cursor
    // has clearly moved off the port. Otherwise a click on/near a port
    // briefly renders a tiny dashed "loop to the point" before mouseup
    // resolves the click into the port-picker popup.
    const DRAFT_MIN_DRIFT = 6
    if (mode.type === 'connecting') {
      const drift = Math.hypot((mode as any).mouseX - mode.fromX, (mode as any).mouseY - mode.fromY)
      if (drift >= DRAFT_MIN_DRIFT) {
        drawConnection(ctx, mode.fromX, mode.fromY, (mode as any).mouseX, (mode as any).mouseY, '', true)
      }
    }
    if ((mode as any).type === 'connecting_reverse') {
      const m = mode as any
      const drift = Math.hypot(m.mouseX - m.fromX, m.mouseY - m.fromY)
      if (drift >= DRAFT_MIN_DRIFT) {
        drawConnection(ctx, m.mouseX, m.mouseY, m.fromX, m.fromY, '', true)
      }
    }

    // Highlight cards selected via right-drag marquee (drawn on top of nodes)
    if (multiSelectedIds.size > 0) {
      ctx.strokeStyle = SELECTED_COLOR
      ctx.lineWidth = 2.5
      ctx.setLineDash([])
      multiSelectedIds.forEach((sid) => {
        const p = positions[sid]
        if (!p) return
        ctx.beginPath()
        ctx.roundRect(p.x - 2, p.y - 2, NODE_W + 4, NODE_H + 4, 10)
        ctx.stroke()
      })
    }

    // Draw the marquee rectangle itself while the user is dragging
    if (mode.type === 'marquee') {
      const minX = Math.min(mode.startCx, mode.currentCx)
      const maxX = Math.max(mode.startCx, mode.currentCx)
      const minY = Math.min(mode.startCy, mode.currentCy)
      const maxY = Math.max(mode.startCy, mode.currentCy)
      ctx.fillStyle = 'rgba(37, 99, 235, 0.12)'
      ctx.strokeStyle = SELECTED_COLOR
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.fillRect(minX, minY, maxX - minX, maxY - minY)
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY)
      ctx.setLineDash([])
    }

    ctx.restore()
  }, [positions, thumbnails, screenImages, videoAspects, pan, scale, steps, selectedStepId, hoveredPort, hoveredArrow, mode, startMessage, endMessage, getEndStepIds, selectedArrow, allConnections, laneYByConn, connKey, debugConnections, stageNumberByStep, computeDetourLane, endArrowGeomByStep, multiSelectedIds])

  // Animation frame for smooth rendering
  useEffect(() => {
    let raf: number
    const loop = () => {
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [draw])

  // Hit test: delete button (top-left of selected node)
  const hitTestDeleteButton = useCallback((cx: number, cy: number): string | null => {
    if (!selectedStepId || selectedStepId === START_ID || selectedStepId === END_ID) return null
    const pos = posRef.current[selectedStepId]
    if (!pos) return null
    const dx = pos.x - 6
    const dy = pos.y - 6
    if (dist(cx, cy, dx, dy) <= 14) return selectedStepId
    return null
  }, [selectedStepId])

  // Hit test: arrow delete button (midpoint of selected arrow). Handles
  // option, button, and start arrows. Implicit end arrows have no delete
  // button (they're not stored connections).
  const hitTestArrowDelete = useCallback((cx: number, cy: number): boolean => {
    if (!selectedArrow) return false

    if (selectedArrow.kind === 'start') {
      const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
      if (sorted.length === 0) return false
      const sp = posRef.current[START_ID]
      const fp = posRef.current[sorted[0].id]
      if (!sp || !fp) return false
      const [midX, midY] = bezierMid(
        sp.x + SPECIAL_W,
        sp.y + SPECIAL_H / 2,
        fp.x,
        fp.y + NODE_H / 2,
      )
      return dist(cx, cy, midX, midY) <= 14
    }

    if (selectedArrow.kind === 'end') {
      return false
    }

    const step = steps.find((s) => s.id === selectedArrow.stepId)
    if (!step) return false
    const pos = posRef.current[step.id]
    if (!pos) return false

    let targetStepId: string | null = null
    let lane: number | undefined
    if (selectedArrow.kind === 'button') {
      const btnNext = step.buttonConfig?.nextStepId
      if (btnNext && btnNext !== '__end__') {
        targetStepId = btnNext
        lane = laneYByConn.get(`btn:${step.id}:${btnNext}`)
      }
    } else {
      const option = step.options.find((o) => o.id === selectedArrow.optionId)
      targetStepId = option?.nextStepId ?? null
      if (option) lane = laneYByConn.get(`opt:${step.id}:${option.id}`)
    }
    if (!targetStepId) return false
    const targetPos = posRef.current[targetStepId]
    if (!targetPos) return false

    const out = getOutputPort(pos)
    const inp = getInputPort(targetPos)
    const [midX, midY] = bezierMid(out.x, out.y, inp.x, inp.y, lane)
    return dist(cx, cy, midX, midY) <= 14
  }, [selectedArrow, steps, laneYByConn, endArrowGeomByStep])

  // Hit test: arrow midpoint "+" insert button. Iterates every connection
  // (start, end, option, button) since "+" is now always rendered, and
  // returns the first match. The hit radius (12) is small enough that
  // clicks on the line itself away from the midpoint fall through to
  // arrow-line selection.
  const hitTestArrowInsert = useCallback(
    (
      cx: number,
      cy: number
    ):
      | { kind: 'option'; optionId: string; fromStepId: string; toStepId: string }
      | { kind: 'button'; fromStepId: string; toStepId: string }
      | { kind: 'start'; toStepId: string }
      | { kind: 'end'; fromStepId: string }
      | null => {
      const tryMid = (fromX: number, fromY: number, toX: number, toY: number, lane?: number) => {
        const [midX, midY] = bezierMid(fromX, fromY, toX, toY, lane)
        return dist(cx, cy, midX, midY) <= 12
      }

      // Start arrow
      if (startMessage !== '' && selectedArrow?.kind !== 'start') {
        const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
        if (sorted.length > 0) {
          const sp = posRef.current[START_ID]
          const fp = posRef.current[sorted[0].id]
          if (sp && fp) {
            const fromX = sp.x + SPECIAL_W
            const fromY = sp.y + SPECIAL_H / 2
            const toX = fp.x
            const toY = fp.y + NODE_H / 2
            if (tryMid(fromX, fromY, toX, toY)) return { kind: 'start', toStepId: sorted[0].id }
          }
        }
      }

      // End arrows — iterate every source that was actually drawn
      // (endArrowGeomByStep covers implicit terminals AND steps whose
      // Continue button explicitly points to __end__). Straight-line
      // midpoint since End arrows render as straight lines.
      if (endMessage !== '') {
        let result: { kind: 'end'; fromStepId: string } | null = null
        endArrowGeomByStep.forEach((g, sid) => {
          if (result) return
          if (selectedArrow?.kind === 'end' && selectedArrow.stepId === sid) return
          const midX = (g.fromX + g.toX) / 2
          const midY = (g.fromY + g.toY) / 2
          if (dist(cx, cy, midX, midY) <= 12) result = { kind: 'end', fromStepId: sid }
        })
        if (result) return result
      }

      for (const step of steps) {
        const pos = posRef.current[step.id]
        if (!pos) continue
        const out = getOutputPort(pos)

        // Option arrows
        for (const option of step.options) {
          if (!option.nextStepId) continue
          if (selectedArrow?.optionId === option.id) continue
          const targetPos = posRef.current[option.nextStepId]
          if (!targetPos) continue
          const inp = getInputPort(targetPos)
          const lane = laneYByConn.get(`opt:${step.id}:${option.id}`)
          if (tryMid(out.x, out.y, inp.x, inp.y, lane)) {
            return { kind: 'option', optionId: option.id, fromStepId: step.id, toStepId: option.nextStepId }
          }
        }

        // Button arrow
        const btnNext = (step as any).buttonConfig?.nextStepId
        if (btnNext && btnNext !== '__end__') {
          const isThisButtonSelected =
            selectedArrow?.kind === 'button' && selectedArrow.stepId === step.id
          if (!isThisButtonSelected) {
            const targetPos = posRef.current[btnNext]
            if (targetPos) {
              const inp = getInputPort(targetPos)
              const lane = laneYByConn.get(`btn:${step.id}:${btnNext}`)
              if (tryMid(out.x, out.y, inp.x, inp.y, lane)) {
                return { kind: 'button', fromStepId: step.id, toStepId: btnNext }
              }
            }
          }
        }
      }

      return null
    },
    [steps, selectedArrow, startMessage, endMessage, getEndStepIds, laneYByConn, endArrowGeomByStep]
  )

  // Detect hovered arrow line (option, button, start, or end), so "+" only
  // appears when the user actually hovers a connection.
  const hitTestArrowLine = useCallback(
    (
      cx: number,
      cy: number
    ):
      | { kind: 'option'; optionId: string; fromStepId: string }
      | { kind: 'button'; fromStepId: string }
      | { kind: 'start' }
      | { kind: 'end'; fromStepId: string }
      | null => {
      // Start arrow
      if (selectedArrow?.kind !== 'start' && startMessage !== '') {
        const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
        if (sorted.length > 0) {
          const sp = posRef.current[START_ID]
          const fp = posRef.current[sorted[0].id]
          if (sp && fp) {
            const fromX = sp.x + SPECIAL_W
            const fromY = sp.y + SPECIAL_H / 2
            const toX = fp.x
            const toY = fp.y + NODE_H / 2
            if (isNearBezier(cx, cy, fromX, fromY, toX, toY, 12)) {
              return { kind: 'start' }
            }
          }
        }
      }

      // End arrows — iterate every drawn source (implicit terminals AND
      // steps whose Continue button explicitly points to __end__).
      if (endMessage !== '') {
        let hovered: string | null = null
        endArrowGeomByStep.forEach((g, sid) => {
          if (hovered) return
          if (selectedArrow?.kind === 'end' && selectedArrow.stepId === sid) return
          if (distToSegment(cx, cy, g.fromX, g.fromY, g.toX, g.toY) <= 12) hovered = sid
        })
        if (hovered) return { kind: 'end', fromStepId: hovered }
      }

      for (const step of steps) {
        for (const option of step.options) {
          if (!option.nextStepId) continue
          if (selectedArrow?.optionId === option.id) continue
          if (isIntraCombinedPair(step.id, option.nextStepId)) continue
          const ports = visualPortsFor(step.id, option.nextStepId)
          if (!ports) continue
          const lane = laneYByConn.get(`opt:${step.id}:${option.id}`)
          if (isNearBezier(cx, cy, ports.out.x, ports.out.y, ports.inp.x, ports.inp.y, 14, lane)) {
            return { kind: 'option', optionId: option.id, fromStepId: step.id }
          }
        }

        // Skip button arrow if it's currently selected
        const isThisButtonSelected =
          selectedArrow?.kind === 'button' && selectedArrow.stepId === step.id
        if (isThisButtonSelected) continue
        const btnNext = (step as any).buttonConfig?.nextStepId
        if (btnNext && btnNext !== '__end__') {
          if (isIntraCombinedPair(step.id, btnNext)) continue
          const ports = visualPortsFor(step.id, btnNext)
          if (ports) {
            const lane = laneYByConn.get(`btn:${step.id}:${btnNext}`)
            if (isNearBezier(cx, cy, ports.out.x, ports.out.y, ports.inp.x, ports.inp.y, 14, lane)) {
              return { kind: 'button', fromStepId: step.id }
            }
          }
        }
      }
      return null
    },
    [steps, selectedArrow, startMessage, endMessage, getEndStepIds, laneYByConn, endArrowGeomByStep, visualPortsFor, isIntraCombinedPair]
  )

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    // Any new mousedown invalidates a stale pending-port from a prior
    // interaction that ended outside the container. The port hit tests
    // below re-set this ref when relevant.
    pendingPortRef.current = null
    if (e.button === 2) {
      // Right-click. If the cursor is on empty canvas (not on a node,
      // arrow, or port), start a marquee selection. Otherwise let
      // handleContextMenu deal with it (e.g. arrow disconnect menu).
      const { x: rcx, y: rcy } = toCanvas(e.clientX, e.clientY)
      const nodeAt = hitTestNode(rcx, rcy)
      const arrowAt = hitTestArrowLine(rcx, rcy)
      if (!nodeAt && !arrowAt) {
        e.preventDefault()
        setContextMenu(null)
        setSelectedArrow(null)
        setMultiSelectedIds(new Set())
        setMode({ type: 'marquee', startCx: rcx, startCy: rcy, currentCx: rcx, currentCy: rcy })
      }
      return
    }
    setContextMenu(null)

    const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
    const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
    const endPos = positions[END_ID]

    // DEBUG: log click info
    const nodeHit = hitTestNode(cx, cy)

    // Ctrl / Cmd + click on a card: toggle its membership in the multi
    // selection instead of the normal single-select. Special nodes
    // (Start / End) aren't selectable this way — they're not cards.
    if (nodeHit && nodeHit !== START_ID && nodeHit !== END_ID && (e.ctrlKey || e.metaKey)) {
      setMultiSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(nodeHit)) next.delete(nodeHit)
        else next.add(nodeHit)
        return next
      })
      setSelectedArrow(null)
      return
    }

    // Left-click on a card that's part of the marquee multi-selection:
    // drag the whole group instead of just this one.
    if (nodeHit && multiSelectedIds.has(nodeHit) && multiSelectedIds.size > 1) {
      const offsets: Record<string, { x: number; y: number }> = {}
      const stepIds: string[] = []
      multiSelectedIds.forEach((sid) => {
        const p = positions[sid]
        if (!p) return
        offsets[sid] = { x: cx - p.x, y: cy - p.y }
        stepIds.push(sid)
      })
      setMode({ type: 'dragging_group', stepIds, offsets })
      return
    }

    // Check node delete button first
    const deleteTarget = hitTestDeleteButton(cx, cy)
    if (deleteTarget) {
      onDeleteStep?.(deleteTarget)
      return
    }

    // Check arrow delete button (option, button, start arrows). Implicit end
    // arrows have no delete button — see the End-arrow draw block.
    if (
      (selectedArrow?.kind === 'option' ||
        selectedArrow?.kind === 'button' ||
        selectedArrow?.kind === 'start') &&
      hitTestArrowDelete(cx, cy)
    ) {
      if (selectedArrow.kind === 'button') {
        onButtonConfigUpdate?.(selectedArrow.stepId, null)
      } else if (selectedArrow.kind === 'start') {
        onClearStartScreen?.()
      } else {
        onOptionUpdate?.(selectedArrow.optionId, { nextStepId: null })
      }
      setSelectedArrow(null)
      return
    }

    // Check arrow midpoint "+" insert button — splits the connection by inserting a new step
    const insertHit = hitTestArrowInsert(cx, cy)
    if (insertHit) {
      onInsertStepOnArrow?.(insertHit)
      return
    }

    // Check Start arrow drag handle (must be before generic endpoint check)
    if (selectedArrow?.kind === 'start' && sorted.length > 0) {
      const firstPos = positions[sorted[0].id]
      if (firstPos) {
        const toX = firstPos.x
        const toY = firstPos.y + NODE_H / 2
        const d = dist(cx, cy, toX, toY)
        if (d <= 18) {
          const sp = positions[START_ID]
          if (sp) {
            setMode({
              type: 'reconnecting_start',
              fromX: sp.x + SPECIAL_W,
              fromY: sp.y + SPECIAL_H / 2,
              mouseX: cx,
              mouseY: cy,
            })
            return
          }
        }
      }
    }

    // Check End arrow drag handle
    if (selectedArrow?.kind === 'end') {
      const stepPos = positions[selectedArrow.stepId]
      if (stepPos) {
        const fromX = stepPos.x + NODE_W
        const fromY = stepPos.y + NODE_H / 2
        const d = dist(cx, cy, fromX, fromY)
        if (d <= 18) {
          const ep = positions[END_ID]
          if (ep) {
            setMode({
              type: 'reconnecting_end',
              fromStepId: selectedArrow.stepId,
              fromX: ep.x,
              fromY: ep.y + SPECIAL_H / 2,
              mouseX: cx,
              mouseY: cy,
            })
            return
          }
        }
      }
    }

    // Check button arrow target/source endpoint drag
    if (selectedArrow?.kind === 'button') {
      const srcStep = steps.find((s) => s.id === selectedArrow.stepId)
      const btnNext = srcStep?.buttonConfig?.nextStepId
      const srcPos = positions[selectedArrow.stepId]
      if (btnNext && btnNext !== '__end__' && srcPos) {
        const targetPos = positions[btnNext]
        if (targetPos) {
          const inp = getInputPort(targetPos)
          const dTarget = dist(cx, cy, inp.x, inp.y)
          const out = getOutputPort(srcPos)
          const dSource = dist(cx, cy, out.x, out.y)
          // Target endpoint
          if (dTarget <= 18) {
            setMode({
              type: 'reconnecting_button',
              fromStepId: selectedArrow.stepId,
              fromX: out.x,
              fromY: out.y,
              mouseX: cx,
              mouseY: cy,
            })
            return
          }
          // Source endpoint
          if (dSource <= 18) {
            setMode({
              type: 'reconnecting_button_source',
              oldFromStepId: selectedArrow.stepId,
              targetStepId: btnNext,
              toX: inp.x,
              toY: inp.y,
              mouseX: cx,
              mouseY: cy,
            })
            return
          }
        } else {
        }
      } else {
      }
    }

    // Check option arrow target endpoint drag (arrowhead at target)
    if (selectedArrow?.kind === 'option') {
      const endpoint = hitTestArrowEndpoint(cx, cy)
      if (endpoint && endpoint.optionId === selectedArrow.optionId) {
        const pos = positions[endpoint.stepId]
        if (pos) {
          const out = getOutputPort(pos)
          setMode({
            type: 'reconnecting',
            optionId: endpoint.optionId,
            fromStepId: endpoint.stepId,
            fromX: out.x,
            fromY: out.y,
            mouseX: cx,
            mouseY: cy,
          })
          return
        }
      }

      // Check option arrow source endpoint drag (at output port)
      const srcPos = positions[selectedArrow.stepId]
      if (srcPos) {
        const srcOut = getOutputPort(srcPos)
        const dSource = dist(cx, cy, srcOut.x, srcOut.y)
        if (dSource <= 18) {
          const srcStep = steps.find((s) => s.id === selectedArrow.stepId)
          const option = srcStep?.options.find((o) => o.id === selectedArrow.optionId)
          if (option?.nextStepId) {
            const targetPos = positions[option.nextStepId]
            if (targetPos) {
              const inp = getInputPort(targetPos)
              setMode({
                type: 'reconnecting_source',
                optionId: selectedArrow.optionId,
                targetStepId: option.nextStepId,
                toX: inp.x,
                toY: inp.y,
                mouseX: cx,
                mouseY: cy,
              })
              return
            }
          } else {
          }
        }
      }
    }

    // Check output ports (right side). Don't enter 'connecting' yet — a
    // plain click should open the port picker without any draft line
    // flashing. Movement past the threshold promotes to a real drag
    // (see handleMouseMove below).
    const outPortStepId = hitTestOutputPort(cx, cy)
    if (outPortStepId) {
      const pos = positions[outPortStepId]
      if (pos) {
        setSelectedArrow(null)
        pendingPortRef.current = {
          kind: 'out',
          stepId: outPortStepId,
          startCx: cx,
          startCy: cy,
          startScreenX: e.clientX,
          startScreenY: e.clientY,
        }
        return
      }
    }

    // Check input ports (left side).
    const inpPortStepId = hitTestInputPort(cx, cy)
    if (inpPortStepId) {
      const pos = positions[inpPortStepId]
      if (pos) {
        setSelectedArrow(null)
        pendingPortRef.current = {
          kind: 'in',
          stepId: inpPortStepId,
          startCx: cx,
          startCy: cy,
          startScreenX: e.clientX,
          startScreenY: e.clientY,
        }
        return
      }
    }

    // Check arrow click for selection (before node check so arrows near nodes work)
    const arrow = hitTestArrow(cx, cy)
    if (arrow) {
      setSelectedArrow({ optionId: arrow.optionId, stepId: arrow.stepId, kind: arrow.kind })
      return
    }

    // Check Start arrow click
    if (sorted.length > 0) {
      const sp = positions[START_ID]
      const firstPos = positions[sorted[0].id]
      if (sp && firstPos) {
        const fromX = sp.x + SPECIAL_W
        const fromY = sp.y + SPECIAL_H / 2
        const toX = firstPos.x
        const toY = firstPos.y + NODE_H / 2
        if (isNearBezier(cx, cy, fromX, fromY, toX, toY, 10)) {
          setSelectedArrow({ optionId: '__start_arrow__', stepId: sorted[0].id, kind: 'start' })
          return
        }
      }
    }

    // Check End arrow click — pick whichever drawn End arrow is hit
    // (covers implicit terminals AND explicit button-to-__end__ routes).
    if (endPos && endArrowGeomByStep.size > 0 && endMessage !== '') {
      let hitStepId: string | null = null
      endArrowGeomByStep.forEach((g, sid) => {
        if (hitStepId) return
        if (distToSegment(cx, cy, g.fromX, g.fromY, g.toX, g.toY) <= 10) hitStepId = sid
      })
      if (hitStepId) {
        setSelectedArrow({ optionId: '__end_arrow__', stepId: hitStepId, kind: 'end' })
        return
      }
    }

    // Check nodes (for dragging)
    const nodeId = hitTestNode(cx, cy)
    if (nodeId) {
      setSelectedArrow(null)
      const pos = positions[nodeId]
      if (pos) {
        setMode({
          type: 'dragging',
          stepId: nodeId,
          offsetX: cx - pos.x,
          offsetY: cy - pos.y,
          startScreenX: e.clientX,
          startScreenY: e.clientY,
        })
        return
      }
    }

    // Combined-pair bracket: clicking the dashed border (outside both cards)
    // grabs the pair so they move together. We test only the OUTER edge of
    // the bracket — the inside is taken by the cards' own drag handlers.
    {
      const bracketHit = (() => {
        for (const step of steps) {
          const partnerId = step.combinedWithId
          if (!partnerId) continue
          const pos1 = positions[step.id]
          const pos2 = positions[partnerId]
          if (!pos1 || !pos2) continue
          const minX = Math.min(pos1.x, pos2.x) - 6
          const minY = Math.min(pos1.y, pos2.y) - 6
          const maxX = Math.max(pos1.x + NODE_W, pos2.x + NODE_W) + 6
          const maxY = Math.max(pos1.y + NODE_H, pos2.y + NODE_H) + 6
          // Inside the outer bracket?
          if (cx < minX - 8 || cx > maxX + 8 || cy < minY - 8 || cy > maxY + 8) continue
          // But OUTSIDE both cards (so we don't steal clicks meant for cards)
          const insideCard1 =
            cx >= pos1.x && cx <= pos1.x + NODE_W &&
            cy >= pos1.y && cy <= pos1.y + NODE_H
          const insideCard2 =
            cx >= pos2.x && cx <= pos2.x + NODE_W &&
            cy >= pos2.y && cy <= pos2.y + NODE_H
          if (insideCard1 || insideCard2) continue
          return { step, partnerId, pos1, pos2 }
        }
        return null
      })()

      if (bracketHit) {
        setSelectedArrow(null)
        setMode({
          type: 'dragging_group',
          stepIds: [bracketHit.step.id, bracketHit.partnerId],
          offsets: {
            [bracketHit.step.id]: { x: cx - bracketHit.pos1.x, y: cy - bracketHit.pos1.y },
            [bracketHit.partnerId]: { x: cx - bracketHit.pos2.x, y: cy - bracketHit.pos2.y },
          },
        })
        return
      }
    }

    // Clicking empty space deselects everything (including the marquee
    // multi-selection — same as any single-select interaction).
    setSelectedArrow(null)
    setMultiSelectedIds(new Set())
    setMode({
      type: 'panning',
      startX: e.clientX,
      startY: e.clientY,
      panStartX: pan.x,
      panStartY: pan.y,
    })
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)

    // Promote a pending port interaction to a real connecting drag once
    // the cursor has drifted past the threshold. Below threshold the
    // pending state stays put and a mouseup will resolve as a click →
    // port picker (no draft line ever renders).
    const pending = pendingPortRef.current
    if (pending) {
      const drift = Math.hypot(cx - pending.startCx, cy - pending.startCy)
      if (drift >= 6) {
        const pos = positions[pending.stepId]
        if (pos) {
          if (pending.kind === 'out') {
            const out = getOutputPort(pos)
            setMode({
              type: 'connecting',
              fromStepId: pending.stepId,
              fromX: out.x,
              fromY: out.y,
              mouseX: cx,
              mouseY: cy,
            })
          } else {
            const inp = getInputPort(pos)
            setMode({
              type: 'connecting_reverse',
              targetStepId: pending.stepId,
              fromX: inp.x,
              fromY: inp.y,
              mouseX: cx,
              mouseY: cy,
            } as any)
          }
        }
        pendingPortRef.current = null
        return
      }
      // Still within threshold — no mode change, no draft.
      return
    }

    if (mode.type === 'panning') {
      setPan({
        x: mode.panStartX + (e.clientX - mode.startX),
        y: mode.panStartY + (e.clientY - mode.startY),
      })
      return
    }

    if (mode.type === 'dragging') {
      setPositions((prev) => ({
        ...prev,
        [mode.stepId]: {
          x: cx - mode.offsetX,
          y: cy - mode.offsetY,
        },
      }))
      return
    }

    if (mode.type === 'dragging_group') {
      setPositions((prev) => {
        const next = { ...prev }
        for (const sid of mode.stepIds) {
          const off = mode.offsets[sid]
          if (!off) continue
          next[sid] = { x: cx - off.x, y: cy - off.y }
        }
        return next
      })
      return
    }

    if (mode.type === 'marquee') {
      setMode({ ...mode, currentCx: cx, currentCy: cy })
      return
    }

    if (mode.type === 'connecting') {
      setMode({ ...mode, mouseX: cx, mouseY: cy })
      const targetStep = hitTestInputPort(cx, cy)
      if (targetStep && targetStep !== mode.fromStepId) {
        setHoveredPort(`inp_${targetStep}`)
      } else {
        setHoveredPort(null)
      }
      return
    }

    if ((mode as any).type === 'connecting_reverse') {
      setMode({ ...mode, mouseX: cx, mouseY: cy } as any)
      const sourceStep = hitTestOutputPort(cx, cy)
      if (sourceStep && sourceStep !== (mode as any).targetStepId) {
        setHoveredPort(`out_${sourceStep}`)
      } else {
        setHoveredPort(null)
      }
      return
    }

    if (mode.type === 'reconnecting') {
      setMode({ ...mode, mouseX: cx, mouseY: cy })
      const targetStep = hitTestInputPort(cx, cy)
      if (targetStep && targetStep !== mode.fromStepId) {
        setHoveredPort(`inp_${targetStep}`)
      } else {
        setHoveredPort(null)
      }
      return
    }

    if (mode.type === 'reconnecting_button') {
      setMode({ ...mode, mouseX: cx, mouseY: cy })
      const targetStep = hitTestInputPort(cx, cy)
      if (targetStep && targetStep !== mode.fromStepId) {
        setHoveredPort(`inp_${targetStep}`)
      } else {
        setHoveredPort(null)
      }
      return
    }

    if (mode.type === 'reconnecting_button_source') {
      setMode({ ...mode, mouseX: cx, mouseY: cy })
      const outStepId = hitTestOutputPort(cx, cy)
      setHoveredPort(outStepId ? `out_${outStepId}` : null)
      return
    }

    if (mode.type === 'reconnecting_start') {
      setMode({ ...mode, mouseX: cx, mouseY: cy })
      const targetStep = hitTestInputPort(cx, cy)
      setHoveredPort(targetStep ? `inp_${targetStep}` : null)
      return
    }

    if (mode.type === 'reconnecting_end') {
      setMode({ ...mode, mouseX: cx, mouseY: cy })
      const nodeId = hitTestNode(cx, cy)
      setHoveredPort(nodeId && nodeId !== START_ID && nodeId !== END_ID ? `out_${nodeId}` : null)
      return
    }

    if (mode.type === 'reconnecting_source') {
      setMode({ ...mode, mouseX: cx, mouseY: cy })
      const outStepId = hitTestOutputPort(cx, cy)
      setHoveredPort(outStepId ? `out_${outStepId}` : null)
      return
    }

    // Node hover is computed up front so the card highlight stays on
    // whenever the cursor sits inside a real step's rect — ports,
    // insert buttons, and arrow lines that happen to overlap the card
    // no longer drop hoveredNodeId to null. Special nodes (Start/End)
    // don't count — they're not deletable / editable cards.
    const nodeUnder = hitTestNode(cx, cy)
    const isRealStep = nodeUnder && nodeUnder !== START_ID && nodeUnder !== END_ID
    setHoveredNodeId(isRealStep ? nodeUnder : null)

    // Hover detection
    const delTarget = hitTestDeleteButton(cx, cy)
    if (delTarget) {
      setHoveredPort('__delete__')
      return
    }
    const outStepHover = hitTestOutputPort(cx, cy)
    if (outStepHover) {
      setHoveredPort(`out_${outStepHover}`)
      return
    }
    const inpStep = hitTestInputPort(cx, cy)
    if (inpStep) {
      setHoveredPort(`inp_${inpStep}`)
      return
    }
    // Arrow hover
    if (selectedArrow && hitTestArrowDelete(cx, cy)) {
      setHoveredPort('__arrow_delete__')
      setHoveredArrow(null)
      return
    }
    // "+" insert button hover (always rendered, so check first regardless
    // of whether the line itself is hovered)
    const insertHover = hitTestArrowInsert(cx, cy)
    if (insertHover) {
      setHoveredArrow(null)
      const portKey =
        insertHover.kind === 'option' ? `__insert_opt_${insertHover.optionId}` :
        insertHover.kind === 'button' ? `__insert_btn_${insertHover.fromStepId}` :
        insertHover.kind === 'start' ? '__insert_start' :
        `__insert_end_${insertHover.fromStepId}`
      setHoveredPort(portKey)
      return
    }
    // Otherwise: hovering the line itself
    const lineHover = hitTestArrowLine(cx, cy)
    if (lineHover) {
      setHoveredArrow(lineHover)
      setHoveredPort('__arrow__')
      return
    }
    setHoveredArrow(null)
    setHoveredPort(null)
  }

  const handleMouseUp = (e: React.MouseEvent) => {
    // Pending port click (mousedown on port with < threshold drift) → open
    // the picker at the cursor. Ignores mode entirely — no draft was ever
    // drawn, no connecting state entered.
    const pending = pendingPortRef.current
    if (pending) {
      pendingPortRef.current = null
      setPortPicker(
        pending.kind === 'out'
          ? { screenX: e.clientX, screenY: e.clientY, kind: 'out', fromStepId: pending.stepId }
          : { screenX: e.clientX, screenY: e.clientY, kind: 'in', targetStepId: pending.stepId }
      )
      return
    }

    if (mode.type === 'reconnecting') {
      const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
      // Accept drop on input port OR anywhere on a node
      let targetStep = hitTestInputPort(cx, cy)
      const nodeHit = targetStep ? null : hitTestNode(cx, cy)
      if (!targetStep && nodeHit && nodeHit !== START_ID && nodeHit !== END_ID) {
        targetStep = nodeHit
      }

      if (targetStep && targetStep !== mode.fromStepId) {
        onOptionUpdate?.(mode.optionId, { nextStepId: targetStep })
      }
      setSelectedArrow(null)
      setHoveredPort(null)
      setMode({ type: 'idle' })
      return
    }

    if (mode.type === 'reconnecting_source') {
      const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
      const outStepId = hitTestOutputPort(cx, cy)
      const oldSourceStepId = steps.find((s) => s.options.some((o) => o.id === mode.optionId))?.id
      if (outStepId && outStepId !== oldSourceStepId) {
        onOptionUpdate?.(mode.optionId, { nextStepId: null })
        onConnectSteps?.(outStepId, mode.targetStepId)
      }
      setSelectedArrow(null)
      setHoveredPort(null)
      setMode({ type: 'idle' })
      return
    }

    if (mode.type === 'reconnecting_button') {
      const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
      let targetStep = hitTestInputPort(cx, cy)
      const droppedNode = targetStep ? null : hitTestNode(cx, cy)
      if (!targetStep && droppedNode && droppedNode !== START_ID && droppedNode !== END_ID) {
        targetStep = droppedNode
      }
      if (targetStep && targetStep !== mode.fromStepId) {
        onButtonConfigUpdate?.(mode.fromStepId, targetStep)
      } else if (droppedNode === END_ID) {
        onButtonConfigUpdate?.(mode.fromStepId, '__end__')
      }
      setSelectedArrow(null)
      setHoveredPort(null)
      setMode({ type: 'idle' })
      return
    }

    if (mode.type === 'reconnecting_button_source') {
      const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
      const outStepId = hitTestOutputPort(cx, cy)
      if (outStepId && outStepId !== mode.oldFromStepId) {
        onButtonConfigUpdate?.(mode.oldFromStepId, null)
        onButtonConfigUpdate?.(outStepId, mode.targetStepId)
      }
      setSelectedArrow(null)
      setHoveredPort(null)
      setMode({ type: 'idle' })
      return
    }

    if (mode.type === 'reconnecting_start') {
      const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
      let targetStep = hitTestInputPort(cx, cy)
      if (!targetStep) {
        const nodeId = hitTestNode(cx, cy)
        if (nodeId && nodeId !== START_ID && nodeId !== END_ID) targetStep = nodeId
      }
      if (targetStep) {
        onChangeFirstStep?.(targetStep)
      }
      setSelectedArrow(null)
      setHoveredPort(null)
      setMode({ type: 'idle' })
      return
    }

    if (mode.type === 'reconnecting_end') {
      const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
      // Accept drop on input port OR anywhere on a real step node.
      let targetStep = hitTestInputPort(cx, cy)
      if (!targetStep) {
        const nodeId = hitTestNode(cx, cy)
        if (nodeId && nodeId !== START_ID && nodeId !== END_ID && nodeId !== mode.fromStepId) {
          targetStep = nodeId
        }
      }
      if (targetStep && targetStep !== mode.fromStepId) {
        // The End arrow was implicit — the source step has no forward
        // connection. Wire one now: prefer the Continue button when the
        // step has one, otherwise create a new option (matches how ports
        // and drag-from-output work).
        const srcStep = steps.find((s) => s.id === mode.fromStepId)
        if (srcStep?.buttonConfig) {
          onButtonConfigUpdate?.(mode.fromStepId, targetStep)
        } else {
          onConnectSteps?.(mode.fromStepId, targetStep)
        }
      }
      setSelectedArrow(null)
      setHoveredPort(null)
      setMode({ type: 'idle' })
      return
    }

    if (mode.type === 'connecting') {
      const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
      let targetStep = hitTestInputPort(cx, cy)
      const droppedNode = targetStep ? null : hitTestNode(cx, cy)
      if (!targetStep && droppedNode && droppedNode !== START_ID && droppedNode !== END_ID) {
        targetStep = droppedNode
      }

      if (targetStep && targetStep !== mode.fromStepId) {
        onConnectSteps?.(mode.fromStepId, targetStep)
      } else if (droppedNode === END_ID) {
        // Dropping the drag on the End node explicitly wires the source
        // step's Continue button to End. There's no "option → End"
        // representation in the UI (the option nextStep dropdown collapses
        // __end__ to null), so buttonConfig is the only expressible route.
        onButtonConfigUpdate?.(mode.fromStepId, '__end__')
      } else {
        // No target hit. If the cursor barely moved from the port, this
        // was a click, not a drag — open a picker instead of silently
        // dropping the interaction.
        const drift = Math.hypot(cx - mode.fromX, cy - mode.fromY)
        if (drift < 6) {
          setPortPicker({ screenX: e.clientX, screenY: e.clientY, kind: 'out', fromStepId: mode.fromStepId })
        }
      }

      setHoveredPort(null)
    }

    // Reverse connecting: drop on output port to create connection FROM that step TO the starting step
    if ((mode as any).type === 'connecting_reverse') {
      const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
      let sourceStep = hitTestOutputPort(cx, cy)
      if (!sourceStep) {
        const nodeId = hitTestNode(cx, cy)
        if (nodeId && nodeId !== START_ID && nodeId !== END_ID) sourceStep = nodeId
      }

      if (sourceStep && sourceStep !== (mode as any).targetStepId) {
        onConnectSteps?.(sourceStep, (mode as any).targetStepId)
      } else {
        // No source hit + minimal drift → treat as click, open picker.
        const drift = Math.hypot(cx - (mode as any).fromX, cy - (mode as any).fromY)
        if (drift < 6) {
          setPortPicker({ screenX: e.clientX, screenY: e.clientY, kind: 'in', targetStepId: (mode as any).targetStepId })
        }
      }

      setHoveredPort(null)
    }

    if (mode.type === 'dragging') {
      // Check if it was a click (minimal movement) using screen coords
      const dx = Math.abs(e.clientX - mode.startScreenX)
      const dy = Math.abs(e.clientY - mode.startScreenY)
      if (dx < 5 && dy < 5) {
        // It was a click, not a drag
        onStepClick?.(mode.stepId)
      } else {
        // Real drag — persist positions to the parent
        onPositionsChange?.(positions)
      }
    }

    if (mode.type === 'dragging_group') {
      onPositionsChange?.(positions)
    }

    if (mode.type === 'marquee') {
      const minX = Math.min(mode.startCx, mode.currentCx)
      const maxX = Math.max(mode.startCx, mode.currentCx)
      const minY = Math.min(mode.startCy, mode.currentCy)
      const maxY = Math.max(mode.startCy, mode.currentCy)
      // Tiny drag? Treat as a click on empty canvas — clear selection.
      if (maxX - minX < 4 && maxY - minY < 4) {
        setMultiSelectedIds(new Set())
      } else {
        const selected = new Set<string>()
        for (const step of steps) {
          const p = positions[step.id]
          if (!p) continue
          // Any overlap with the marquee rect counts.
          if (p.x < maxX && p.x + NODE_W > minX && p.y < maxY && p.y + NODE_H > minY) {
            selected.add(step.id)
          }
        }
        setMultiSelectedIds(selected)
      }
      setMode({ type: 'idle' })
      return
    }

    if (mode.type === 'panning') {
      const dx = e.clientX - mode.startX
      const dy = e.clientY - mode.startY
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
        const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
        const nodeId = hitTestNode(cx, cy)
        if (nodeId) {
          if (selectedStepId === nodeId) {
            onStepClick?.(nodeId)
          } else {
            onStepClick?.(nodeId)
          }
        }
      }
    }

    setMode({ type: 'idle' })
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)

    // (output port context menu removed — use arrow click + delete instead)

    // Check if right-clicking on a connection line
    for (const step of steps) {
      const pos = positions[step.id]
      if (!pos) continue
      const out = getOutputPort(pos)
      for (const option of step.options) {
        if (!option.nextStepId) continue
        const targetPos = positions[option.nextStepId]
        if (!targetPos) continue

        const inp = getInputPort(targetPos)
        if (isNearBezier(cx, cy, out.x, out.y, inp.x, inp.y, 8)) {
          setContextMenu({
            x: e.clientX,
            y: e.clientY,
            optionId: option.id,
            stepId: step.id,
          })
          return
        }
      }
    }

    setContextMenu(null)
  }

  const handleDisconnect = () => {
    if (contextMenu) {
      onOptionUpdate?.(contextMenu.optionId, { nextStepId: null })
      setContextMenu(null)
    }
  }

  // Fit the whole flow into the viewport. Same math as the Fit button —
  // extracted so the button click and the auto-fit-on-mount share one code
  // path. Returns true if it actually applied a fit, so the caller can
  // decide whether to mark hasAutoFittedRef.
  const fitToView = useCallback((): boolean => {
    const container = containerRef.current
    if (!container) return false
    const w = container.clientWidth
    const h = container.clientHeight
    if (w === 0 || h === 0) return false
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const id of Object.keys(positions)) {
      const p = positions[id]
      const nodeW = id === START_ID || id === END_ID ? SPECIAL_W : NODE_W
      const nodeH = id === START_ID || id === END_ID ? SPECIAL_H : NODE_H
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x + nodeW > maxX) maxX = p.x + nodeW
      if (p.y + nodeH > maxY) maxY = p.y + nodeH
    }
    laneYByConn.forEach((laneY) => {
      if (laneY > maxY) maxY = laneY + 30
    })
    if (minX === Infinity) return false
    const contentW = Math.max(1, maxX - minX)
    const contentH = Math.max(1, maxY - minY)
    const padding = 40
    const scaleX = (w - padding * 2) / contentW
    const scaleY = (h - padding * 2) / contentH
    const newScale = Math.max(0.1, Math.min(scaleX, scaleY, 1.5))
    setScale(newScale)
    setPan({
      x: (w - contentW * newScale) / 2 - minX * newScale,
      y: (h - contentH * newScale) / 2 - minY * newScale,
    })
    return true
  }, [positions, laneYByConn])

  // Auto-fit once when the view first has content + measured dimensions.
  // Fires on mount → the user sees the whole flow immediately. Skipped
  // after the first successful fit so later edits don't yank the view.
  useEffect(() => {
    if (hasAutoFittedRef.current) return
    if (steps.length === 0) return
    if (fitToView()) hasAutoFittedRef.current = true
  }, [steps.length, fitToView])

  // Attach wheel listener to container (not canvas which has pointer-events: none)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onWheel = (e: WheelEvent) => {
      // Let scrollable popups (port picker, context menu) consume the
      // wheel instead of zooming the canvas.
      const t = e.target as HTMLElement | null
      if (t && t.closest('[data-schema-popup]')) return
      e.preventDefault()
      const oldScale = scaleRef.current
      const delta = e.deltaY > 0 ? -0.08 : 0.08
      const newScale = Math.min(2, Math.max(0.1, oldScale + delta))
      if (newScale === oldScale) return
      // Zoom around the cursor: keep the canvas point currently under the
      // cursor at the same on-screen position after the scale change.
      // Screen X in container coords → canvas X = (screenX - pan.x) / scale.
      // After scale: newPan.x = screenX - canvasX * newScale.
      const rect = container.getBoundingClientRect()
      const containerX = e.clientX - rect.left
      const containerY = e.clientY - rect.top
      const oldPan = panRef.current
      const canvasX = (containerX - oldPan.x) / oldScale
      const canvasY = (containerY - oldPan.y) / oldScale
      const newPan = {
        x: containerX - canvasX * newScale,
        y: containerY - canvasY * newScale,
      }
      setScale(newScale)
      setPan(newPan)
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

  const getCursor = () => {
    if (mode.type === 'panning') return 'grabbing'
    if (mode.type === 'dragging' || mode.type === 'dragging_group') return 'move'
    if (mode.type === 'marquee') return 'crosshair'
    if (mode.type === 'connecting' || (mode as any).type === 'connecting_reverse' || mode.type === 'reconnecting' || mode.type === 'reconnecting_source' || mode.type === 'reconnecting_button' || mode.type === 'reconnecting_button_source' || mode.type === 'reconnecting_start' || mode.type === 'reconnecting_end') return 'crosshair'
    if (hoveredPort === '__delete__' || hoveredPort === '__arrow_delete__') return 'pointer'
    if (hoveredPort === '__arrow__') return 'pointer'
    if (hoveredPort) return 'pointer'
    if (hoveredNodeId) return 'pointer'
    return 'grab'
  }

  // Resize canvas to match container
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth
      const h = container.clientHeight
      if (w > 0 && h > 0) {
        const dpr = window.devicePixelRatio || 1
        canvas.width = w * dpr
        canvas.height = h * dpr
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // Refs so the window listeners below always call the latest handlers
  // without re-registering on every render.
  const handleMouseMoveRef = useRef(handleMouseMove)
  handleMouseMoveRef.current = handleMouseMove
  const handleMouseUpRef = useRef(handleMouseUp)
  handleMouseUpRef.current = handleMouseUp

  // Capture mouse events at the window level while a mode is active — so
  // a mouseup outside the container still ends the drag. Without this,
  // fast drags leave the container mid-motion and the "hold" sticks
  // because React never sees the release.
  useEffect(() => {
    if (mode.type === 'idle') return
    const onMove = (e: MouseEvent) => handleMouseMoveRef.current(e as unknown as React.MouseEvent)
    const onUp = (e: MouseEvent) => handleMouseUpRef.current(e as unknown as React.MouseEvent)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [mode.type])

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        // Clear every hover state when the cursor leaves the container so
        // the cursor doesn't stick as pointer/hand after moving away.
        setHoveredPort(null)
        setHoveredNodeId(null)
        setHoveredArrow(null)
      }}
      onContextMenu={handleContextMenu}
      onDoubleClick={(e) => {
        const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
        const nodeId = hitTestNode(cx, cy)
        if (nodeId) {
          onStepPreview?.(nodeId)
        }
      }}
      onDragStart={(e) => e.preventDefault()}
      className="relative overflow-hidden bg-gray-50 rounded-lg border border-gray-200 select-none"
      style={{
        cursor: getCursor(),
        width: '100%',
        height: '100%',
        minHeight: '500px',
        WebkitUserDrag: 'none',
      } as React.CSSProperties}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
      />

      {/* Add Step button */}
      {onAddStep && (
        <button
          onClick={onAddStep}
          className="absolute top-3 right-3 bg-brand-500 text-white px-4 py-2 rounded-lg shadow-md hover:bg-brand-600 transition-colors text-sm font-medium flex items-center gap-2 z-10"
        >
          <span className="text-lg leading-none">+</span> Add Step
        </button>
      )}

      {/* Multi-select action bar — appears when 2+ cards are selected
          via marquee (right-drag) or Ctrl/Cmd+click. Shows the count
          and, when exactly 2 are selected AND onCombineSteps is wired,
          a Combine action that pairs them as one candidate-facing screen. */}
      {multiSelectedIds.size >= 2 && (
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-white rounded-md shadow-lg border border-gray-200 px-3 py-2 z-10"
          data-schema-popup="multi-select-bar"
        >
          <span className="text-sm text-gray-700">
            <span className="font-semibold text-gray-900">{multiSelectedIds.size}</span> cards selected
          </span>
          {multiSelectedIds.size === 2 && onCombineSteps && (() => {
            // Sort by stepOrder so the earlier step becomes the primary
            // and the later step becomes the partner (its combinedWithId).
            const ids = Array.from(multiSelectedIds)
            const sortedIds = ids
              .map((id) => ({ id, order: steps.find((s) => s.id === id)?.stepOrder ?? 0 }))
              .sort((a, b) => a.order - b.order)
              .map((x) => x.id)
            const [aId, bId] = sortedIds
            const a = steps.find((s) => s.id === aId)
            const b = steps.find((s) => s.id === bId)
            const alreadyCombined =
              (a as any)?.combinedWithId === bId || (b as any)?.combinedWithId === aId
            return (
              <button
                type="button"
                disabled={alreadyCombined}
                onClick={() => {
                  onCombineSteps(aId, bId)
                  setMultiSelectedIds(new Set())
                }}
                className={
                  'px-3 py-1 text-sm rounded-md text-white ' +
                  (alreadyCombined
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-brand-500 hover:bg-brand-600')
                }
                title={alreadyCombined ? 'Already combined' : 'Combine into one screen'}
              >
                {alreadyCombined ? 'Combined' : 'Combine'}
              </button>
            )
          })()}
          <button
            type="button"
            onClick={() => setMultiSelectedIds(new Set())}
            className="px-3 py-1 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Clear
          </button>
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-white rounded-md shadow border border-gray-200 px-1">
        <button
          onClick={() => setScale((s) => Math.max(0.1, s - 0.15))}
          className="px-2 py-1 text-gray-600 hover:text-gray-900 text-sm font-medium"
        >
          -
        </button>
        <span className="text-xs text-gray-500 w-10 text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale((s) => Math.min(2, s + 0.15))}
          className="px-2 py-1 text-gray-600 hover:text-gray-900 text-sm font-medium"
        >
          +
        </button>
        <button
          onClick={() => fitToView()}
          className="px-2 py-1 text-gray-600 hover:text-gray-900 text-xs border-l border-gray-200 ml-1"
          title="Fit flow to screen"
        >
          Fit
        </button>
        <button
          onClick={() => {
            // Clean linear cascade: each step in its own column at
            // y = 0, terminals fanned vertically at the right column.
            // Persisted so it survives reload. After laying out, refit
            // so the new bounds fit on screen.
            const laid = computeTidyLayout()
            setPositions(laid)
            onPositionsChange?.(laid)
            // Deferred fit lets React commit the new positions first so
            // fitToView sees the fresh bounds.
            setTimeout(() => fitToView(), 0)
          }}
          className="px-2 py-1 text-gray-600 hover:text-gray-900 text-xs border-l border-gray-200 ml-1"
          title="Rearrange cards on a uniform grid: main chain across, terminals down"
        >
          Tidy
        </button>
        <button
          onClick={() => { setPositions(computeLayout()); setPan({ x: 40, y: 40 }); setScale(1) }}
          className="px-2 py-1 text-gray-600 hover:text-gray-900 text-xs border-l border-gray-200 ml-1"
          title="Reset layout, zoom, and pan"
        >
          Reset
        </button>
        <button
          onClick={() => setDebugConnections((v) => !v)}
          className={`px-2 py-1 text-xs border-l border-gray-200 ml-1 ${debugConnections ? 'text-orange-600 font-semibold' : 'text-gray-600 hover:text-gray-900'}`}
          title="Toggle connection diagnostics (overlay labels + console.log)"
        >
          Debug
        </button>
      </div>

      {/* Help text */}
      <div className="absolute top-3 left-3 text-xs text-gray-400 pointer-events-none">
        Click to select &middot; Double-click to preview &middot; Drag to move &middot; Click arrow to select &middot; Drag arrowhead to reconnect
      </div>

      {/* In-app confirm modal (replaces browser confirm()) */}
      {confirmDialog && (
        <>
          <div
            className="fixed inset-0 z-[60] bg-black/40"
            onClick={() => setConfirmDialog(null)}
          />
          <div
            data-schema-popup="confirm"
            role="dialog"
            aria-modal="true"
            className="fixed z-[70] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl border border-gray-200 min-w-[340px] max-w-[440px] p-5"
          >
            <h3 className="text-base font-semibold text-gray-900">{confirmDialog.title}</h3>
            {confirmDialog.description && (
              <p className="mt-2 text-sm text-gray-600 leading-snug">{confirmDialog.description}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => {
                  const cb = confirmDialog.onConfirm
                  setConfirmDialog(null)
                  cb()
                }}
                className={
                  'px-3 py-1.5 text-sm rounded-md text-white ' +
                  (confirmDialog.destructive
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-brand-500 hover:bg-brand-600')
                }
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Context menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
          <div
            data-schema-popup="context-menu"
            className="fixed z-50 bg-white rounded-md shadow-lg border border-gray-200 py-1 min-w-[160px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              onClick={handleDisconnect}
              className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              Disconnect
            </button>
          </div>
        </>
      )}

      {/* Port click → pick a target/source step from a list */}
      {portPicker && (() => {
        const anchorId = portPicker.kind === 'out' ? portPicker.fromStepId : portPicker.targetStepId
        const anchorPos = positions[anchorId]
        const anchorX = anchorPos?.x ?? 0
        // Order per user request:
        //   1. End (out-picker only) at the top
        //   2. Cards to the right of the anchor (natural forward targets) — leftmost first
        //   3. Cards to the left of the anchor (backward loops) — rightmost first
        const others = steps.filter((s) => s.id !== anchorId)
        const rightOf: typeof others = []
        const leftOf: typeof others = []
        for (const s of others) {
          const p = positions[s.id]
          if (!p) { leftOf.push(s); continue }
          if (p.x > anchorX) rightOf.push(s)
          else leftOf.push(s)
        }
        rightOf.sort((a, b) => (positions[a.id]?.x ?? 0) - (positions[b.id]?.x ?? 0))
        leftOf.sort((a, b) => (positions[b.id]?.x ?? 0) - (positions[a.id]?.x ?? 0))
        const heading = portPicker.kind === 'out' ? 'Connect to…' : 'Connect from…'
        const isEmpty = rightOf.length + leftOf.length === 0
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPortPicker(null)} />
            <div
              data-schema-popup="port-picker"
              className="fixed z-50 bg-white rounded-md shadow-lg border border-gray-200 py-1 min-w-[220px] max-h-[320px] overflow-y-auto"
              style={{ left: portPicker.screenX, top: portPicker.screenY }}
            >
              <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-gray-400 font-medium border-b border-gray-100">
                {heading}
              </div>
              {portPicker.kind === 'out' && (
                <button
                  onClick={() => {
                    onButtonConfigUpdate?.(portPicker.fromStepId, '__end__')
                    setPortPicker(null)
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  End
                </button>
              )}
              {isEmpty && (
                <div className="px-3 py-2 text-sm text-gray-500">No other steps</div>
              )}
              {rightOf.length > 0 && (
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-gray-400 border-t border-gray-100">
                  Downstream (to the right)
                </div>
              )}
              {rightOf.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    if (portPicker.kind === 'out') onConnectSteps?.(portPicker.fromStepId, s.id)
                    else onConnectSteps?.(s.id, portPicker.targetStepId)
                    setPortPicker(null)
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors truncate"
                  title={s.title}
                >
                  {s.title || s.id.slice(0, 8)}
                </button>
              ))}
              {leftOf.length > 0 && (
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-gray-400 border-t border-gray-100">
                  Upstream (to the left)
                </div>
              )}
              {leftOf.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    if (portPicker.kind === 'out') onConnectSteps?.(portPicker.fromStepId, s.id)
                    else onConnectSteps?.(s.id, portPicker.targetStepId)
                    setPortPicker(null)
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors truncate"
                  title={s.title}
                >
                  {s.title || s.id.slice(0, 8)}
                </button>
              ))}
            </div>
          </>
        )
      })()}

      {steps.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-400">
          No steps to display
        </div>
      )}
    </div>
  )
}

// --- Drawing helpers ---

// Bezier control points for a connection.
// - laneY provided: routes the curve through that exact lane Y (used for
//   backward edges with assigned lanes so each loopback gets its own row).
// - Forward arrow with no laneY: traditional horizontal S-curve.
// - Backward arrow with no laneY (fallback): single deep drop under cards.
function bezierCps(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  laneY?: number
): readonly [number, number, number, number] {
  if (laneY !== undefined) {
    // cpOffset MUST stay < span/2 — otherwise c1.x > c2.x and the
    // bezier curls into a weird shape. Use 40 % of span (always under
    // half) with a 40 px minimum so very-short spans still curve.
    const span = Math.abs(toX - fromX)
    const cpOffset = Math.max(40, span * 0.4)
    return [fromX + cpOffset, laneY, toX - cpOffset, laneY] as const
  }
  const isBackward = toX < fromX
  if (isBackward) {
    const drop = NODE_H + 80
    return [fromX + 60, fromY + drop, toX - 60, toY + drop] as const
  }
  const dx = Math.abs(toX - fromX)
  const cpOffset = Math.max(dx * 0.4, 40)
  return [fromX + cpOffset, fromY, toX - cpOffset, toY] as const
}

function bezierMid(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  laneY?: number
): [number, number] {
  const [c1x, c1y, c2x, c2y] = bezierCps(fromX, fromY, toX, toY, laneY)
  return [
    bezierPoint(fromX, c1x, c2x, toX, 0.5),
    bezierPoint(fromY, c1y, c2y, toY, 0.5),
  ]
}

function drawConnection(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  label: string,
  isDraft: boolean,
  color?: string,
  laneY?: number,
  isHovered?: boolean,
  scale: number = 1
) {
  const lineColor = color || '#FF9500'
  const [c1x, c1y, c2x, c2y] = bezierCps(fromX, fromY, toX, toY, laneY)

  // Dashes get scaled by ctx.scale(), so at small zooms the pattern
  // collapses into a solid line. Divide by scale so the on-screen dash
  // size stays roughly constant regardless of zoom.
  const s = scale > 0 ? scale : 1
  ctx.beginPath()
  ctx.strokeStyle = isDraft ? '#FF9500' : lineColor
  ctx.lineWidth = isDraft ? 2.5 : isHovered ? 2.5 : 2
  if (isDraft) ctx.setLineDash([6 / s, 4 / s])
  else if (isHovered) ctx.setLineDash([8 / s, 5 / s])
  else ctx.setLineDash([])

  ctx.moveTo(fromX, fromY)
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, toX, toY)
  ctx.stroke()
  ctx.setLineDash([])

  // Dot endpoints instead of arrowhead
  ctx.beginPath()
  ctx.arc(fromX, fromY, 5, 0, Math.PI * 2)
  ctx.fillStyle = lineColor
  ctx.fill()

  ctx.beginPath()
  ctx.arc(toX, toY, 5, 0, Math.PI * 2)
  ctx.fillStyle = lineColor
  ctx.fill()

  // Label
  if (label) {
    const [mx, my] = bezierMid(fromX, fromY, toX, toY, laneY)
    const midX = mx
    const midY = my - 10
    const display = label.length > 18 ? label.slice(0, 16) + '...' : label

    ctx.font = '10px Inter, system-ui, sans-serif'
    const metrics = ctx.measureText(display)

    ctx.fillStyle = 'rgba(248, 250, 252, 0.9)'
    ctx.fillRect(midX - metrics.width / 2 - 5, midY - 7, metrics.width + 10, 16)
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 0.5
    ctx.strokeRect(midX - metrics.width / 2 - 5, midY - 7, metrics.width + 10, 16)

    ctx.fillStyle = '#475569'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(display, midX, midY + 1)
  }
}

function drawSpecialNode(
  ctx: CanvasRenderingContext2D,
  pos: NodePos,
  title: string,
  subtitle: string,
  isSelected: boolean,
  accentColor: string,
  bgColor: string
) {
  // Shadow
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.1)'
  ctx.shadowBlur = 10
  ctx.shadowOffsetY = 2
  ctx.beginPath()
  ctx.roundRect(pos.x, pos.y, SPECIAL_W, SPECIAL_H, 40)
  ctx.fillStyle = isSelected ? bgColor : '#ffffff'
  ctx.fill()
  ctx.restore()

  // Border
  ctx.beginPath()
  ctx.roundRect(pos.x, pos.y, SPECIAL_W, SPECIAL_H, 40)
  ctx.strokeStyle = isSelected ? accentColor : '#e2e8f0'
  ctx.lineWidth = isSelected ? 2.5 : 2
  ctx.stroke()

  // Accent bar on left
  ctx.beginPath()
  ctx.roundRect(pos.x, pos.y, 6, SPECIAL_H, [40, 0, 0, 40])
  ctx.fillStyle = accentColor
  ctx.fill()

  // Title
  ctx.font = 'bold 13px Inter, system-ui, sans-serif'
  ctx.fillStyle = '#0f172a'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(title, pos.x + SPECIAL_W / 2, pos.y + SPECIAL_H / 2 - 10)

  // Subtitle (truncated)
  ctx.font = '10px Inter, system-ui, sans-serif'
  ctx.fillStyle = '#94a3b8'
  const sub = subtitle.length > 22 ? subtitle.slice(0, 20) + '...' : subtitle
  ctx.fillText(sub, pos.x + SPECIAL_W / 2, pos.y + SPECIAL_H / 2 + 8)
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  step: Step,
  pos: NodePos,
  isSelected: boolean,
  thumb?: HTMLImageElement | HTMLCanvasElement,
  stepIndex?: number,
  aspect?: number,
  screenImg?: HTMLImageElement
) {
  const typeColors: Record<string, { accent: string; light: string }> = {
    submission: { accent: '#FF9500', light: '#FFEDD5' },
    question: { accent: '#FF9500', light: '#FFEDD5' },
    form: { accent: '#FF9500', light: '#FFEDD5' },
    info: { accent: '#FF9500', light: '#FFEDD5' },
    capture: { accent: '#FF9500', light: '#FFEDD5' },
  }
  const tc = typeColors[step.stepType] || typeColors.question

  const nodeW = NODE_W
  const thumbH = THUMB_H
  const nodeH = NODE_H

  // Shadow
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.1)'
  ctx.shadowBlur = 12
  ctx.shadowOffsetY = 3
  ctx.beginPath()
  ctx.roundRect(pos.x, pos.y, nodeW, nodeH, 12)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.restore()

  // Border — always orange, thicker when selected
  ctx.beginPath()
  ctx.roundRect(pos.x, pos.y, nodeW, nodeH, 12)
  ctx.strokeStyle = isSelected ? '#FF9500' : '#FFEDD5'
  ctx.lineWidth = isSelected ? 2.5 : 1.5
  ctx.stroke()

  // === Title bar (top 30px) ===
  const titleY = pos.y + 6
  ctx.font = 'bold 11px "Be Vietnam Pro", system-ui'
  ctx.fillStyle = '#262626'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const num = stepIndex !== undefined ? `${stepIndex + 1}. ` : ''
  const maxLen = Math.floor((nodeW - 20) / 6)
  const titleText = num + (step.title.length > maxLen - num.length ? step.title.slice(0, maxLen - num.length - 2) + '...' : step.title)
  ctx.fillText(titleText, pos.x + 12, titleY)

  // Thin line under title
  ctx.beginPath()
  ctx.moveTo(pos.x + 1, pos.y + 26)
  ctx.lineTo(pos.x + nodeW - 1, pos.y + 26)
  ctx.strokeStyle = '#F1F1F3'
  ctx.lineWidth = 1
  ctx.stroke()

  // === Thumbnail area ===
  const tX = pos.x + 8
  const tY = pos.y + 30
  const tW = nodeW - 16
  const tH = thumbH

  if (thumb) {
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(tX, tY, tW, tH, 8)
    ctx.clip()
    ctx.drawImage(thumb, tX, tY, tW, tH)
    ctx.restore()

    // Play button overlay
    const cx = tX + tW / 2
    const cy = tY + tH / 2
    ctx.beginPath()
    ctx.arc(cx, cy, 18, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(cx - 6, cy - 9)
    ctx.lineTo(cx - 6, cy + 9)
    ctx.lineTo(cx + 9, cy)
    ctx.closePath()
    ctx.fillStyle = '#ffffff'
    ctx.fill()
  } else {
    // Type-specific placeholder
    ctx.beginPath()
    ctx.roundRect(tX, tY, tW, tH, 8)
    ctx.fillStyle = tc.light
    ctx.fill()

    const cx = tX + tW / 2
    const cy = tY + tH / 2

    // Icon
    ctx.fillStyle = tc.accent
    if (step.stepType === 'submission') {
      ctx.beginPath()
      ctx.roundRect(cx - 20, cy - 12, 26, 24, 4); ctx.fill()
      ctx.beginPath()
      ctx.moveTo(cx + 10, cy - 8); ctx.lineTo(cx + 22, cy - 12); ctx.lineTo(cx + 22, cy + 12); ctx.lineTo(cx + 10, cy + 8); ctx.fill()
    } else if (step.stepType === 'question') {
      // Show question text on card
      if (step.questionText) {
        ctx.font = '11px "Be Vietnam Pro", system-ui'
        ctx.fillStyle = '#262626'
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'
        // Word wrap the question
        const words = step.questionText.split(' ')
        let line = ''
        let lineY = tY + 12
        const maxW = tW - 20
        for (const word of words) {
          const test = line + (line ? ' ' : '') + word
          if (ctx.measureText(test).width > maxW && line) {
            ctx.fillText(line, tX + 10, lineY)
            line = word; lineY += 16
            if (lineY > tY + tH - 30) break
          } else { line = test }
        }
        if (line && lineY <= tY + tH - 30) ctx.fillText(line, tX + 10, lineY)
      } else {
        ctx.font = 'bold 28px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillStyle = tc.accent
        ctx.fillText('?', cx, cy - 15)
      }
      // Show option previews
      const optY = tY + tH - 8 - Math.min(step.options.length, 3) * 18
      step.options.slice(0, 3).forEach((opt, i) => {
        ctx.beginPath()
        ctx.roundRect(tX + 8, optY + i * 18, tW - 16, 14, 4)
        ctx.fillStyle = '#FF9500'
        ctx.fill()
        ctx.font = 'bold 8px "Be Vietnam Pro", system-ui'
        ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
        const optText = opt.optionText.length > 28 ? opt.optionText.slice(0, 26) + '...' : opt.optionText
        ctx.fillText(optText, tX + 14, optY + i * 18 + 7)
      })
    } else if (step.stepType === 'form') {
      const fields = ['Full Name', 'Email', 'Phone']
      fields.forEach((f, i) => {
        const fy = tY + 12 + i * 28
        ctx.font = '9px "Be Vietnam Pro", system-ui'
        ctx.fillStyle = '#59595A'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
        ctx.fillText(f, tX + 10, fy)
        ctx.beginPath(); ctx.roundRect(tX + 10, fy + 13, tW - 20, 12, 3)
        ctx.fillStyle = '#ffffff'; ctx.fill()
        ctx.strokeStyle = '#E4E4E7'; ctx.lineWidth = 1; ctx.stroke()
      })
    } else {
      // Screen step — fill thumbnail with visible orange tint
      ctx.beginPath(); ctx.roundRect(tX, tY, tW, tH, 8)
      ctx.fillStyle = '#FFEDD5'; ctx.fill()

      const imgUrl = (step as any).formConfig?.imageUrl
      const loadedImg = screenImg
      const infoText = (step as any).infoContent || ''
      const btnCfg = (step as any).buttonConfig as { enabled?: boolean; text?: string } | null
      const hasImage = imgUrl && loadedImg
      const imgH = hasImage ? 65 : 0
      const btnH = btnCfg?.enabled ? 16 : 0
      const textAreaTop = tY + 6 + imgH + (hasImage ? 6 : 0)
      const textAreaBottom = tY + tH - 6 - btnH - (btnH ? 6 : 0)

      // Image at top — cover crop
      if (hasImage) {
        ctx.save()
        ctx.beginPath(); ctx.roundRect(tX + 4, tY + 4, tW - 8, imgH, 4); ctx.clip()
        // Cover crop
        const iw = loadedImg.width, ih = loadedImg.height
        const ratio = (tW - 8) / imgH
        const imgRatio = iw / ih
        let sx = 0, sy = 0, sw = iw, sh = ih
        if (imgRatio > ratio) { sw = ih * ratio; sx = (iw - sw) / 2 }
        else { sh = iw / ratio; sy = (ih - sh) / 2 }
        ctx.drawImage(loadedImg, sx, sy, sw, sh, tX + 4, tY + 4, tW - 8, imgH)
        ctx.restore()
      } else if (imgUrl) {
        ctx.fillStyle = '#FFEDD5'
        ctx.beginPath(); ctx.roundRect(tX + 4, tY + 4, tW - 8, 50, 4); ctx.fill()
        ctx.fillStyle = '#FF950060'
        ctx.font = '9px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText('Loading image...', tX + tW / 2, tY + 29)
      }

      // Text content
      if (infoText) {
        ctx.font = '9px "Be Vietnam Pro", system-ui'
        ctx.fillStyle = '#262626'
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'
        const words = infoText.split(' ')
        let line = ''; let ly = textAreaTop + 4
        for (const word of words) {
          const test = line + (line ? ' ' : '') + word
          if (ctx.measureText(test).width > tW - 20 && line) {
            ctx.fillText(line, tX + 8, ly); line = word; ly += 13
            if (ly > textAreaBottom - 4) break
          } else { line = test }
        }
        if (line && ly <= textAreaBottom - 4) ctx.fillText(line, tX + 8, ly)
      } else if (!hasImage) {
        // Placeholder lines only if no image
        ctx.fillStyle = '#FF950020'
        const startY = tY + 15
        ctx.beginPath(); ctx.roundRect(tX + 8, startY, tW - 16, 8, 2); ctx.fill()
        ctx.beginPath(); ctx.roundRect(tX + 8, startY + 14, (tW - 16) * 0.65, 8, 2); ctx.fill()
        ctx.beginPath(); ctx.roundRect(tX + 8, startY + 28, (tW - 16) * 0.8, 8, 2); ctx.fill()
      }

      // Orange button at bottom
      if (btnCfg?.enabled) {
        const btnY = tY + tH - 4 - 14
        ctx.beginPath(); ctx.roundRect(tX + 8, btnY, tW - 16, 14, 4)
        ctx.fillStyle = '#FF9500'; ctx.fill()
        ctx.font = 'bold 8px "Be Vietnam Pro", system-ui'
        ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(btnCfg.text || 'Continue', tX + tW / 2, btnY + 7)
      }
    }
  }

  // === Bottom answer/info bar ===
  const barY = tY + tH + 4
  const barH = 28

  if (step.stepType === 'question' && step.options.length > 0) {
    // Show answer count in orange
    ctx.font = '10px "Be Vietnam Pro", system-ui'
    ctx.fillStyle = '#FF9500'
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText(`${step.options.length} answer${step.options.length !== 1 ? 's' : ''}`, pos.x + 12, barY + barH / 2)
  } else {
    const btnCfg = (step as any).buttonConfig as { enabled?: boolean; text?: string } | null
    if (btnCfg?.enabled && step.stepType !== 'info') {
      // Orange action button (skip for screen steps — they show it in thumbnail)
      ctx.beginPath()
      ctx.roundRect(pos.x + 8, barY, tW, barH, 6)
      ctx.fillStyle = '#FF9500'
      ctx.fill()
      ctx.font = 'bold 10px "Be Vietnam Pro", system-ui'
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(btnCfg.text || 'Continue', pos.x + 8 + tW / 2, barY + barH / 2)
    } else if (step.stepType !== 'info') {
      // Type label (skip for screen steps — they show everything in thumbnail)
      const labels: Record<string, string> = { submission: 'Video', question: 'Question', form: 'Form', capture: 'Audio Answer' }
      ctx.font = '10px "Be Vietnam Pro", system-ui'
      ctx.fillStyle = '#59595A'
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(labels[step.stepType] || 'Step', pos.x + 12, barY + barH / 2)
    }
  }

  // Order badge — uses the same BFS-depth-based stage number as the
  // title prefix (passed via stepIndex), so forked branches at the same
  // depth share a number rather than each grabbing its own sequence slot.
  ctx.beginPath()
  ctx.arc(pos.x + NODE_W - 16, pos.y + 16, 11, 0, Math.PI * 2)
  ctx.fillStyle = isSelected ? '#FF9500' : '#FFEDD5'
  ctx.fill()
  ctx.strokeStyle = isSelected ? '#EA8500' : '#FFEDD5'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.font = 'bold 10px system-ui'
  ctx.fillStyle = isSelected ? '#fff' : '#FF9500'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const badgeNum = stepIndex !== undefined ? stepIndex + 1 : step.stepOrder + 1
  ctx.fillText(String(badgeNum), pos.x + NODE_W - 16, pos.y + 16)

  // Delete button (only when selected)
  if (isSelected) {
    const dx = pos.x - 6
    const dy = pos.y - 6
    const dr = 12
    ctx.beginPath()
    ctx.arc(dx, dy, dr, 0, Math.PI * 2)
    ctx.fillStyle = '#FF9500'
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.stroke()
    // X icon
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(dx - 4, dy - 4)
    ctx.lineTo(dx + 4, dy + 4)
    ctx.moveTo(dx + 4, dy - 4)
    ctx.lineTo(dx - 4, dy + 4)
    ctx.stroke()
  }
}

function bezierPoint(p0: number, p1: number, p2: number, p3: number, t: number) {
  const mt = 1 - t
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3
}

function isNearBezier(
  px: number,
  py: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  threshold: number,
  laneY?: number
): boolean {
  const [c1x, c1y, c2x, c2y] = bezierCps(fromX, fromY, toX, toY, laneY)
  for (let t = 0; t <= 1; t += 0.02) {
    const bx = bezierPoint(fromX, c1x, c2x, toX, t)
    const by = bezierPoint(fromY, c1y, c2y, toY, t)
    if (dist(px, py, bx, by) < threshold) return true
  }
  return false
}

// Perpendicular distance from (px,py) to the line segment from
// (x1,y1) to (x2,y2). Used for straight-line hit testing on End
// arrows, where beziers guarantee crossings but straight lines with
// a shared endpoint cannot cross before that endpoint.
function distToSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return dist(px, py, x1, y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return dist(px, py, x1 + t * dx, y1 + t * dy)
}

function drawPortCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  isHovered: boolean,
  isConnected: boolean
) {
  ctx.beginPath()
  ctx.arc(x, y, PORT_R, 0, Math.PI * 2)
  ctx.fillStyle = isHovered ? '#FF9500' : isConnected ? '#FF9500' : '#FFEDD5'
  ctx.fill()
  ctx.strokeStyle = isHovered ? '#EA8500' : isConnected ? '#EA8500' : '#FFD9A0'
  ctx.lineWidth = 2
  ctx.stroke()
}

function drawDragHandle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string = '#FF9500') {
  ctx.beginPath()
  ctx.arc(x, y, 13, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2.5
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 10px system-ui'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('\u2194', x, y)
}

function drawDeleteButton(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath()
  ctx.arc(x, y, 12, 0, Math.PI * 2)
  ctx.fillStyle = '#FF9500'
  ctx.fill()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x - 4, y - 4)
  ctx.lineTo(x + 4, y + 4)
  ctx.moveTo(x + 4, y - 4)
  ctx.lineTo(x - 4, y + 4)
  ctx.stroke()
}

function drawInsertButton(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  hovered: boolean
) {
  const r = hovered ? 11 : 8
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = hovered ? '#FF9500' : '#ffffff'
  ctx.fill()
  ctx.strokeStyle = hovered ? '#ffffff' : '#FF9500'
  ctx.lineWidth = hovered ? 2 : 1.5
  ctx.stroke()

  ctx.strokeStyle = hovered ? '#ffffff' : '#FF9500'
  ctx.lineWidth = hovered ? 2 : 1.5
  ctx.lineCap = 'round'
  const arm = hovered ? 4.5 : 3.5
  ctx.beginPath()
  ctx.moveTo(x - arm, y)
  ctx.lineTo(x + arm, y)
  ctx.moveTo(x, y - arm)
  ctx.lineTo(x, y + arm)
  ctx.stroke()
  ctx.restore()
}
