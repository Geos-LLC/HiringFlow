/**
 * Candidate status + disposition model.
 *
 * `status` is an orthogonal axis to `pipelineStatus` (which holds the funnel
 * stage id). A candidate can be `stage='video_interview_sent', status='stalled'`
 * — the stage represents the last real progress point, and the status tells the
 * board / analytics whether the candidate is still moving, stuck, or out.
 *
 * `dispositionReason` is a structured enum that explains *why* a candidate is
 * stalled / lost. It's distinct from the existing free-form
 * `Session.rejectionReason` (which stays as a recruiter-editable note) — the
 * enum is what analytics groups by.
 */

export type CandidateStatus =
  | 'active'
  | 'waiting'
  | 'stalled'
  | 'nurture'
  | 'lost'
  | 'hired'

export const CANDIDATE_STATUSES: readonly CandidateStatus[] = [
  'active',
  'waiting',
  'stalled',
  'nurture',
  'lost',
  'hired',
] as const

export type CandidateDispositionReason =
  | 'no_response_after_video_invite'
  | 'flow_not_completed'
  | 'video_interview_not_completed'
  | 'training_not_started'
  | 'training_not_completed'
  | 'scheduling_not_booked'
  | 'interview_no_show'
  | 'background_check_not_completed'
  | 'no_progress_generic'
  | 'candidate_declined'
  | 'failed_screening'
  | 'failed_training'
  | 'not_qualified'
  | 'not_selected'
  | 'hired_elsewhere'
  | 'reapplied'
  | 'manual_other'

export const CANDIDATE_DISPOSITION_REASONS: readonly CandidateDispositionReason[] = [
  'no_response_after_video_invite',
  'flow_not_completed',
  'video_interview_not_completed',
  'training_not_started',
  'training_not_completed',
  'scheduling_not_booked',
  'interview_no_show',
  'background_check_not_completed',
  'no_progress_generic',
  'candidate_declined',
  'failed_screening',
  'failed_training',
  'not_qualified',
  'not_selected',
  'hired_elsewhere',
  // Auto-applied to a candidate's older session when they submit a fresh
  // application through /a/:slug or /f/:slug — so the kanban stops
  // showing the same person on two stages.
  'reapplied',
  'manual_other',
] as const

export function isCandidateStatus(v: unknown): v is CandidateStatus {
  return typeof v === 'string' && (CANDIDATE_STATUSES as readonly string[]).includes(v)
}

/**
 * Workspace-configurable custom statuses. Stored as JSON on
 * `Workspace.settings.customStatuses`. Custom statuses are MANUAL ONLY —
 * the cron never auto-assigns them, and they don't carry the lifecycle
 * stamps (`stalledAt`/`lostAt`/`hiredAt`). They appear as additional tabs
 * on the kanban and as additional "Move to …" buttons on the candidate
 * detail page.
 *
 * `id` is the value written to `Session.status`. Should be slug-shaped
 * and prefixed with `cust_` so it never collides with the built-in enum
 * values. `tone` reuses the BadgeTone vocabulary so the badge colors are
 * consistent with the built-in statuses.
 */
export interface CustomStatus {
  id: string
  label: string
  tone: CandidateStatusTone
}

export function isCustomStatusId(id: string): boolean {
  return id.startsWith('cust_')
}

export function normalizeCustomStatuses(raw: unknown): CustomStatus[] {
  if (!Array.isArray(raw)) return []
  const out: CustomStatus[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : null
    const label = typeof r.label === 'string' ? r.label.trim() : null
    const tone = typeof r.tone === 'string' ? r.tone : 'neutral'
    if (!id || !label || !isCustomStatusId(id) || seen.has(id)) continue
    if (!['neutral', 'brand', 'success', 'warn', 'info', 'danger'].includes(tone)) continue
    seen.add(id)
    out.push({ id, label, tone: tone as CandidateStatusTone })
  }
  return out
}

