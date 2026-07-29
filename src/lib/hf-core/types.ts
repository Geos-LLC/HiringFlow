import type { ReactNode } from 'react'

/**
 * HireFunnel core object contract.
 *
 * Every hiring object in the product — Candidate, Position, Pipeline, Stage,
 * Training, Automation, BookingPage — implements `HFObject`. UI is generated
 * from the contract using the primitives under `src/components/hf/`.
 *
 * This file is intentionally pure TypeScript with no runtime imports so it
 * can be shared between server (route handlers, cron, analytics) and client
 * (React components) without pulling Prisma or Node-only modules into a
 * client bundle.
 *
 * See docs/ux-vision.md § 2–5 for the design rationale. Do not add fields to
 * `HFObject` without updating the vision doc — the contract is the interface
 * the whole product renders through, and drift here fragments the design
 * language.
 */

// ─── Object kinds ────────────────────────────────────────────────────────────

export type HFObjectKind =
  | 'candidate'
  | 'position'
  | 'pipeline'
  | 'stage'
  | 'training'
  | 'automation'
  | 'bookingPage'

// ─── Health ──────────────────────────────────────────────────────────────────

export type HealthStatus = 'green' | 'yellow' | 'red' | 'unknown'

export interface Health {
  status: HealthStatus
  /** Short human label. Rule: verb-or-noun-phrase, not sentence. e.g. "On track", "Interview bottleneck". */
  label: string
  /** Optional one-liner. Shown as tooltip / secondary text under the badge. */
  detail?: string
}

// ─── Primary action ─────────────────────────────────────────────────────────

export interface PrimaryAction {
  /** Verb the user reads on the button. Chosen dynamically per current state. */
  verb: string
  /** Descriptive kind so the UI can pick an icon or styling; freeform string. */
  kind?: 'advance' | 'help' | 'improve' | 'configure' | 'reactivate' | 'other'
  /** If set, the action is disabled and this string explains why. */
  disabled?: string
  /**
   * Target of the action. Either a URL to navigate to, a drawer id to open,
   * or `null` for an inert placeholder. Purely metadata — the parent screen
   * wires the actual handler. This keeps the contract serialisable.
   */
  target:
    | { kind: 'href'; href: string }
    | { kind: 'drawer'; drawerId: string; params?: Record<string, string> }
    | { kind: 'callback'; callbackId: string }
    | null
}

// ─── Recommendations (renamed from "suggestions" — see UX rule #7) ──────────

export type RecommendationSeverity = 'info' | 'nudge' | 'warning'

export interface Recommendation {
  id: string
  /** Short claim: "2 candidates waited over 5 days." One sentence. */
  claim: string
  /** Optional supporting detail rendered in a lighter weight below the claim. */
  detail?: string
  severity: RecommendationSeverity
  /** Action the user can take from the recommendation. May be null for pure observations. */
  action?: {
    label: string
    target: PrimaryAction['target']
  }
  /** Snooze in days if the user dismisses. Server enforces; UI can hint. */
  snoozeDays?: number
}

// ─── Related objects (cross-links) ──────────────────────────────────────────

export interface RelatedObjectRef {
  kind: HFObjectKind
  id: string
  label: string
  href: string
}

// ─── Info cards (the small stat grid on every overview) ─────────────────────

export interface InfoCard {
  label: string
  value: string | number
  /** Optional secondary text under the value. */
  sub?: string
  /** Optional click-through — filters the list panel or opens a drilldown. */
  href?: string
  /** Optional tone for value colouring (e.g. red for no-shows, green for hired). */
  tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'info' | 'brand'
}

// ─── Overview (what every object surface renders above the fold) ────────────

export interface OverviewUncertainty {
  /** "Interview stage of Cleaner intake pipeline." */
  whatIsThis: string
  /** "1 no-show yesterday · otherwise on track." */
  everythingOk: string
  /** "4 candidates waiting to be scheduled." */
  needsAttention: string
  /** Recommended next step in plain english — often matches the primary action verb. */
  nextBest: string
}

export interface HFOverview {
  title: string
  subtitle?: string
  health: Health
  uncertainty: OverviewUncertainty
  infoCards: InfoCard[]
}

// ─── The contract ───────────────────────────────────────────────────────────

export interface HFObject {
  id: string
  kind: HFObjectKind
  overview: HFOverview
  primaryAction: PrimaryAction
  recommendations: Recommendation[]
  related: RelatedObjectRef[]
  /** Anything power-user only. Rendered under `Advanced ▾`. Freeform sections. */
  advanced?: AdvancedSection[]
}

