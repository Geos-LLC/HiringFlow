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
  onChangeEndStep?: (stepId: string) => void
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
  onChangeEndStep,
  onAddStep,
  onInsertStepOnArrow,
  onButtonConfigUpdate,
  onClearStartScreen,
  onClearEndScreen,
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
  const [hoveredArrow, setHoveredArrow] = useState<
    | { kind: 'option'; optionId: string; fromStepId: string }
    | { kind: 'button'; fromStepId: string }
    | { kind: 'start' }
    | { kind: 'end'; fromStepId: string }
    | null
  >(null)
  const [selectedArrow, setSelectedArrow] = useState<SelectedArrow | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; optionId: string; stepId: string } | null>(null)

  // Refs for animation loop access
  const posRef = useRef(positions)
  posRef.current = positions
  const modeRef = useRef(mode)
  modeRef.current = mode

  // Keyboard: Delete/Backspace deletes selected step
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

        // Only delete if the step actually exists in the current steps array
        if (selectedStepId && selectedStepId !== START_ID && selectedStepId !== END_ID) {
          const stepExists = steps.some(s => s.id === selectedStepId)
          if (!stepExists) return
          e.preventDefault()
          if (confirm('Delete this step?')) {
            onDeleteStep?.(selectedStepId)
          }
        } else if (selectedArrow) {
          e.preventDefault()
          if (confirm('Remove this connection?')) {
            if (selectedArrow.kind === 'button') {
              onButtonConfigUpdate?.(selectedArrow.stepId, null)
            } else if (selectedArrow.kind === 'start') {
              onClearStartScreen?.()
            } else if (selectedArrow.kind === 'end') {
              onClearEndScreen?.()
            } else if (selectedArrow.kind === 'option' || !selectedArrow.kind) {
              onOptionUpdate?.(selectedArrow.optionId, { nextStepId: null })
            }
            setSelectedArrow(null)
          }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedStepId, selectedArrow, onDeleteStep, onOptionUpdate, onButtonConfigUpdate, onClearStartScreen, onClearEndScreen])

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
  // sitting inside the source→target corridor — or undefined if there's
  // nothing in the way. excludeIds covers the connection's own
  // endpoints so they don't count as obstacles.
  const computeDetourLane = useCallback(
    (fromX: number, fromY: number, toX: number, toY: number, excludeIds: Set<string>) => {
      if (toX <= fromX) return undefined
      const minPathY = Math.min(fromY, toY) - 16
      const maxPathY = Math.max(fromY, toY) + 16
      let blockMinTop = Infinity
      let blockMaxBot = -Infinity
      for (const s of steps) {
        if (excludeIds.has(s.id)) continue
        const p = positions[s.id]
        if (!p) continue
        if (p.x + NODE_W <= fromX + 4 || p.x >= toX - 4) continue
        if (p.y + NODE_H < minPathY || p.y > maxPathY) continue
        if (p.y < blockMinTop) blockMinTop = p.y
        if (p.y + NODE_H > blockMaxBot) blockMaxBot = p.y + NODE_H
      }
      if (blockMinTop === Infinity) return undefined
      // Wider clearance — the bezier still has Y momentum coming out of
      // the lane, so leave plenty of room so the rise/dip doesn't clip
      // the blocker as the curve transitions back to its endpoint.
      const aboveLane = blockMinTop - 70
      const belowLane = blockMaxBot + 70
      const avg = (fromY + toY) / 2
      return Math.abs(avg - aboveLane) <= Math.abs(avg - belowLane) ? aboveLane : belowLane
    },
    [steps, positions]
  )

  const laneYByConn = useMemo(() => {
    const m = new Map<string, number>()
    if (allConnections.length === 0) return m

    // --- 1) Backward edges: route below all cards in lanes by span. ---
    const backward = allConnections.filter((c) => {
      const sp = positions[c.sourceId]
      const tp = positions[c.targetId]
      if (!sp || !tp) return false
      return tp.x < sp.x
    })
    let maxBottom = 0
    for (const id of Object.keys(positions)) {
      const p = positions[id]
      const h = id === START_ID || id === END_ID ? SPECIAL_H : NODE_H
      maxBottom = Math.max(maxBottom, p.y + h)
    }
    if (backward.length > 0) {
      backward.sort((a, b) => {
        const aSpan = Math.abs(positions[a.sourceId].x - positions[a.targetId].x)
        const bSpan = Math.abs(positions[b.sourceId].x - positions[b.targetId].x)
        return bSpan - aSpan
      })
      const laneBase = maxBottom + 80
      const laneSpacing = 60
      backward.forEach((c, idx) => {
        m.set(connKey(c), laneBase + idx * laneSpacing)
      })
    }

    // --- 2) Forward edges that would clip through intermediate cards. ---
    for (const c of allConnections) {
      if (m.has(connKey(c))) continue // already routed (backward)
      const sp = positions[c.sourceId]
      const tp = positions[c.targetId]
      if (!sp || !tp) continue
      if (tp.x <= sp.x) continue
      const out = getOutputPort(sp)
      const inp = getInputPort(tp)
      const lane = computeDetourLane(out.x, out.y, inp.x, inp.y, new Set([c.sourceId, c.targetId]))
      if (lane !== undefined) m.set(connKey(c), lane)
    }

    return m
  }, [allConnections, positions, connKey, computeDetourLane])

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
      if (dist(cx, cy, out.x, out.y) <= PORT_R + 4) {
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
      if (dist(cx, cy, inp.x, inp.y) <= PORT_R + 4) {
        return step.id
      }
    }
    return null
  }, [steps])

  // Hit test: arrow line (returns the option that owns it)
  const hitTestArrow = useCallback((cx: number, cy: number): { optionId: string; stepId: string; kind: 'option' | 'button' } | null => {
    for (const step of steps) {
      const pos = posRef.current[step.id]
      if (!pos) continue
      const out = getOutputPort(pos)
      for (const option of step.options) {
        if (!option.nextStepId) continue
        const targetPos = posRef.current[option.nextStepId]
        if (!targetPos) continue
        const inp = getInputPort(targetPos)
        const lane = laneYByConn.get(`opt:${step.id}:${option.id}`)
        if (isNearBezier(cx, cy, out.x, out.y, inp.x, inp.y, 10, lane)) {
          return { optionId: option.id, stepId: step.id, kind: 'option' }
        }
      }
      const btnNext = (step as any).buttonConfig?.nextStepId
      if (btnNext && btnNext !== '__end__') {
        const targetPos = posRef.current[btnNext]
        if (targetPos) {
          const inp = getInputPort(targetPos)
          const lane = laneYByConn.get(`btn:${step.id}:${btnNext}`)
          if (isNearBezier(cx, cy, out.x, out.y, inp.x, inp.y, 10, lane)) {
            return { optionId: BUTTON_ARROW_SENTINEL, stepId: step.id, kind: 'button' }
          }
        }
      }
    }
    return null
  }, [steps, laneYByConn])

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
    const implicitEndIds = getEndStepIds()

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
        drawConnection(ctx, fromX, fromY, toX, toY, '', false, isStartArrowSelected ? '#FF9500' : '#FF9500', startLane)

        const [sMidX, sMidY] = bezierMid(fromX, fromY, toX, toY, startLane)

        if (isStartArrowSelected) {
          drawDragHandle(ctx, toX, toY)
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
      const sourcePos = positions[conn.sourceId]
      const targetPos = positions[conn.targetId]
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

      drawConnection(ctx, out.x, out.y, inp.x, inp.y, displayLabel, false, '#FF9500', laneY)

      const [midX, midY] = bezierMid(out.x, out.y, inp.x, inp.y, laneY)

      if (isSelected) {
        drawDragHandle(ctx, inp.x, inp.y)
        drawDragHandle(ctx, out.x, out.y)
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

    // End connections — from every reachable terminal step + any step
    // explicitly set to End via buttonConfig.
    const endPos = positions[END_ID]
    if (endPos && endMessage !== '') {
      const toX = endPos.x
      const toY = endPos.y + SPECIAL_H / 2
      const drawnEndFrom = new Set<string>(implicitEndIds)

      for (const step of steps) {
        if ((step as any).buttonConfig?.nextStepId === '__end__') {
          drawnEndFrom.add(step.id)
        }
      }

      drawnEndFrom.forEach(stepId => {
        const eStepPos = positions[stepId]
        if (!eStepPos) return
        const fromX = eStepPos.x + NODE_W
        const fromY = eStepPos.y + NODE_H / 2
        // Detour around any cards sitting between this source and the End
        // node, same way option/button arrows do.
        const endLane = computeDetourLane(fromX, fromY, toX, toY, new Set([stepId]))
        drawConnection(ctx, fromX, fromY, toX, toY, '', false, '#FF9500', endLane)

        // Implicit-End arrows (terminal reachable steps) get the +/delete UI;
        // buttonConfig=__end__ arrows are handled via button-arrow logic.
        if (!implicitEndIds.has(stepId)) return
        const isThisEndSelected =
          selectedArrow?.kind === 'end' && selectedArrow.stepId === stepId
        const [eMidX, eMidY] = bezierMid(fromX, fromY, toX, toY, endLane)

        if (isThisEndSelected) {
          drawDragHandle(ctx, fromX, fromY)
          drawDeleteButton(ctx, eMidX, eMidY)
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

      // Draw single OUTPUT port (right side)
      const out = getOutputPort(pos)
      const isOutHovered = hoveredPort === `out_${step.id}`
      const hasOutgoing = step.options.some((o) => o.nextStepId)
      drawPortCircle(ctx, out.x, out.y, isOutHovered, hasOutgoing)

      // Draw single INPUT port (left side)
      const inp = getInputPort(pos)
      const isInpHovered = hoveredPort === `inp_${step.id}`
      const hasIncoming = steps.some((s) => s.options.some((o) => o.nextStepId === step.id))
        || step.id === sorted[0]?.id
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
        if (fp) drawDragHandle(ctx, fp.x, fp.y + NODE_H / 2)
      } else if (selectedArrow.kind === 'end') {
        const sPos = positions[selectedArrow.stepId]
        if (sPos) drawDragHandle(ctx, sPos.x + NODE_W, sPos.y + NODE_H / 2)
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
          drawDragHandle(ctx, o.x, o.y)
        }
        if (targetPos) {
          const i = getInputPort(targetPos)
          drawDragHandle(ctx, i.x, i.y)
        }
      }
    }

    // Draw draft connection line while dragging
    if (mode.type === 'connecting') {
      drawConnection(ctx, mode.fromX, mode.fromY, (mode as any).mouseX, (mode as any).mouseY, '', true)
    }
    if ((mode as any).type === 'connecting_reverse') {
      drawConnection(ctx, (mode as any).mouseX, (mode as any).mouseY, (mode as any).fromX, (mode as any).fromY, '', true)
    }

    ctx.restore()
  }, [positions, thumbnails, screenImages, videoAspects, pan, scale, steps, selectedStepId, hoveredPort, hoveredArrow, mode, startMessage, endMessage, getEndStepIds, selectedArrow, allConnections, laneYByConn, connKey, debugConnections, stageNumberByStep, computeDetourLane])

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
  // option, button, start, and implicit end arrows.
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
      const ePos = posRef.current[END_ID]
      const sPos = posRef.current[selectedArrow.stepId]
      if (!ePos || !sPos) return false
      const [midX, midY] = bezierMid(
        sPos.x + NODE_W,
        sPos.y + NODE_H / 2,
        ePos.x,
        ePos.y + SPECIAL_H / 2,
      )
      return dist(cx, cy, midX, midY) <= 14
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
  }, [selectedArrow, steps, laneYByConn])

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

      // End arrows (every terminal reachable step)
      if (endMessage !== '') {
        const ePos = posRef.current[END_ID]
        if (ePos) {
          const ends = getEndStepIds()
          let result: { kind: 'end'; fromStepId: string } | null = null
          ends.forEach((sid) => {
            if (result) return
            if (selectedArrow?.kind === 'end' && selectedArrow.stepId === sid) return
            const sPos = posRef.current[sid]
            if (!sPos) return
            const fromX = sPos.x + NODE_W
            const fromY = sPos.y + NODE_H / 2
            const toX = ePos.x
            const toY = ePos.y + SPECIAL_H / 2
            if (tryMid(fromX, fromY, toX, toY)) result = { kind: 'end', fromStepId: sid }
          })
          if (result) return result
        }
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
    [steps, selectedArrow, startMessage, endMessage, getEndStepIds, laneYByConn]
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

      // End arrows (implicit) — any terminal reachable step's arrow to End.
      if (endMessage !== '') {
        const ePos = posRef.current[END_ID]
        if (ePos) {
          const toX = ePos.x
          const toY = ePos.y + SPECIAL_H / 2
          const ends = getEndStepIds()
          let hovered: string | null = null
          ends.forEach((sid) => {
            if (hovered) return
            if (selectedArrow?.kind === 'end' && selectedArrow.stepId === sid) return
            const sPos = posRef.current[sid]
            if (!sPos) return
            const fromX = sPos.x + NODE_W
            const fromY = sPos.y + NODE_H / 2
            if (isNearBezier(cx, cy, fromX, fromY, toX, toY, 12)) hovered = sid
          })
          if (hovered) return { kind: 'end', fromStepId: hovered }
        }
      }

      for (const step of steps) {
        const pos = posRef.current[step.id]
        if (!pos) continue
        const out = getOutputPort(pos)

        for (const option of step.options) {
          if (!option.nextStepId) continue
          if (selectedArrow?.optionId === option.id) continue
          const targetPos = posRef.current[option.nextStepId]
          if (!targetPos) continue
          const inp = getInputPort(targetPos)
          const lane = laneYByConn.get(`opt:${step.id}:${option.id}`)
          if (isNearBezier(cx, cy, out.x, out.y, inp.x, inp.y, 12, lane)) {
            return { kind: 'option', optionId: option.id, fromStepId: step.id }
          }
        }

        // Skip button arrow if it's currently selected
        const isThisButtonSelected =
          selectedArrow?.kind === 'button' && selectedArrow.stepId === step.id
        if (isThisButtonSelected) continue
        const btnNext = (step as any).buttonConfig?.nextStepId
        if (btnNext && btnNext !== '__end__') {
          const targetPos = posRef.current[btnNext]
          if (targetPos) {
            const inp = getInputPort(targetPos)
            const lane = laneYByConn.get(`btn:${step.id}:${btnNext}`)
            if (isNearBezier(cx, cy, out.x, out.y, inp.x, inp.y, 12, lane)) {
              return { kind: 'button', fromStepId: step.id }
            }
          }
        }
      }
      return null
    },
    [steps, selectedArrow, startMessage, endMessage, getEndStepIds, laneYByConn]
  )

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) return // right click handled separately
    setContextMenu(null)

    const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
    const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
    const implicitEndIds = getEndStepIds()
    const endPos = positions[END_ID]

    // DEBUG: log click info
    const nodeHit = hitTestNode(cx, cy)

    // Check node delete button first
    const deleteTarget = hitTestDeleteButton(cx, cy)
    if (deleteTarget) {
      onDeleteStep?.(deleteTarget)
      return
    }

    // Check arrow delete button (option, button, start, end arrows)
    if (
      (selectedArrow?.kind === 'option' ||
        selectedArrow?.kind === 'button' ||
        selectedArrow?.kind === 'start' ||
        selectedArrow?.kind === 'end') &&
      hitTestArrowDelete(cx, cy)
    ) {
      if (selectedArrow.kind === 'button') {
        onButtonConfigUpdate?.(selectedArrow.stepId, null)
      } else if (selectedArrow.kind === 'start') {
        onClearStartScreen?.()
      } else if (selectedArrow.kind === 'end') {
        onClearEndScreen?.()
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
        if (dist(cx, cy, toX, toY) <= 18) {
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
        if (dist(cx, cy, fromX, fromY) <= 18) {
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
          // Target endpoint
          if (dist(cx, cy, inp.x, inp.y) <= 18) {
            const out = getOutputPort(srcPos)
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
          const out = getOutputPort(srcPos)
          if (dist(cx, cy, out.x, out.y) <= 18) {
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
        }
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
        if (dist(cx, cy, srcOut.x, srcOut.y) <= 18) {
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
          }
        }
      }
    }

    // Check output ports (right side — for starting a new connection)
    const outPortStepId = hitTestOutputPort(cx, cy)
    if (outPortStepId) {
      const pos = positions[outPortStepId]
      if (pos) {
        const out = getOutputPort(pos)
        setSelectedArrow(null)
        setMode({
          type: 'connecting',
          fromStepId: outPortStepId,
          fromX: out.x,
          fromY: out.y,
          mouseX: cx,
          mouseY: cy,
        })
        return
      }
    }

    // Check input ports (left side — reverse connection: drag to find source)
    const inpPortStepId = hitTestInputPort(cx, cy)
    if (inpPortStepId) {
      const pos = positions[inpPortStepId]
      if (pos) {
        const inp = getInputPort(pos)
        setSelectedArrow(null)
        setMode({
          type: 'connecting_reverse',
          targetStepId: inpPortStepId,
          fromX: inp.x,
          fromY: inp.y,
          mouseX: cx,
          mouseY: cy,
        } as any)
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

    // Check End arrow click — pick whichever terminal step's End arrow is hit.
    if (endPos && implicitEndIds.size > 0 && endMessage !== '') {
      const toX = endPos.x
      const toY = endPos.y + SPECIAL_H / 2
      let hitStepId: string | null = null
      implicitEndIds.forEach((sid) => {
        if (hitStepId) return
        const ePos = positions[sid]
        if (!ePos) return
        const fromX = ePos.x + NODE_W
        const fromY = ePos.y + NODE_H / 2
        if (isNearBezier(cx, cy, fromX, fromY, toX, toY, 10)) hitStepId = sid
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

    // Clicking empty space deselects everything
    setSelectedArrow(null)
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
    if (mode.type === 'reconnecting') {
      const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
      // Accept drop on input port OR anywhere on a node
      let targetStep = hitTestInputPort(cx, cy)
      if (!targetStep) {
        const nodeId = hitTestNode(cx, cy)
        if (nodeId && nodeId !== START_ID && nodeId !== END_ID) targetStep = nodeId
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
      if (outStepId && outStepId !== steps.find((s) => s.options.some((o) => o.id === mode.optionId))?.id) {
        // Disconnect old option, create connection from new step
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
      if (!targetStep) {
        const nodeId = hitTestNode(cx, cy)
        if (nodeId && nodeId !== START_ID && nodeId !== END_ID) targetStep = nodeId
      }
      if (targetStep && targetStep !== mode.fromStepId) {
        onButtonConfigUpdate?.(mode.fromStepId, targetStep)
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
        // Move buttonConfig.nextStepId from old source step to new source step
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
      const nodeId = hitTestNode(cx, cy)
      if (nodeId && nodeId !== START_ID && nodeId !== END_ID && nodeId !== mode.fromStepId) {
        onChangeEndStep?.(nodeId)
      }
      setSelectedArrow(null)
      setHoveredPort(null)
      setMode({ type: 'idle' })
      return
    }

    if (mode.type === 'connecting') {
      const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
      let targetStep = hitTestInputPort(cx, cy)
      if (!targetStep) {
        const nodeId = hitTestNode(cx, cy)
        if (nodeId && nodeId !== START_ID && nodeId !== END_ID) targetStep = nodeId
      }

      if (targetStep && targetStep !== mode.fromStepId) {
        onConnectSteps?.(mode.fromStepId, targetStep)
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

  // Attach wheel listener to container (not canvas which has pointer-events: none)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.08 : 0.08
      setScale((s) => Math.min(2, Math.max(0.3, s + delta)))
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

  const getCursor = () => {
    if (mode.type === 'panning') return 'grabbing'
    if (mode.type === 'dragging' || mode.type === 'dragging_group') return 'move'
    if (mode.type === 'connecting' || (mode as any).type === 'connecting_reverse' || mode.type === 'reconnecting' || mode.type === 'reconnecting_source' || mode.type === 'reconnecting_button' || mode.type === 'reconnecting_button_source' || mode.type === 'reconnecting_start' || mode.type === 'reconnecting_end') return 'crosshair'
    if (hoveredPort === '__delete__' || hoveredPort === '__arrow_delete__') return 'pointer'
    if (hoveredPort === '__arrow__') return 'pointer'
    if (hoveredPort) return 'pointer'
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

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => { setMode({ type: 'idle' }); setHoveredPort(null) }}
      onContextMenu={handleContextMenu}
      onDoubleClick={(e) => {
        const { x: cx, y: cy } = toCanvas(e.clientX, e.clientY)
        const nodeId = hitTestNode(cx, cy)
        if (nodeId) {
          onStepPreview?.(nodeId)
        }
      }}
      className="relative overflow-hidden bg-gray-50 rounded-lg border border-gray-200"
      style={{ cursor: getCursor(), width: '100%', height: '100%', minHeight: '500px' }}
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
          onClick={() => {
            const container = containerRef.current
            if (!container) return
            const w = container.clientWidth
            const h = container.clientHeight
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
            // Also include backward-edge lane Ys so loopback paths fit too
            laneYByConn.forEach((laneY) => {
              if (laneY > maxY) maxY = laneY + 30
            })
            if (minX === Infinity) return
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
          }}
          className="px-2 py-1 text-gray-600 hover:text-gray-900 text-xs border-l border-gray-200 ml-1"
          title="Fit flow to screen"
        >
          Fit
        </button>
        <button
          onClick={() => { setPositions(computeLayout()); setPan({ x: 40, y: 40 }); setScale(1) }}
          className="px-2 py-1 text-gray-600 hover:text-gray-900 text-xs border-l border-gray-200 ml-1"
          title="Reset layout"
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

      {/* Context menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
          <div
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
    // Wide control-point offset for lane-routed bezier so the
    // transition into / out of the lane is gentle enough not to clip
    // intermediate cards that sit close to the endpoints.
    const span = Math.abs(toX - fromX)
    const cpOffset = Math.max(120, span * 0.3)
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
  laneY?: number
) {
  const lineColor = color || '#FF9500'
  const [c1x, c1y, c2x, c2y] = bezierCps(fromX, fromY, toX, toY, laneY)

  ctx.beginPath()
  ctx.strokeStyle = isDraft ? '#FF9500' : lineColor
  ctx.lineWidth = isDraft ? 2.5 : 2
  if (isDraft) ctx.setLineDash([6, 4])
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

function drawDragHandle(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath()
  ctx.arc(x, y, 13, 0, Math.PI * 2)
  ctx.fillStyle = '#FF9500'
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