export function makeCustomStatusId(label: string, existing: CustomStatus[]): string {
  const base = 'cust_' + (label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'status')
  const taken = new Set(existing.map((s) => s.id))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

/**
 * Runtime check that accepts a built-in status OR any of the workspace's
 * custom status ids. Use this from API routes that validate user input.
 */
export function isAllowedStatus(v: unknown, customStatuses: CustomStatus[] = []): v is string {
  if (typeof v !== 'string') return false
  if ((CANDIDATE_STATUSES as readonly string[]).includes(v)) return true
  return customStatuses.some((s) => s.id === v)
}

export function isDispositionReason(v: unknown): v is CandidateDispositionReason {
  return typeof v === 'string' && (CANDIDATE_DISPOSITION_REASONS as readonly string[]).includes(v)
}

// Display metadata for the status enum. `tone` matches the Badge component's
// BadgeTone vocabulary so the kanban / detail page can pass it through.
export type CandidateStatusTone = 'neutral' | 'brand' | 'success' | 'warn' | 'info' | 'danger'
export const STATUS_DISPLAY: Record<CandidateStatus, { label: string; tone: CandidateStatusTone }> = {
  active:  { label: 'Active',   tone: 'brand'   },
  waiting: { label: 'Waiting',  tone: 'info'    },
  stalled: { label: 'Stalled',  tone: 'warn'    },
  nurture: { label: 'On Hold', tone: 'neutral' },
  lost:    { label: 'Lost',     tone: 'danger'  },
  hired:   { label: 'Hired',    tone: 'success' },
}

// Human-readable labels for the disposition enum. Used on candidate cards
// and the detail page's Reason field.
export const DISPOSITION_DISPLAY: Record<CandidateDispositionReason, string> = {
  no_response_after_video_invite: 'No response after video invite',
  flow_not_completed:             'Flow not completed',
  video_interview_not_completed:  'Video interview not completed',
  training_not_started:           'Training not started',
  training_not_completed:         'Training not completed',
  scheduling_not_booked:          'Scheduling invite not booked',
  interview_no_show:              'Interview no-show',
  background_check_not_completed: 'Background check not completed',
  no_progress_generic:            'No forward progress',
  candidate_declined:             'Candidate declined',
  failed_screening:               'Failed screening',
  failed_training:                'Failed training',
  not_qualified:                  'Not qualified',
  not_selected:                   'Not selected',
  hired_elsewhere:                'Hired elsewhere',
  reapplied:                      'Superseded by re-apply',
  manual_other:                   'Other',
}

/**
 * Platform fallback for the unified stale-detection rule. Used when
 * `Workspace.defaultStalledDays` is null. The cron flips an active candidate
 * to `stalled` after this many days without a real forward-progress event
 * (Session.lastProgressAt).
 */
export const STALE_DETECTION_DEFAULT_DAYS = 7

/**
 * Legacy per-checkpoint timeouts on `Flow`. NOT used by the unified
 * stale-detection cron — kept temporarily so existing rows don't lose their
 * values during the transition. New code should reference
 * `STALE_DETECTION_DEFAULT_DAYS` / `Workspace.defaultStalledDays` instead.
 *
 * @deprecated Will be removed once per-pipeline / per-stage overrides land.
 */
export const DEFAULT_TIMEOUTS = {
  videoInterviewTimeoutDays: 3,
  trainingTimeoutDays: 5,
  noShowTimeoutHours: 24,
  schedulingTimeoutHours: 48,
  backgroundCheckTimeoutDays: 7,
} as const

/**
 * Snapshot of a candidate's session state — just enough fields for
 * `deriveStaleReason` to figure out which checkpoint they got stuck at. Kept
 * narrow so callers (cron, dry-run script, tests) can construct it from the
 * minimum Prisma `select` payload instead of dragging the full Session.
 */
export interface StaleReasonContext {
  finishedAt: Date | null
  // Most recent attempted scheduling — null means the candidate never received
  // a scheduling invite. Set to a non-null Date when a SchedulingEvent of type
  // 'scheduling_invite_sent' exists for this session.
  schedulingInviteSentAt: Date | null
  // Most recent InterviewMeeting.scheduledStart for this session, regardless of
  // status. Null when no meeting was ever scheduled.
  latestMeetingScheduledStart: Date | null
  // Whether ANY interview meeting on this session has actualStart set. If true
  // the candidate did attend at some point — don't blame them for no-show.
  hasAttendedAnyMeeting: boolean
  // True when at least one TrainingAccessToken exists for this session — i.e.
  // the candidate was invited to training. Drives the training_not_*
  // reasons.
  hasTrainingInvite: boolean
  // True when at least one TrainingEnrollment progressed past 'not_started'.
  hasTrainingProgress: boolean
  // True when at least one TrainingEnrollment is completed.
  hasTrainingCompleted: boolean
  // True when a BackgroundCheck row exists for this session and is not in a
  // completed/passed terminal state.
  hasPendingBackgroundCheck: boolean
}

/**
 * Pick the most specific disposition reason for a stale candidate based on the
 * checkpoint they failed to clear. Ordering follows the funnel: earliest stuck
 * point wins so a candidate who never completed the flow doesn't get tagged
 * `scheduling_not_booked` just because they also never booked.
 *
 * Fall-through is `no_progress_generic` — the candidate finished the flow,
 * has no training assigned, no scheduling invite, no meeting, no background
 * check, and still went quiet for >N days. Rare but possible (e.g. a recruiter
 * is sitting on them without a next-step automation).
 */
export function deriveStaleReason(ctx: StaleReasonContext): CandidateDispositionReason {
  if (!ctx.finishedAt) return 'flow_not_completed'

  if (ctx.hasTrainingInvite && !ctx.hasTrainingCompleted) {
    return ctx.hasTrainingProgress ? 'training_not_completed' : 'training_not_started'
  }

  if (ctx.latestMeetingScheduledStart && !ctx.hasAttendedAnyMeeting) {
    // Meeting was booked but candidate didn't attend any of them.
    return 'interview_no_show'
  }

  if (ctx.schedulingInviteSentAt && !ctx.latestMeetingScheduledStart) {
    // Scheduling email went out but no meeting ever materialised.
    return 'scheduling_not_booked'
  }

  if (ctx.hasPendingBackgroundCheck) return 'background_check_not_completed'

  return 'no_progress_generic'
}

/**
 * Derive what the new `status`-axis fields should be when a manual lifecycle
 * action (mark stalled / lost / nurture / hired / reactivate) runs. Reactivate
 * is expressed as `status='active'` — this helper clears the matching
 * `*At` stamps and the disposition reason so the candidate is genuinely back
 * in the active pool.
 *
 * Returns the partial Prisma update payload. Fields not relevant to the
 * transition are intentionally absent so the caller can spread it over an
 * existing patch without overwriting unrelated columns.
 */
export function statusTransitionPatch(
  next: CandidateStatus,
  opts: { dispositionReason?: CandidateDispositionReason | null; now?: Date } = {},
): {
  status: CandidateStatus
  dispositionReason?: CandidateDispositionReason | null
  stalledAt?: Date | null
  lostAt?: Date | null
  hiredAt?: Date | null
  automationsHaltedAt?: Date | null
  automationsHaltedReason?: string | null
  lastProgressAt?: Date
} {
  const now = opts.now ?? new Date()
  const patch: ReturnType<typeof statusTransitionPatch> = { status: next }

  if (opts.dispositionReason !== undefined) {
    patch.dispositionReason = opts.dispositionReason
  }

  switch (next) {
    case 'stalled':
      patch.stalledAt = now
      patch.lostAt = null
      patch.hiredAt = null
      // Halt downstream automations — pending QStash callbacks for this
      // candidate hit the guard's halt check and skip. Central kill-switch.
      patch.automationsHaltedAt = now
      patch.automationsHaltedReason = `lifecycle:stalled:${opts.dispositionReason ?? 'manual'}`
      break
    case 'lost':
      patch.lostAt = now
      patch.hiredAt = null
      // Keep stalledAt — historically useful to know how long it sat stalled
      // before being declared lost. Cleared on reactivate.
      patch.automationsHaltedAt = now
      patch.automationsHaltedReason = `lifecycle:lost:${opts.dispositionReason ?? 'manual'}`
      break
    case 'hired':
      patch.hiredAt = now
      patch.stalledAt = null
      patch.lostAt = null
      // Hired implies success — clear any stale disposition reason unless the
      // caller passed one explicitly (e.g. 'hired_elsewhere' would be lost,
      // not hired, but defensive null-out for the happy path).
      if (opts.dispositionReason === undefined) patch.dispositionReason = null
      // Halt forward-moving automations for hired candidates. Rules that
      // intentionally fire on hired (e.g. an offer-acceptance follow-up)
      // must opt in via AutomationRule.allowedForStatuses.
      patch.automationsHaltedAt = now
      patch.automationsHaltedReason = 'lifecycle:hired'
      break
    case 'active':
    case 'waiting':
    case 'nurture':
      // Reactivate-style transition — clear all the terminal stamps, the
      // disposition reason (unless the caller explicitly passed one, e.g. a
      // recruiter moving to nurture with `hired_elsewhere`), AND the
      // automation kill-switch. Reactivated candidates are eligible for
      // automations again.
      patch.stalledAt = null
      patch.lostAt = null
      patch.hiredAt = null
      patch.automationsHaltedAt = null
      patch.automationsHaltedReason = null
      if (opts.dispositionReason === undefined) patch.dispositionReason = null
      // Reset the stale-detection clock so the cron doesn't instantly
      // re-stall a candidate the recruiter just reactivated. Without this,
      // a candidate who was stalled for 10 days would flip back to stalled
      // on the next 04:00 UTC run.
      patch.lastProgressAt = now
      break
  }

  return patch
}