export interface AdvancedSection {
  id: string
  label: string
  /** Href for a full-page editor when the section is best edited outside a drawer. */
  href?: string
  /** Drawer id if editing fits a drawer. */
  drawerId?: string
}

// ─── Event bus (Timeline data model) ────────────────────────────────────────
//
// Phase 0 defines the shape only. Phase 1 wires existing lifecycle writes
// (SchedulingEvent, AutomationExecution, TrainingEnrollment progress, Session
// status transitions, meeting_no_show detection) to emit HFEvent rows to a
// shared log. Until then, Timeline callers can synthesise entries from their
// existing queries and pass them in via the `entries` prop.

export type HFEventActor = 'system' | 'recruiter' | 'candidate' | 'automation' | 'ai'

export type HFEventKind =
  // candidate lifecycle
  | 'candidate.applied'
  | 'candidate.stage_moved'
  | 'candidate.status_changed'
  | 'candidate.reactivated'
  | 'candidate.hired'
  | 'candidate.rejected'
  // flow
  | 'flow.started'
  | 'flow.step_completed'
  | 'flow.completed'
  | 'flow.passed'
  | 'flow.failed'
  // training
  | 'training.enrolled'
  | 'training.section_completed'
  | 'training.completed'
  | 'training.stalled'
  // meeting
  | 'meeting.scheduled'
  | 'meeting.rescheduled'
  | 'meeting.confirmed'
  | 'meeting.cancelled'
  | 'meeting.started'
  | 'meeting.ended'
  | 'meeting.no_show'
  | 'meeting.recording_ready'
  | 'meeting.transcript_ready'
  // automation
  | 'automation.sent'
  | 'automation.delivered'
  | 'automation.bounced'
  | 'automation.dropped'
  | 'automation.failed'
  | 'automation.cancelled'
  | 'automation.skipped'
  // background check
  | 'background_check.ordered'
  | 'background_check.passed'
  | 'background_check.failed'
  // note
  | 'note.added'
  // catch-all
  | 'other'

/**
 * Entity references on an event. Every event carries the ids of the objects
 * it belongs to so `<Timeline scope={...} />` can filter on any of them.
 * `null` fields are permitted — a candidate.applied event has no meetingId.
 */
export interface HFEventRefs {
  candidateId?: string | null
  positionId?: string | null
  pipelineId?: string | null
  stageId?: string | null
  flowId?: string | null
  trainingId?: string | null
  meetingId?: string | null
  automationRuleId?: string | null
  automationExecutionId?: string | null
  bookingPageId?: string | null
  workspaceId?: string | null
}

export interface HFEventDelivery {
  status: 'pending' | 'processed' | 'delivered' | 'deferred' | 'bounced' | 'dropped' | 'blocked' | 'failed'
  at?: string
  error?: string
}

export interface HFEvent {
  id: string
  kind: HFEventKind
  actor: HFEventActor
  /** ISO timestamp. */
  ts: string
  refs: HFEventRefs
  /** Human label for the timeline row — server-rendered so clients don't reinvent. */
  label: string
  /** Optional supporting detail; may contain " · " separators the UI keeps. */
  detail?: string
  /** Delivery telemetry for message events. */
  delivery?: HFEventDelivery
  /** Structured payload — freeform per event kind, for debugging / power-user tooltips. */
  payload?: Record<string, unknown>
}

// ─── Timeline scope + rendering ─────────────────────────────────────────────
//
// A scope is any subset of `HFEventRefs` plus an optional range. The reader
// (Phase 1) resolves it to `SELECT * FROM events WHERE <refs> AND ts BETWEEN ...`.
// Phase 0 components accept entries directly and treat scope as metadata.

export interface TimelineScope {
  candidateId?: string
  positionId?: string
  pipelineId?: string
  stageId?: string
  flowId?: string
  trainingId?: string
  meetingId?: string
  automationRuleId?: string
  bookingPageId?: string
  workspaceId?: string
  /** Range in days (default 30). */
  rangeDays?: number
}

export type TimelineEntryType = 'start' | 'success' | 'error' | 'info' | 'scheduled'

/**
 * Presentation-facing timeline entry. Distinct from `HFEvent` so the UI can
 * accept either raw events (Phase 1) or hand-composed entries (Phase 0, and
 * for synthetic rows like "waiting for candidate to book").
 */
export interface TimelineEntry {
  id: string
  label: string
  time: string
  type: TimelineEntryType
  detail?: string
  delivery?: HFEventDelivery
  /** Deep link — usually to the candidate or object referenced. */
  href?: string
  /** Icon glyph override; primitives pick a sensible default per `type`. */
  icon?: ReactNode
}
