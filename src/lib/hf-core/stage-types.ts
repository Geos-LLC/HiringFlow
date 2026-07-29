/**
 * Stage Type + Panel Plugin registry.
 *
 * A Stage is rendered by a single `<StageShell />` renderer that consumes an
 * ordered list of `StagePanel` ids. The panels themselves are implemented
 * under `src/components/hf/stage-panels/` and looked up through
 * `PANEL_REGISTRY` at render time.
 *
 * Adding a new stage type = declare it here. Adding a new panel = drop a
 * component under `stage-panels/` and register its id here. There is
 * intentionally no per-stage-type renderer; if you feel tempted to write one,
 * the plugin architecture is wrong for your case — extend the panel set
 * instead.
 */

// ─── Panel ids ──────────────────────────────────────────────────────────────

export type StagePanel =
  // universal
  | 'candidates'
  | 'timeline'
  | 'recommendations'
  | 'notes'
  | 'metrics'
  // application
  | 'flow'
  | 'application_form'
  | 'qualification_questions'
  // training
  | 'training_program'
  | 'training_progress'
  | 'quiz'
  // interview
  | 'todays_interviews'
  | 'booking'
  | 'reminders'
  | 'interview_guide'
  // trial job
  | 'job_assignment'
  | 'before_after_photos'
  | 'qa_review'
  // offer
  | 'documents'
  | 'acceptance'
  // automation surfaces reachable from a stage
  | 'automations'
  // custom / extensibility
  | 'custom'

// ─── Stage Type catalog ─────────────────────────────────────────────────────

export interface StageTypeDef {
  /** Slug used in Pipeline.stages[].typeId. */
  id: StageTypeId
  /** Display label used in stage-type pickers. */
  label: string
  /** One-liner explaining when to use this stage type. */
  description: string
  /** Ordered panel list rendered inside the expanded stage. */
  panels: StagePanel[]
  /**
   * The default primary-action verb template for stages of this type. The
   * runtime `getPrimaryAction()` may override based on current state (e.g.
   * "Re-book no-shows" when there are no-shows to re-book).
   */
  defaultPrimaryVerb: string
}

export type StageTypeId =
  | 'application'
  | 'training'
  | 'interview'
  | 'trial_job'
  | 'offer'
  | 'terminal'
  | 'custom'

export const STAGE_TYPES: Record<StageTypeId, StageTypeDef> = {
  application: {
    id: 'application',
    label: 'Application',
    description: 'Candidate submits their application through a flow.',
    panels: [
      'candidates',
      'flow',
      'application_form',
      'qualification_questions',
      'recommendations',
      'timeline',
    ],
    defaultPrimaryVerb: 'Review applicants',
  },
  training: {
    id: 'training',
    label: 'Training',
    description: 'Candidate completes onboarding, orientation, or skill training.',
    panels: [
      'candidates',
      'training_program',
      'training_progress',
      'quiz',
      'reminders',
      'recommendations',
      'timeline',
    ],
    defaultPrimaryVerb: 'Nudge stalled trainees',
  },
  interview: {
    id: 'interview',
    label: 'Interview',
    description: 'Candidate books and attends an interview with the hiring team.',
    panels: [
      'candidates',
      'todays_interviews',
      'booking',
      'reminders',
      'interview_guide',
      'recommendations',
      'timeline',
    ],
    defaultPrimaryVerb: 'Help waiting candidates',
  },
  trial_job: {
    id: 'trial_job',
    label: 'Trial job',
    description: 'Candidate performs a paid trial task before final hire.',
    panels: [
      'candidates',
      'job_assignment',
      'before_after_photos',
      'qa_review',
      'recommendations',
      'timeline',
    ],
    defaultPrimaryVerb: 'Review trial results',
  },
  offer: {
    id: 'offer',
    label: 'Offer',
    description: 'Candidate reviews and signs the offer / paperwork.',
    panels: [
      'candidates',
      'documents',
      'acceptance',
      'reminders',
      'recommendations',
      'timeline',
    ],
    defaultPrimaryVerb: 'Follow up on offers',
  },
  terminal: {
    id: 'terminal',
    label: 'Hired / Rejected',
    description: 'Terminal state — candidate has left the pipeline.',
    panels: ['candidates', 'recommendations', 'timeline'],
    defaultPrimaryVerb: 'Configure stage',
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    description: 'Bespoke stage. Choose the panels manually.',
    panels: ['candidates', 'recommendations', 'timeline'],
    defaultPrimaryVerb: 'Configure stage',
  },
}

export function getStageType(id: string | null | undefined): StageTypeDef {
  if (id && id in STAGE_TYPES) return STAGE_TYPES[id as StageTypeId]
  return STAGE_TYPES.custom
}
