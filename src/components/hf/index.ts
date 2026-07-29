/**
 * HireFunnel object primitives.
 *
 * Every hiring object surface (Candidate, Position, Pipeline, Stage,
 * Training, Automation, BookingPage) is composed from this set:
 *
 *   ObjectShell          — header, uncertainty row, info cards, slots
 *   HealthBadge          — 🟢 🟡 🔴 status pill for any object
 *   PrimaryActionButton  — the single primary CTA per surface (UX rule #5)
 *   Recommendations      — panel of actionable heuristics (UX rule #7 — never labelled "AI")
 *   Drawer               — size-aware side-in edit surface
 *   Timeline             — the single activity-feed component (event-bus in Phase 1)
 *
 * See src/lib/hf-core/types.ts for the underlying object contract and
 * docs/ux-vision.md for the design rationale. Adding a new primitive here
 * belongs in the vision document first.
 */

export { HealthBadge, type HealthBadgeProps } from './HealthBadge'
export { PrimaryActionButton, type PrimaryActionButtonProps } from './PrimaryActionButton'
export { Recommendations, type RecommendationsProps } from './Recommendations'
export { Drawer, type DrawerProps, type DrawerSize } from './Drawer'
export { Timeline, type TimelineProps } from './Timeline'
export { ObjectShell, type ObjectShellProps } from './ObjectShell'
