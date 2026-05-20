'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import Link from 'next/link'
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-templates-seed'
import { DEFAULT_SMS_TEMPLATES } from '@/lib/sms-templates-seed'
import { Button, PageHeader } from '@/components/design'
import {
  DEFAULT_FUNNEL_STAGES,
  type FunnelStage,
  normalizeStages,
} from '@/lib/funnel-stages'
import { detectAutomationWarnings, deriveFeaturesFromStageTriggers } from '@/lib/automation-warnings'
import RichTextEditor, { type RichTextEditorHandle } from '@/components/RichTextEditor'

interface Flow { id: string; name: string }
interface Template { id: string; name: string; subject: string; bodyHtml?: string; bodyText?: string | null }
interface SmsTemplateItem { id: string; name: string; body: string }
interface TrainingItem { id: string; title: string; slug: string }
interface SchedulingItem { id: string; name: string; schedulingUrl: string }

interface StepShape {
  id?: string
  order: number
  delayMinutes: number
  timingMode: 'trigger' | 'before_meeting' | 'after_meeting'
  channel: 'email' | 'sms' | 'both'
  emailTemplateId: string | null
  smsTemplateId: string | null
  smsBody: string | null
  emailDestination: 'applicant' | 'company' | 'specific'
  emailDestinationAddress: string | null
  smsDestination: 'applicant' | 'company' | 'specific'
  smsDestinationNumber: string | null
  nextStepType: string | null
  nextStepUrl: string | null
  trainingId: string | null
  schedulingConfigId: string | null
  // For UI display only — populated by the API on GET.
  emailTemplate?: Template | null
  smsTemplate?: SmsTemplateItem | null
  training?: TrainingItem | null
  schedulingConfig?: SchedulingItem | null
}

interface PipelineLite { id: string; name: string; isDefault: boolean; stages?: FunnelStage[] }
interface Rule {
  id: string; name: string; triggerType: string; flowId: string | null
  // Pipeline scope (added 2026-05-13). Null = "any pipeline" — rule fires
  // for candidates regardless of their flow's pipeline assignment.
  pipelineId?: string | null
  pipeline?: PipelineLite | null
  // Explicit funnel-stage assignment for the journey UI. Overrides the
  // implicit triggerType→stage mapping when set; null = fall back to
  // implicit (or "Unassigned" if nothing claims the trigger).
  stageId: string | null
  // Legacy mirror fields — still populated, but not authoritative.
  channel?: 'email' | 'sms'
  smsBody?: string | null
  delayMinutes?: number
  minutesBefore?: number | null
  waitForRecording?: boolean
  emailDestination?: 'applicant' | 'company' | 'specific'
  emailDestinationAddress?: string | null
  emailTemplateId?: string | null
  nextStepType?: string | null
  nextStepUrl?: string | null
  trainingId?: string | null
  schedulingConfigId?: string | null
  isActive: boolean; createdAt: string
  flow: Flow | null; emailTemplate: Template | null; training: TrainingItem | null
  schedulingConfig: SchedulingItem | null; _count: { executions: number }
  steps: StepShape[]
}

interface ExecutionRow {
  id: string
  status: string
  channel: string
  sentAt: string | null
  scheduledFor: string | null
  createdAt: string
  errorMessage: string | null
  sessionId: string | null
  session: { id: string; candidateName: string | null; candidateEmail: string | null; candidatePhone: string | null } | null
  step: { id: string; order: number } | null
}

type DestinationFilter = 'all' | 'applicant' | 'company'

const TRIGGERS = [
  { value: 'flow_completed', label: 'Flow Completed' },
  { value: 'flow_passed', label: 'Flow Passed' },
  { value: 'training_started', label: 'Training Started' },
  { value: 'training_completed', label: 'Training Done' },
  { value: 'meeting_scheduled', label: 'Meeting Scheduled' },
  { value: 'meeting_rescheduled', label: 'Meeting Rescheduled' },
  { value: 'before_meeting', label: 'Before Meeting' },
  { value: 'meeting_started', label: 'Meeting Started' },
  { value: 'meeting_ended', label: 'Meeting Ended' },
  { value: 'meeting_no_show', label: 'No-show' },
  { value: 'recording_ready', label: 'Recording Ready' },
  { value: 'transcript_ready', label: 'Transcript Ready' },
  { value: 'background_check_passed', label: 'Background Check Passed' },
  { value: 'background_check_failed', label: 'Background Check Failed' },
  { value: 'background_check_needs_review', label: 'Background Check — Needs Review' },
  { value: 'automation_completed', label: 'After Automation' },
  // Stage-entered — fires after a movement rule lands the candidate in a
  // specific stage. Requires both pipelineId and stageId; the server
  // rejects creates/updates without them.
  { value: 'stage_entered', label: 'Stage Entered' },
]

const SESSION_WIDE_TRIGGERS = new Set([
  'training_started',
  'training_completed',
  'automation_completed',
  'stage_entered',
  'meeting_scheduled',
  'meeting_rescheduled',
  'before_meeting',
  'meeting_started',
  'meeting_ended',
  'meeting_no_show',
  'recording_ready',
  'transcript_ready',
  'background_check_passed',
  'background_check_failed',
  'background_check_needs_review',
])

const TRIGGER_LABELS: Record<string, string> = {
  flow_completed: 'Flow Completed',
  flow_passed: 'Flow Passed',
  training_started: 'Training Started',
  training_completed: 'Training Done',
  meeting_scheduled: 'Meeting Scheduled',
  meeting_rescheduled: 'Meeting Rescheduled',
  before_meeting: 'Before Meeting',
  meeting_started: 'Meeting Started',
  meeting_ended: 'Meeting Ended',
  meeting_no_show: 'No-show',
  recording_ready: 'Recording Ready',
  transcript_ready: 'Transcript Ready',
  background_check_passed: 'Background Check Passed',
  background_check_failed: 'Background Check Failed',
  background_check_needs_review: 'Background Check — Needs Review',
  automation_completed: 'After Automation',
  stage_entered: 'Stage Entered',
}

const DELAY_PRESETS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Immediately' },
  { value: 15, label: '15 min' },
  { value: 60, label: '1 hour' },
  { value: 360, label: '6 hours' },
  { value: 1440, label: '1 day' },
  { value: 4320, label: '3 days' },
  { value: 10080, label: '7 days' },
]

// Trigger-aware SMS bodies. The textarea's placeholder is just the
// HTML placeholder attribute — it LOOKS like content but doesn't count.
// We prefill the actual smsBody field with these when the recruiter
// switches a step to SMS so the rule is ready to save without typing.
const TRIGGER_TO_SMS_BODY: Record<string, string> = {
  flow_completed:     'Hi {{candidate_name}}, thanks for applying to {{flow_name}}. We received your application — we\'ll be in touch.',
  flow_passed:        'Hi {{candidate_name}}, you passed the screening for {{flow_name}}! Next step: {{training_link}}',
  training_started:   'Hi {{candidate_name}}, you\'ve started the training. Reply if you have any questions along the way.',
  training_completed: 'Hi {{candidate_name}}, training done! Book your interview: {{schedule_link}}',
  meeting_scheduled:  'Hi {{candidate_name}}, your interview is confirmed for {{meeting_time}}. Join: {{meeting_link}}',
  meeting_rescheduled: 'Hi {{candidate_name}}, your interview was moved to {{meeting_time}}. New link: {{meeting_link}}',
  before_meeting:     'Hi {{candidate_name}}, reminder: your interview starts at {{meeting_time}}. Join: {{meeting_link}}',
  meeting_started:    'Hi {{candidate_name}}, we just started the interview — join here: {{meeting_link}}',
  meeting_ended:      'Hi {{candidate_name}}, thanks for the interview. We\'ll follow up with next steps soon.',
  meeting_no_show:    'Hi {{candidate_name}}, we missed you for the interview. Pick a new time: {{schedule_link}}',
  recording_ready:    'Hi {{candidate_name}}, the recording from your interview is ready: {{recording_link}}',
  transcript_ready:   'Hi {{candidate_name}}, the transcript from your interview is ready: {{transcript_link}}',
  background_check_passed: 'Hi {{candidate_name}}, your background check came back clear. We\'ll be in touch with next steps.',
  background_check_failed: 'Hi {{candidate_name}}, thanks for your interest. We won\'t be moving forward with your application at this time.',
  background_check_needs_review: 'Hi {{candidate_name}}, your background check needs a quick review on our side. We\'ll be in touch shortly.',
  automation_completed: 'Hi {{candidate_name}}, just checking in regarding your application for {{flow_name}}.',
}
const DEFAULT_SMS_BODY = 'Hi {{candidate_name}}, this is a quick note about your application for {{flow_name}}.'

function pickDefaultSmsBody(triggerType: string): string {
  return TRIGGER_TO_SMS_BODY[triggerType] || DEFAULT_SMS_BODY
}

/**
 * Look at the rendered text of a template (subject + body) or an SMS body
 * and infer which "Includes link to" option matches the merge tokens used.
 * Priority: training > scheduling > meet_link. Returns null if none matched.
 */
type LinkType = 'training' | 'scheduling' | 'meet_link' | 'background_check'
function detectLinkType(content: string | null | undefined): LinkType | null {
  if (!content) return null
  if (content.includes('{{training_link}}')) return 'training'
  if (content.includes('{{schedule_link}}')) return 'scheduling'
  if (content.includes('{{meeting_link}}')) return 'meet_link'
  if (content.includes('{{certn_link}}')) return 'background_check'
  return null
}

function detectStepLinkType(step: StepShape, templates: Template[]): LinkType | null {
  // Combine subject + body of the picked email template (if any) with the SMS body.
  const tpl = step.emailTemplateId ? templates.find((t) => t.id === step.emailTemplateId) : null
  const haystack = [tpl?.subject || '', tpl?.bodyHtml || '', tpl?.bodyText || '', step.smsBody || ''].join(' ')
  return detectLinkType(haystack)
}

// Map trigger types to the most-relevant default template name. Used to
// prefill a sensible starter template when a recruiter opens "+ New rule"
// — they shouldn't have to pick from a dropdown to see what will be sent.
const TRIGGER_TO_TEMPLATE_NAME: Record<string, string> = {
  flow_completed:     'Form Submit Confirmation',
  flow_passed:        'Training Invitation',
  training_started:   'Generic Follow-up',
  training_completed: 'Scheduling Invitation',
  meeting_scheduled:  'Interview Confirmation',
  before_meeting:     'Interview Reminder',
  meeting_started:    'Generic Follow-up',
  meeting_ended:      'Interview Follow-up (Post-meeting)',
  meeting_no_show:    'Rejection Email',
  recording_ready:    'Generic Follow-up',
  transcript_ready:   'Generic Follow-up',
  automation_completed: 'Generic Follow-up',
}

function pickDefaultTemplateId(triggerType: string, templates: Template[]): string | undefined {
  if (templates.length === 0) return undefined
  const preferredName = TRIGGER_TO_TEMPLATE_NAME[triggerType]
  if (preferredName) {
    const match = templates.find((t) => t.name === preferredName)
    if (match) return match.id
  }
  return templates[0].id
}

function newStep(order: number, defaultTemplateId?: string): StepShape {
  return {
    order,
    delayMinutes: 0,
    timingMode: 'trigger',
    channel: 'email',
    emailTemplateId: defaultTemplateId ?? null,
    smsTemplateId: null,
    smsBody: null,
    emailDestination: 'applicant',
    emailDestinationAddress: null,
    smsDestination: 'applicant',
    smsDestinationNumber: null,
    nextStepType: null,
    nextStepUrl: null,
    trainingId: null,
    schedulingConfigId: null,
  }
}

// Triggers tied to an actual InterviewMeeting — these are the only triggers
// where step.timingMode='before_meeting' / 'after_meeting' makes sense.
const MEETING_TRIGGERS = new Set(['meeting_scheduled', 'before_meeting', 'meeting_started', 'meeting_ended', 'recording_ready'])

function formatDelay(m: number): string {
  if (m <= 0) return 'Instant'
  if (m >= 1440) return `${Math.round(m / 1440)}d`
  if (m >= 60) return `${Math.round(m / 60)}h`
  return `${m}m`
}

export default function AutomationsPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [flows, setFlows] = useState<Flow[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [smsTemplates, setSmsTemplates] = useState<SmsTemplateItem[]>([])
  const [trainings, setTrainings] = useState<TrainingItem[]>([])
  const [schedulingConfigs, setSchedulingConfigs] = useState<SchedulingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [destinationFilter, setDestinationFilter] = useState<DestinationFilter>('all')
  // Pipeline filter — null = no filter; a stage id picks rules that fire for
  // any of that stage's trigger events; the literal string '__unassigned'
  // picks rules whose triggerType isn't claimed by any stage. The pipeline
  // UI is stage-driven now (mirrors the kanban) — triggerType is a separate
  // implementation concept that lives on stages.
  const [stageFilter, setStageFilter] = useState<string | null>(null)
  const [activeOnly, setActiveOnly] = useState(false)
  const [stages, setStages] = useState<FunnelStage[]>(DEFAULT_FUNNEL_STAGES)
  // Pipeline picker. Empty = show rules from all pipelines. Specific id =
  // show only rules pinned to that pipeline. 'workspace' = workspace-wide
  // rules (pipelineId IS NULL). Stays in URL so a recruiter can bookmark
  // "Cleaner automations".
  const [pipelines, setPipelines] = useState<PipelineLite[]>([])
  const [pipelineFilter, setPipelineFilter] = useState<string>('')
  // Pipeline scope for the rule being edited. '' = "any pipeline" (back-compat).
  const [pipelineIdField, setPipelineIdField] = useState<string>('')
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Rule | null>(null)
  const [name, setName] = useState('')
  const [triggerType, setTriggerType] = useState('flow_completed')
  const [flowId, setFlowId] = useState('')
  // Rule-level training filter for training_started / training_completed
  // triggers — which training fires this rule. '' means any training.
  // Independent from per-step trainingId (action target).
  const [triggerTrainingId, setTriggerTrainingId] = useState('')
  // Explicit stage assignment — '' means "auto" (fall back to triggerType→stage mapping).
  const [stageIdField, setStageIdField] = useState('')
  const [minutesBefore, setMinutesBefore] = useState(60)
  const [waitForRecording, setWaitForRecording] = useState(false)
  const [steps, setSteps] = useState<StepShape[]>([newStep(0)])
  // Sort direction for the rules table when "by journey order" is active.
  // 'asc' walks earliest→latest stage; 'desc' is reverse. null = default
  // ordering (createdAt desc as returned by the API).
  const [journeySort, setJourneySort] = useState<'asc' | 'desc' | null>(null)
  // When non-null, the executions modal is open for this rule. Loading state
  // is part of the same object so the modal can show "Loading…" inline.
  const [executionsModal, setExecutionsModal] = useState<null | {
    rule: Rule
    loading: boolean
    items: ExecutionRow[]
    error?: string
  }>(null)
  // Index of the step the inline template creator is currently bound to,
  // plus which channel's editor is open (email = full subject+body editor,
  // sms = simpler name+body editor). At most one editor open at a time.
  const [templateEditorStepIdx, setTemplateEditorStepIdx] = useState<number | null>(null)
  const [templateEditorChannel, setTemplateEditorChannel] = useState<'email' | 'sms'>('email')
  // When the editor opens (idx becomes non-null), pull it into view AND
  // clear any stale save error from a previous attempt. When it closes (idx
  // becomes null), also clear the edit-in-place flags so a subsequent open
  // doesn't accidentally inherit them from the prior session.
  useEffect(() => {
    if (templateEditorStepIdx !== null) {
      setTplSaveError(null)
      requestAnimationFrame(() => {
        tplEditorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    } else {
      setTemplateEditorEditingId(null)
      setSmsTemplateEditorEditingId(null)
    }
  }, [templateEditorStepIdx])
  const [companyEmail, setCompanyEmail] = useState<string | null>(null)
  const [companyPhone, setCompanyPhone] = useState<string | null>(null)
  const [showCompanyEmailWarning, setShowCompanyEmailWarning] = useState(false)
  const [showCompanyPhoneWarning, setShowCompanyPhoneWarning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Extension/meeting-flow interference warnings — soft, surfaced on save
  // and overridable via "Save anyway" once the user has read them.
  const [saveWarnings, setSaveWarnings] = useState<string[]>([])
  const [warningsAcked, setWarningsAcked] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  // In-app test-send modal. Replaces the native window.prompt() so the recruiter
  // gets a real UI (validation, error display, paste-friendly) instead of a
  // chrome-style dialog. The recipient is persisted to localStorage per channel
  // so they don't retype every time.
  const [testModal, setTestModal] = useState<{ rule: Rule; isSms: boolean } | null>(null)
  const [testRecipient, setTestRecipient] = useState('')
  const [testResult, setTestResult] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null)
  // Inline template creator — email shares name with SMS (one state) so the
  // recruiter can keep typing if they switch channels mid-edit. The
  // channel-specific fields (subject/html for email, body for SMS) live in
  // separate state so neither clobbers the other.
  const [newTplName, setNewTplName] = useState('')
  const [newTplSubject, setNewTplSubject] = useState('')
  const [newTplBody, setNewTplBody] = useState('<p>Hi {{candidate_name}},</p>\n<p></p>')
  const [newSmsTplBody, setNewSmsTplBody] = useState('Hi {{candidate_name}}, ')
  // Tracks which existing template the inline editor was seeded from, so the
  // "Start from existing template" picker stays in sync as the user switches
  // sources. Null = blank-slate (no template selected on the originating step).
  const [templateEditorSourceId, setTemplateEditorSourceId] = useState<string | null>(null)
  const [savingTpl, setSavingTpl] = useState(false)
  // When set, the inline editor PATCHes this template id (update-in-place)
  // instead of POSTing a new one. Used by the "Edit" link on the template
  // preview — recruiter clicks it expecting to edit the existing template,
  // not auto-duplicate. Null = the "+ New template" flow (POST).
  const [templateEditorEditingId, setTemplateEditorEditingId] = useState<string | null>(null)
  const [smsTemplateEditorEditingId, setSmsTemplateEditorEditingId] = useState<string | null>(null)
  // Imperative handle into the rich-text editor so createTemplate can read
  // the live DOM HTML instead of the React state mirror. The contenteditable's
  // onBlur (fired when the Save button is clicked) enqueues a state update
  // that doesn't commit before the click's createTemplate runs — so the
  // closure's newTplBody can be one tick stale. Reading the DOM bypasses it.
  const richEditorRef = useRef<RichTextEditorHandle>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/automations').then(r => r.json()),
      fetch('/api/flows').then(r => r.json()),
      fetch('/api/email-templates').then(r => r.json()),
      fetch('/api/sms-templates').then(r => r.ok ? r.json() : []),
      fetch('/api/trainings').then(r => r.json()),
      fetch('/api/scheduling').then(r => r.json()),
      fetch('/api/workspace/settings').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/pipelines').then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([r, f, t, st, tr, sc, ws, ps]) => {
      setRules(r); setFlows(f); setTemplates(t); setSmsTemplates(st); setTrainings(tr); setSchedulingConfigs(sc)
      setCompanyEmail(ws?.senderEmail || null)
      // Workspace-default stage list. Used for the rules table / kanban nav
      // and as the fallback for the rule editor when the rule is scoped to
      // "Any pipeline". When the user picks a specific pipeline in the rule
      // editor, the stage dropdown swaps to that pipeline's stages via the
      // editorStages memo below.
      const defaultPipeline = (ps as PipelineLite[]).find((p) => p.isDefault)
      const pipelineStages = (ps as Array<{ id: string; stages?: FunnelStage[] }>).find((p) => p.id === defaultPipeline?.id)?.stages
      setStages(Array.isArray(pipelineStages) && pipelineStages.length > 0 ? pipelineStages : DEFAULT_FUNNEL_STAGES)
      setPipelines(ps as PipelineLite[])
      // Restore the last-picked pipeline filter. We share localStorage key
      // with the kanban (`hiringflow:pipeline`) so flipping to Dispatcher
      // on /candidates carries over here. 'workspace' is the synthetic
      // any-pipeline selection — only meaningful here, not on the kanban.
      try {
        const saved = localStorage.getItem('hiringflow:automations-pipeline')
          ?? localStorage.getItem('hiringflow:pipeline')
        if (saved === 'workspace' || (ps as PipelineLite[]).find((p) => p.id === saved)) {
          setPipelineFilter(saved!)
        }
      } catch {}
      setLoading(false)
    })
  }, [])

  // Persist the pipeline filter to its own key so a saved 'workspace' here
  // doesn't bleed into the kanban (which has no 'workspace' option).
  useEffect(() => {
    try {
      if (pipelineFilter) localStorage.setItem('hiringflow:automations-pipeline', pipelineFilter)
      else localStorage.removeItem('hiringflow:automations-pipeline')
    } catch {}
  }, [pipelineFilter])

  const refresh = async () => {
    const params = new URLSearchParams()
    if (pipelineFilter === 'workspace') params.set('pipelineId', 'null')
    else if (pipelineFilter) params.set('pipelineId', pipelineFilter)
    const r = await fetch(`/api/automations${params.toString() ? `?${params}` : ''}`)
    if (r.ok) setRules(await r.json())
  }

  // Re-fetch when the pipeline filter changes so the table reflects the
  // selection. Doesn't reset other UI state (search, sort, etc.).
  useEffect(() => {
    if (loading) return
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineFilter])

  // Inject a {{xxx_link}} CTA into a workspace template's bodyHtml so the
  // recruiter doesn't have to hand-edit the template. Idempotent — does
  // nothing if the token is already present. The CTA uses the configured
  // training/scheduling name as the label when available, falling back to
  // a generic "Continue" / "Book interview" / "Join interview".
  //
  // Placement: inserts a new <p> immediately BEFORE the last <p> in the
  // body so the link sits above the signature line ("Best,/The Hiring
  // Team") — a sensible default. The recruiter can move it later by
  // hand-editing the template; we don't lock placement.
  const insertTokenInTemplate = async (
    templateId: string,
    kind: 'training' | 'scheduling' | 'meet_link' | 'background_check',
    label: string,
  ): Promise<boolean> => {
    const tpl = templates.find((t) => t.id === templateId)
    if (!tpl || !tpl.bodyHtml) return false
    const tokenMap = { training: '{{training_link}}', scheduling: '{{schedule_link}}', meet_link: '{{meeting_link}}', background_check: '{{certn_link}}' }
    const token = tokenMap[kind]
    if (tpl.bodyHtml.includes(token)) return true // already present
    const ctaHtml = `<p style="margin:24px 0"><a href="${token}" style="background:#FF9500;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:bold">${label}</a></p>`
    const lastOpen = tpl.bodyHtml.lastIndexOf('<p')
    const newBody = lastOpen === -1
      ? tpl.bodyHtml + '\n' + ctaHtml
      : tpl.bodyHtml.slice(0, lastOpen) + ctaHtml + '\n' + tpl.bodyHtml.slice(lastOpen)
    try {
      const r = await fetch(`/api/email-templates/${templateId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bodyHtml: newBody }),
      })
      if (!r.ok) return false
      const refreshed = await fetch('/api/email-templates')
      if (refreshed.ok) setTemplates(await refreshed.json())
      return true
    } catch {
      return false
    }
  }

  // Same idea for SMS — inject token at end of step.smsBody (in step
  // state, no API call). The step is saved when the recruiter clicks
  // Save on the rule modal.
  const insertTokenInSmsBody = (stepIdx: number, kind: 'training' | 'scheduling' | 'meet_link' | 'background_check') => {
    const tokenMap = { training: '{{training_link}}', scheduling: '{{schedule_link}}', meet_link: '{{meeting_link}}', background_check: '{{certn_link}}' }
    const token = tokenMap[kind]
    setSteps((prev) => prev.map((s, i) => {
      if (i !== stepIdx) return s
      const cur = s.smsBody || ''
      if (cur.includes(token)) return s
      return { ...s, smsBody: cur ? `${cur}\n${token}` : token }
    }))
  }

  // One-click "create from default" — used by the StepCard's template
  // dropdown when the recruiter picks a default that isn't yet in the
  // workspace. Returns the new template's id (or null on failure).
  const createDefaultTemplate = async (tpl: { name: string; subject: string; bodyHtml: string }): Promise<string | null> => {
    try {
      const r = await fetch('/api/email-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tpl.name, subject: tpl.subject, bodyHtml: tpl.bodyHtml }),
      })
      if (!r.ok) return null
      const newTpl = await r.json()
      const tplRes = await fetch('/api/email-templates')
      if (tplRes.ok) setTemplates(await tplRes.json())
      return newTpl.id as string
    } catch {
      return null
    }
  }

  // Ref on the inline template editor so we can scroll it into view when
  // it opens — otherwise clicking "Edit" on a step buried near the bottom
  // of the modal silently puts the editor below the visible area and the
  // recruiter thinks the button didn't work.
  const tplEditorRef = useRef<HTMLDivElement>(null)
  const [seedingNoShow, setSeedingNoShow] = useState(false)
  const seedNoShow = async () => {
    setSeedingNoShow(true)
    try {
      const r = await fetch('/api/automations/seed-no-show', { method: 'POST' })
      if (r.ok) {
        await refresh()
        const t = await fetch('/api/email-templates').then(r => r.json())
        setTemplates(t)
      }
    } finally {
      setSeedingNoShow(false)
    }
  }

  type PreviewData = {
    channel?: 'email' | 'sms'
    subject?: string
    html?: string
    text?: string | null
    smsBody?: string
    length?: number
    segments?: number
    recipient: string
    from: { name: string; email: string }
    templateName: string
    ruleName: string
    stepOrder?: number
  } | null
  const [previewLoading, setPreviewLoading] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewData>(null)
  const openPreview = async (r: Rule) => {
    setPreviewLoading(r.id)
    try {
      const res = await fetch(`/api/automations/${r.id}/preview`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(`Preview failed: ${data.error || res.statusText}`)
        return
      }
      const data = await res.json()
      setPreview({ ...data, ruleName: r.name })
    } finally {
      setPreviewLoading(null)
    }
  }

  // Draft preview — preview an unsaved step from the create/edit modal.
  // Per-step + per-channel: 'both' steps need two previews, the recruiter
  // toggles via the channel arg.
  const [draftPreviewLoading, setDraftPreviewLoading] = useState(false)
  const previewDraftStep = async (idx: number, channelOverride?: 'email' | 'sms') => {
    const step = steps[idx]
    if (!step) return
    const ch = channelOverride
      ?? (step.channel === 'sms' ? 'sms' : 'email')
    setDraftPreviewLoading(true)
    try {
      const res = await fetch('/api/automations/preview-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: ch,
          emailTemplateId: step.emailTemplateId,
          smsBody: step.smsBody,
          nextStepType: step.nextStepType,
          trainingId: step.trainingId,
          schedulingConfigId: step.schedulingConfigId,
          emailDestination: step.emailDestination,
          emailDestinationAddress: step.emailDestinationAddress,
          smsDestination: step.smsDestination,
          smsDestinationNumber: step.smsDestinationNumber,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(`Preview failed: ${data.error || res.statusText}`)
        return
      }
      const data = await res.json()
      setPreview({ ...data, ruleName: name || '(unsaved rule)', stepOrder: idx })
    } finally {
      setDraftPreviewLoading(false)
    }
  }

  const openCreate = async () => {
    setEditing(null)
    const trigger = 'flow_completed'
    setTriggerType(trigger)
    setName(`${TRIGGER_LABELS[trigger]} follow-up`)
    setFlowId('')
    setTriggerTrainingId('')
    setStageIdField('')
    // Default new rules to the active pipeline filter when one is selected,
    // so a recruiter creating from the Dispatcher view gets a Dispatcher
    // rule by default. 'workspace' (any-pipeline) keeps as ''.
    setPipelineIdField(pipelineFilter && pipelineFilter !== 'workspace' ? pipelineFilter : '')
    setMinutesBefore(60); setWaitForRecording(false)

    // Always run seed — it's idempotent on the server (inserts only the
    // default templates whose names don't already exist). This way, when
    // we add new entries to DEFAULT_EMAIL_TEMPLATES in code, existing
    // workspaces pick them up automatically on next "+ New rule"
    // — not just brand-new workspaces with empty templates.
    let availableTemplates = templates
    try {
      const seedRes = await fetch('/api/email-templates/seed', { method: 'POST' })
      const seedData = seedRes.ok ? await seedRes.json().catch(() => null) : null
      // Only re-fetch if seed actually created something new, or if we
      // started with an empty list (first open on a fresh workspace).
      if ((seedData && seedData.created > 0) || availableTemplates.length === 0) {
        const r = await fetch('/api/email-templates')
        if (r.ok) {
          availableTemplates = await r.json()
          setTemplates(availableTemplates)
        }
      }
    } catch { /* fall through with current templates */ }
    const prefillId = pickDefaultTemplateId(trigger, availableTemplates)
    setSteps([newStep(0, prefillId)])
    setTemplateEditorStepIdx(null)
    setSaveError(null)
    setSaveWarnings([])
    setWarningsAcked(false)
    setShowModal(true)
  }
  const openEdit = (r: Rule) => {
    setEditing(r); setName(r.name); setTriggerType(r.triggerType)
    setFlowId(r.flowId || (r as { triggerAutomationId?: string }).triggerAutomationId || '')
    setTriggerTrainingId(r.trainingId ?? '')
    setStageIdField(r.stageId ?? '')
    setPipelineIdField(r.pipelineId ?? '')
    setMinutesBefore(r.minutesBefore || 60)
    setWaitForRecording(!!r.waitForRecording)
    // Hydrate steps. Older rules may have an empty steps[] (pre-backfill).
    // Synthesize a single step from the legacy rule fields in that case so
    // the editor stays usable until the backfill runs.
    if (r.steps && r.steps.length > 0) {
      // Force all follow-ups to inherit step 0's timingMode — the picker is
      // hidden on follow-ups, so a saved inconsistency would otherwise be
      // invisible to the recruiter.
      const tm0 = (r.steps[0] as StepShape).timingMode
      const parentMode: StepShape['timingMode'] =
        tm0 === 'before_meeting' || tm0 === 'after_meeting' ? tm0 : 'trigger'
      setSteps(r.steps.map((s, i) => {
        const tm = (s as StepShape).timingMode
        const ownMode: StepShape['timingMode'] =
          tm === 'before_meeting' || tm === 'after_meeting' ? tm : 'trigger'
        return {
          ...s,
          order: i,
          channel: (s.channel === 'sms' || s.channel === 'both') ? s.channel : 'email',
          timingMode: i === 0 ? ownMode : parentMode,
          emailDestination: (s.emailDestination as StepShape['emailDestination']) || 'applicant',
          smsDestination: (s.smsDestination as StepShape['smsDestination']) || 'applicant',
          smsDestinationNumber: s.smsDestinationNumber ?? null,
        }
      }))
    } else {
      setSteps([{
        order: 0,
        delayMinutes: r.delayMinutes ?? 0,
        timingMode: 'trigger',
        channel: r.channel === 'sms' ? 'sms' : 'email',
        emailTemplateId: r.emailTemplateId ?? null,
        smsTemplateId: null,
        smsBody: r.smsBody ?? null,
        emailDestination: (r.emailDestination as StepShape['emailDestination']) || 'applicant',
        emailDestinationAddress: r.emailDestinationAddress ?? null,
        smsDestination: 'applicant',
        smsDestinationNumber: null,
        nextStepType: r.nextStepType ?? null,
        nextStepUrl: r.nextStepUrl ?? null,
        trainingId: r.trainingId ?? null,
        schedulingConfigId: r.schedulingConfigId ?? null,
      }])
    }
    setTemplateEditorStepIdx(null)
    setSaveError(null)
    setSaveWarnings([])
    setWarningsAcked(false)
    setShowModal(true)
  }

  const updateStep = (idx: number, patch: Partial<StepShape>) => {
    setSteps((prev) => prev.map((s, i) => {
      if (i === idx) return { ...s, ...patch }
      // When step 0's timingMode changes, follow-ups silently inherit it —
      // the picker is hidden for them precisely so they always match.
      if (idx === 0 && i > 0 && patch.timingMode !== undefined) {
        return { ...s, timingMode: patch.timingMode }
      }
      return s
    }))
  }
  const addStep = () => {
    setSteps((prev) => [...prev, {
      ...newStep(prev.length, templates[0]?.id),
      // Inherit timingMode from step 0 so the (hidden) picker is consistent.
      timingMode: prev[0]?.timingMode ?? 'trigger',
      delayMinutes: 1440, // follow-ups default to 1 day after the trigger
    }])
  }
  const removeStep = (idx: number) => {
    setSteps((prev) => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, order: i })))
    if (templateEditorStepIdx === idx) setTemplateEditorStepIdx(null)
  }
  const moveStep = (idx: number, dir: -1 | 1) => {
    setSteps((prev) => {
      const next = [...prev]
      const swap = idx + dir
      if (swap < 0 || swap >= next.length) return prev
      ;[next[idx], next[swap]] = [next[swap], next[idx]]
      return next.map((s, i) => ({ ...s, order: i }))
    })
  }

  const save = async (opts: { forceAck?: boolean } = {}) => {
    setSaveError(null)
    if (!name.trim()) { setSaveError('Name is required'); return }
    // stage_entered rules must pin to a specific (pipeline, stage). The
    // server enforces this too; the client check is just for a friendlier
    // inline error instead of a round-trip 400.
    if (triggerType === 'stage_entered') {
      if (!pipelineIdField) { setSaveError('Stage Entered rules require a pipeline'); return }
      if (!stageIdField) { setSaveError('Stage Entered rules require a stage'); return }
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      const wantsEmail = s.channel === 'email' || s.channel === 'both'
      const wantsSms = s.channel === 'sms' || s.channel === 'both'
      if (wantsEmail && !s.emailTemplateId) { setSaveError(`Step ${i + 1}: pick an email template`); return }
      if (wantsSms && (!s.smsBody || !s.smsBody.trim())) { setSaveError(`Step ${i + 1}: SMS body is required`); return }
    }

    // Soft guard: surface body/trigger mismatches. When the rule is scoped
    // to a specific pipeline, derive that pipeline's feature footprint from
    // its stage triggers so we suppress warnings whose topic isn't reachable
    // there (e.g. don't warn about "starting the training" for a rule pinned
    // to a pipeline with no training stages). Empty pipelineId = any pipeline
    // → no filtering, all patterns apply.
    const scopedPipeline = pipelineIdField
      ? pipelines.find((p) => p.id === pipelineIdField) ?? null
      : null
    const pipelineFeatures = scopedPipeline
      ? deriveFeaturesFromStageTriggers(
          (scopedPipeline.stages ?? []).flatMap((s) => (s.triggers ?? []).map((t) => t.event)),
        )
      : null
    const warnings = detectAutomationWarnings({
      triggerType,
      name,
      pipelineFeatures,
      steps: steps.map((s) => ({
        channel: s.channel,
        smsBody: s.smsBody,
        emailTemplate: s.emailTemplate
          ?? (s.emailTemplateId ? templates.find((t) => t.id === s.emailTemplateId) ?? null : null),
      })),
    })
    if (warnings.length > 0 && !warningsAcked && !opts.forceAck) {
      setSaveWarnings(warnings)
      return
    }
    setSaveWarnings([])

    setSaving(true)
    const isTrainingTrigger = triggerType === 'training_started' || triggerType === 'training_completed'
    const body = {
      name, triggerType,
      flowId: (!SESSION_WIDE_TRIGGERS.has(triggerType)) ? (flowId || null) : null,
      trainingId: isTrainingTrigger ? (triggerTrainingId || null) : null,
      stageId: stageIdField || null,
      // Pipeline scope. Empty = "any pipeline" (workspace-wide rule). When
      // set, the rule only fires for candidates whose flow's pipeline
      // matches.
      pipelineId: pipelineIdField || null,
      triggerAutomationId: triggerType === 'automation_completed' ? (flowId || null) : null,
      minutesBefore: triggerType === 'before_meeting' ? minutesBefore : null,
      waitForRecording: triggerType === 'meeting_ended' ? waitForRecording : false,
      steps: steps.map((s, i) => ({
        order: i,
        delayMinutes: s.delayMinutes ?? 0,
        timingMode: s.timingMode ?? 'trigger',
        channel: s.channel,
        emailTemplateId: s.emailTemplateId,
        smsBody: s.smsBody,
        emailDestination: s.emailDestination,
        emailDestinationAddress: s.emailDestinationAddress,
        smsDestination: s.smsDestination,
        smsDestinationNumber: s.smsDestinationNumber,
        nextStepType: s.nextStepType,
        nextStepUrl: s.nextStepUrl,
        trainingId: s.trainingId,
        schedulingConfigId: s.schedulingConfigId,
      })),
    }
    try {
      const url = editing ? `/api/automations/${editing.id}` : '/api/automations'
      const method = editing ? 'PATCH' : 'POST'
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setSaveError(data.error || `Save failed (${res.status})`)
        return
      }
      setShowModal(false)
      refresh()
    } finally {
      setSaving(false)
    }
  }

  // Auto-suffix the candidate name if a workspace template already uses it.
  // First conflict picks "<Name> (custom)", then "<Name> (custom 2)", ...
  // Lets the recruiter pick a default, edit, and save without manually
  // renaming — the system avoids the duplicate without extra UI.
  const resolveUniqueTemplateName = (candidate: string, existing: { name: string }[]): string => {
    const taken = new Set(existing.map((t) => t.name))
    if (!taken.has(candidate)) return candidate
    if (!taken.has(`${candidate} (custom)`)) return `${candidate} (custom)`
    for (let i = 2; i < 100; i++) {
      const next = `${candidate} (custom ${i})`
      if (!taken.has(next)) return next
    }
    return `${candidate} (custom ${Date.now()})` // last-resort fallback
  }

  const [tplSaveError, setTplSaveError] = useState<string | null>(null)
  const createTemplate = async () => {
    setTplSaveError(null)
    // Pull HTML from the DOM ref rather than React state — the click that
    // invoked us also blurred the contenteditable, and that blur's setState
    // hasn't committed yet. Falls back to newTplBody for the rare case the
    // ref isn't mounted (e.g. unit-test harness).
    const bodyHtml = richEditorRef.current?.getHtml() ?? newTplBody
    if (!newTplName.trim()) { setTplSaveError('Template name is required'); return }
    if (!newTplSubject.trim()) { setTplSaveError('Subject is required'); return }
    if (!bodyHtml.trim()) { setTplSaveError('Body is required'); return }
    setSavingTpl(true)
    try {
      // Branch on edit-in-place vs new-template intent. Edit-in-place keeps
      // the same template id so every rule that points at it sees the update;
      // POST creates a new row and rebinds only the step we opened from.
      if (templateEditorEditingId) {
        const r = await fetch(`/api/email-templates/${templateEditorEditingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newTplName.trim(), subject: newTplSubject, bodyHtml }),
        })
        if (!r.ok) {
          const data = await r.json().catch(() => ({}))
          setTplSaveError(data.error || `Save failed (${r.status})`)
          return
        }
        const tplRes = await fetch('/api/email-templates')
        if (tplRes.ok) setTemplates(await tplRes.json())
      } else {
        const finalName = resolveUniqueTemplateName(newTplName.trim(), templates)
        const r = await fetch('/api/email-templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: finalName, subject: newTplSubject, bodyHtml }),
        })
        if (!r.ok) {
          const data = await r.json().catch(() => ({}))
          setTplSaveError(data.error || `Save failed (${r.status})`)
          return
        }
        const newTpl = await r.json()
        const tplRes = await fetch('/api/email-templates')
        if (tplRes.ok) setTemplates(await tplRes.json())
        if (templateEditorStepIdx !== null) {
          updateStep(templateEditorStepIdx, { emailTemplateId: newTpl.id })
        }
      }
      setTemplateEditorStepIdx(null)
      setTemplateEditorEditingId(null)
      setNewTplName(''); setNewTplSubject(''); setNewTplBody('<p>Hi {{candidate_name}},</p>\n<p></p>')
    } catch (err) {
      setTplSaveError(err instanceof Error ? err.message : 'Save failed')
      return
    } finally {
      setSavingTpl(false)
    }
  }

  // SMS template inline-create mirror of createTemplate. Name uniqueness is
  // scoped to SMS templates (you can have an email named "Reminder" and an
  // SMS also named "Reminder" — different drawers, different lists).
  const resolveUniqueSmsTemplateName = (candidate: string, list: { name: string }[]): string => {
    const taken = new Set(list.map((t) => t.name))
    if (!taken.has(candidate)) return candidate
    for (let i = 2; i < 1000; i++) {
      const next = `${candidate} (${i})`
      if (!taken.has(next)) return next
    }
    return `${candidate} (custom ${Date.now()})`
  }
  const createSmsTemplate = async () => {
    setTplSaveError(null)
    if (!newTplName.trim()) { setTplSaveError('Template name is required'); return }
    if (!newSmsTplBody.trim()) { setTplSaveError('Body is required'); return }
    setSavingTpl(true)
    try {
      if (smsTemplateEditorEditingId) {
        const r = await fetch(`/api/sms-templates/${smsTemplateEditorEditingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newTplName.trim(), body: newSmsTplBody }),
        })
        if (!r.ok) {
          const data = await r.json().catch(() => ({}))
          setTplSaveError(data.error || `Save failed (${r.status})`)
          return
        }
        const tplRes = await fetch('/api/sms-templates')
        if (tplRes.ok) setSmsTemplates(await tplRes.json())
        // Mirror the edited body into the step's smsBody so the inline
        // preview reflects the new content. The template id stays the same.
        if (templateEditorStepIdx !== null) {
          updateStep(templateEditorStepIdx, { smsBody: newSmsTplBody })
        }
        setTemplateEditorStepIdx(null)
        setSmsTemplateEditorEditingId(null)
        setNewTplName(''); setNewSmsTplBody('Hi {{candidate_name}}, ')
        return
      }
      const finalName = resolveUniqueSmsTemplateName(newTplName.trim(), smsTemplates)
      const r = await fetch('/api/sms-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: finalName, body: newSmsTplBody }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        setTplSaveError(data.error || `Save failed (${r.status})`)
        return
      }
      const newTpl = await r.json()
      const tplRes = await fetch('/api/sms-templates')
      if (tplRes.ok) setSmsTemplates(await tplRes.json())
      // Bind to the step that opened the editor, and also drop the body into
      // smsBody so the step's textarea reflects the saved content.
      if (templateEditorStepIdx !== null) {
        updateStep(templateEditorStepIdx, { smsTemplateId: newTpl.id, smsBody: newTpl.body })
      }
      setTemplateEditorStepIdx(null)
      setNewTplName(''); setNewSmsTplBody('Hi {{candidate_name}}, ')
    } catch (err) {
      setTplSaveError(err instanceof Error ? err.message : 'Save failed')
      return
    } finally {
      setSavingTpl(false)
    }
  }

  const toggle = async (r: Rule) => {
    await fetch(`/api/automations/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: !r.isActive }) })
    refresh()
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this automation?')) return
    await fetch(`/api/automations/${id}`, { method: 'DELETE' }); refresh()
  }

  // ID of the most recently duplicated rule. The row renders a brief flash so
  // the recruiter can spot where the copy landed (right below the source) —
  // important when the table is long or filtered to a specific pipeline.
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const duplicate = async (r: Rule) => {
    const res = await fetch(`/api/automations/${r.id}/duplicate`, { method: 'POST' })
    if (!res.ok) {
      alert('Failed to duplicate automation')
      return
    }
    const copy = (await res.json().catch(() => null)) as Rule | null
    if (!copy) {
      // Server didn't return the new row — fall back to refetch.
      refresh()
      return
    }
    // Insert immediately after the source so the recruiter can spot the copy
    // without scrolling. The server backdates the duplicate's createdAt by
    // 1ms so the same position is preserved across reloads — see
    // src/app/api/automations/[id]/duplicate/route.ts.
    setRules((cur) => {
      const idx = cur.findIndex((x) => x.id === r.id)
      if (idx === -1) return [copy, ...cur]
      return [...cur.slice(0, idx + 1), copy, ...cur.slice(idx + 1)]
    })
    setHighlightId(copy.id)
    setTimeout(() => {
      setHighlightId((cur) => (cur === copy.id ? null : cur))
    }, 2000)
  }

  // localStorage keys for the remembered test recipient. Stored per channel so
  // email and SMS lists don't collide (recruiter usually has one go-to address
  // and one go-to phone for testing).
  const TEST_EMAIL_KEY = 'hiringflow:test_email'
  const TEST_PHONE_KEY = 'hiringflow:test_phone'

  const openTestModal = (r: Rule) => {
    const firstStepChannel = r.steps?.[0]?.channel ?? r.channel ?? 'email'
    const isSms = firstStepChannel === 'sms'
    let remembered = ''
    if (typeof window !== 'undefined') {
      remembered = window.localStorage.getItem(isSms ? TEST_PHONE_KEY : TEST_EMAIL_KEY) ?? ''
    }
    setTestRecipient(remembered)
    setTestResult(null)
    setTestModal({ rule: r, isSms })
  }

  const submitTest = async () => {
    if (!testModal) return
    const { rule: r, isSms } = testModal
    const to = testRecipient.trim()
    if (!to) { setTestResult({ kind: 'err', message: 'Enter an email or phone' }); return }
    if (isSms ? !/^\+?\d[\d\s().-]{6,}$/.test(to) : !to.includes('@')) {
      setTestResult({ kind: 'err', message: isSms ? 'Phone should look like +15551234567' : 'That doesn’t look like an email' })
      return
    }
    setTestingId(r.id)
    setTestResult(null)
    try {
      const res = await fetch(`/api/automations/${r.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success) {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(isSms ? TEST_PHONE_KEY : TEST_EMAIL_KEY, to)
        }
        setTestResult({ kind: 'ok', message: `Sent to ${data.sentTo}. A tracked candidate was created (source: test) — view it in Candidates to follow the path.` })
      } else if (res.ok && data.sessionId) {
        setTestResult({ kind: 'err', message: `Candidate created but the message did not send: ${data.error || 'unknown error'}. You can still view the candidate in Candidates.` })
      } else {
        setTestResult({ kind: 'err', message: data.error || 'Test failed' })
      }
    } catch (err) {
      setTestResult({ kind: 'err', message: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTestingId(null)
    }
  }

  const openExecutionsModal = async (rule: Rule) => {
    setExecutionsModal({ rule, loading: true, items: [] })
    try {
      const res = await fetch(`/api/automations/${rule.id}/executions?limit=500`)
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || 'Failed to load executions')
      setExecutionsModal({ rule, loading: false, items: data ?? [] })
    } catch (err) {
      setExecutionsModal({
        rule,
        loading: false,
        items: [],
        error: err instanceof Error ? err.message : 'Failed to load executions',
      })
    }
  }

  // Stage list shown in the rule editor's stage dropdown. Follows the
  // pipeline picker — picking "Cleaner" surfaces Cleaner's stages, picking
  // "Dispatcher" surfaces Dispatcher's. Empty pipelineIdField ("Any pipeline")
  // falls back to the workspace default.
  const editorStages = useMemo(() => {
    if (!pipelineIdField) return stages
    const picked = pipelines.find((p) => p.id === pipelineIdField)
    if (picked?.stages && picked.stages.length > 0) return picked.stages
    return stages
  }, [pipelineIdField, pipelines, stages])

  // When the user switches the rule's pipeline to one that doesn't contain
  // the previously-chosen stage, drop back to "Auto" — saving with a stage
  // id that doesn't belong to the new pipeline would leave a dangling
  // reference the journey UI can't render.
  useEffect(() => {
    if (!stageIdField) return
    if (!editorStages.some((s) => s.id === stageIdField)) setStageIdField('')
  }, [editorStages, stageIdField])

  // Effective stage lookups — explicit stageId wins, else first stage (in
  // funnel order) whose triggers claim the rule's triggerType. Order is
  // taken from the stage's funnel position; rules without any stage match
  // get Number.MAX_SAFE_INTEGER so they sort to the end of journey order.
  const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages])
  const stageOrderByEvent = useMemo(() => {
    const m = new Map<string, { stageId: string; order: number }>()
    for (const s of stages) {
      for (const t of s.triggers ?? []) {
        const cur = m.get(t.event)
        if (!cur || s.order < cur.order) m.set(t.event, { stageId: s.id, order: s.order })
      }
    }
    return m
  }, [stages])
  const effectiveStageOf = (r: Rule): { id: string | null; order: number; label: string } => {
    if (r.stageId) {
      const s = stageById.get(r.stageId)
      if (s) return { id: s.id, order: s.order, label: s.label }
    }
    const implicit = stageOrderByEvent.get(r.triggerType)
    if (implicit) {
      const s = stageById.get(implicit.stageId)
      if (s) return { id: s.id, order: s.order, label: s.label }
    }
    return { id: null, order: Number.MAX_SAFE_INTEGER, label: '—' }
  }

  if (loading) return <div className="py-14 text-center font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>Loading…</div>

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow={`${rules.length} rule${rules.length === 1 ? '' : 's'}`}
        title="Automations"
        description="Trigger emails and SMS when candidates complete flows, trainings, or interviews."
        actions={
          <>
            <Link href="/dashboard/content" className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-[10px] text-[13px] font-medium text-ink bg-transparent border border-surface-border hover:bg-surface-light transition-colors">
              Templates
            </Link>
            <Button size="sm" onClick={openCreate}>+ New rule</Button>
          </>
        }
      />

      <div className="px-8 py-6">

      {!rules.some((r) => r.triggerType === 'meeting_no_show') && (
        <div className="mb-4 px-4 py-3 rounded-[10px] bg-amber-50 border border-amber-200 flex items-center justify-between gap-3">
          <div className="text-[13px] text-amber-900">
            <span className="font-medium">No no-show follow-up yet.</span>{' '}
            We&apos;ll detect candidate no-shows automatically and move them to Rejected. Add a default email
            so they&apos;re invited to re-book.
          </div>
          <button
            onClick={seedNoShow}
            disabled={seedingNoShow}
            className="text-xs px-3 py-1.5 rounded-[8px] bg-amber-600 text-white hover:bg-amber-700 font-medium disabled:opacity-50 whitespace-nowrap"
          >
            {seedingNoShow ? 'Setting up…' : 'Add default no-show email'}
          </button>
        </div>
      )}

      {/* Pipeline tabs — primary scope picker. Mirrors the kanban switcher
          so a recruiter viewing the Cleaner kanban can flip to the Cleaner
          automations page and see only those rules. Persisted in
          localStorage; the 'workspace' synthetic pipeline shows rules with
          pipelineId=null (any-pipeline). */}
      {pipelines.length > 0 && (
        <div data-no-pan className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-[11px] font-mono uppercase text-grey-35 tracking-wider mr-1">Pipeline</span>
          <button
            onClick={() => setPipelineFilter('')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border text-[12px] font-medium transition-colors ${
              pipelineFilter === ''
                ? 'bg-ink text-white border-ink'
                : 'bg-white text-grey-35 border-surface-border hover:border-grey-50 hover:text-ink'
            }`}
          >
            All
            <span className={`font-mono text-[10px] tabular-nums ${pipelineFilter === '' ? 'text-white/80' : 'text-grey-50'}`}>
              {rules.length}
            </span>
          </button>
          {pipelines.map((p) => {
            const isActive = pipelineFilter === p.id
            return (
              <button
                key={p.id}
                onClick={() => setPipelineFilter(p.id)}
                title={p.isDefault ? 'Default pipeline — rules here apply to flows without an explicit pipeline.' : undefined}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border text-[12px] font-medium transition-colors ${
                  isActive
                    ? 'bg-ink text-white border-ink'
                    : 'bg-white text-grey-35 border-surface-border hover:border-grey-50 hover:text-ink'
                }`}
              >
                {p.name}{p.isDefault ? ' · default' : ''}
              </button>
            )
          })}
          <button
            onClick={() => setPipelineFilter('workspace')}
            title="Rules with no pipeline scope — they fire workspace-wide regardless of pipeline."
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border text-[12px] font-medium transition-colors ${
              pipelineFilter === 'workspace'
                ? 'bg-ink text-white border-ink'
                : 'bg-white text-grey-35 border-surface-border hover:border-grey-50 hover:text-ink'
            }`}
          >
            Any-pipeline
          </button>
        </div>
      )}

      {rules.length > 0 && <AutomationPipeline
        rules={rules}
        stages={stages}
        activeStageId={stageFilter}
        onPickStage={(id) => setStageFilter(stageFilter === id ? null : id)}
      />}

      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-xs text-grey-40 mr-2">Filter:</span>
          {([
            { v: 'all' as const, l: `All (${rules.length})` },
            { v: 'applicant' as const, l: `Applicant (${rules.filter(r => firstStepDest(r) === 'applicant').length})` },
            { v: 'company' as const, l: `Company (${rules.filter(r => firstStepDest(r) !== 'applicant').length})` },
          ]).map((o) => (
            <button key={o.v} onClick={() => setDestinationFilter(o.v)}
              className={`text-xs px-3 py-1.5 rounded-full border font-medium ${destinationFilter === o.v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-35'}`}>
              {o.l}
            </button>
          ))}
          <button onClick={() => setActiveOnly(!activeOnly)}
            className={`text-xs px-3 py-1.5 rounded-full border font-medium ${activeOnly ? 'border-green-500 bg-green-50 text-green-700' : 'border-surface-border text-grey-35'}`}>
            Active only
          </button>
          {stageFilter && (
            <button onClick={() => setStageFilter(null)}
              className="text-xs px-3 py-1.5 rounded-full bg-brand-50 text-brand-700 border border-brand-200 font-medium">
              {stageFilter === '__unassigned'
                ? 'Unassigned'
                : (stages.find((s) => s.id === stageFilter)?.label ?? stageFilter)
              } ×
            </button>
          )}
        </div>
      )}

      {rules.length === 0 ? (
        <div className="section-card text-center py-16">
          <div className="w-16 h-16 mx-auto mb-4 bg-brand-50 rounded-[8px] flex items-center justify-center">
            <svg className="w-8 h-8 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          </div>
          <h2 className="text-xl font-semibold text-grey-15 mb-2">No automations yet</h2>
          <p className="text-grey-35 mb-4">Create email templates first, then set up automations</p>
          <div className="flex gap-3 justify-center">
            <Link href="/dashboard/content" className="btn-secondary">Create Template</Link>
            <button onClick={openCreate} className="btn-primary">+ Create Automation</button>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-surface-border overflow-hidden">
          <table className="min-w-full">
            <thead>
              <tr className="border-b border-surface-border bg-surface">
                <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Name</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">
                  <button
                    onClick={() => setJourneySort(journeySort === 'asc' ? 'desc' : journeySort === 'desc' ? null : 'asc')}
                    title="Sort by journey order. Click to cycle: asc → desc → off."
                    className={`inline-flex items-center gap-1 hover:text-grey-15 ${journeySort ? 'text-brand-600' : ''}`}
                  >
                    Stage
                    <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      {journeySort === 'asc' ? (
                        <>
                          <path d="M6 9V3" />
                          <path d="M3 6l3-3 3 3" />
                        </>
                      ) : journeySort === 'desc' ? (
                        <>
                          <path d="M6 3v6" />
                          <path d="M3 6l3 3 3-3" />
                        </>
                      ) : (
                        <>
                          <path d="M3 4l3-2 3 2" />
                          <path d="M3 8l3 2 3-2" />
                        </>
                      )}
                    </svg>
                  </button>
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Trigger</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Flow</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Steps</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">First step</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Sent</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Status</th>
                <th className="px-5 py-3 text-right text-xs font-medium text-grey-40 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {rules
                .filter(r => destinationFilter === 'all' || (destinationFilter === 'applicant' ? firstStepDest(r) === 'applicant' : firstStepDest(r) !== 'applicant'))
                .filter(r => !activeOnly || r.isActive)
                .filter(r => {
                  if (!stageFilter) return true
                  const eff = effectiveStageOf(r)
                  if (stageFilter === '__unassigned') return eff.id === null
                  return eff.id === stageFilter
                })
                .slice() // copy before sort to avoid mutating filtered array's source
                .sort((a, b) => {
                  if (!journeySort) return 0
                  const oa = effectiveStageOf(a).order
                  const ob = effectiveStageOf(b).order
                  return journeySort === 'asc' ? oa - ob : ob - oa
                })
                .map((r) => {
                  const firstStep = r.steps?.[0]
                  const eff = effectiveStageOf(r)
                  const isExplicit = !!r.stageId
                  return (
                    <tr
                      key={r.id}
                      className={`hover:bg-surface-light transition-colors duration-700 ${
                        highlightId === r.id ? 'bg-brand-50' : ''
                      }`}
                    >
                      <td className="px-5 py-4 text-sm font-medium text-grey-15">{r.name}</td>
                      <td className="px-5 py-4">
                        {eff.id ? (
                          <span
                            title={isExplicit ? 'Stage explicitly set on this rule' : 'Inferred from trigger — set explicitly in Edit if you want to override'}
                            className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium ${
                              isExplicit ? 'bg-brand-50 text-brand-700' : 'bg-gray-100 text-grey-40'
                            }`}
                          >
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: stageById.get(eff.id!)?.color ?? '#999' }} />
                            {eff.label}
                            {!isExplicit && <span className="opacity-60">(auto)</span>}
                          </span>
                        ) : (
                          <span className="text-xs px-2.5 py-1 rounded-full font-medium bg-amber-50 text-amber-700 border border-dashed border-amber-200">
                            Unassigned
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-4"><span className={`text-xs px-2.5 py-1 rounded-full font-medium ${r.triggerType === 'training_completed' ? 'bg-green-50 text-green-700' : 'bg-brand-50 text-brand-600'}`}>{TRIGGER_LABELS[r.triggerType] || r.triggerType}</span></td>
                      <td className="px-5 py-4 text-sm text-grey-35">{r.flow?.name || 'Any flow'}</td>
                      <td className="px-5 py-4 text-xs text-grey-35">
                        {r.steps && r.steps.length > 0 ? (
                          <span className="inline-flex items-center gap-1 flex-wrap">
                            {r.steps.map((s, i) => (
                              <span key={i} className="inline-flex items-center gap-1">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wide ${
                                  s.channel === 'both' ? 'bg-violet-50 text-violet-700'
                                  : s.channel === 'sms' ? 'bg-purple-50 text-purple-700'
                                  : 'bg-blue-50 text-blue-700'}`}>
                                  {s.channel === 'both' ? 'E+S' : s.channel === 'sms' ? 'SMS' : 'EMAIL'}
                                </span>
                                <span className="text-[10px] text-grey-40">{formatDelay(s.delayMinutes)}</span>
                                {i < r.steps.length - 1 && <span className="text-grey-50">→</span>}
                              </span>
                            ))}
                          </span>
                        ) : <span className="text-grey-50 italic">No steps</span>}
                      </td>
                      <td className="px-5 py-4 text-sm text-grey-35">
                        {firstStep?.channel === 'sms' ? (
                          <span className="truncate max-w-[200px] text-xs text-grey-40 font-mono inline-block">{(firstStep.smsBody || '').slice(0, 60)}{(firstStep.smsBody || '').length > 60 ? '…' : ''}</span>
                        ) : firstStep?.emailTemplate?.name || r.emailTemplate?.name || <span className="text-grey-50 italic">No template</span>}
                      </td>
                      <td className="px-5 py-4 text-sm font-medium text-grey-15">
                        {r._count.executions > 0 ? (
                          <button
                            onClick={() => openExecutionsModal(r)}
                            title="See which candidates this automation has run for"
                            className="text-brand-600 hover:text-brand-700 hover:underline"
                          >
                            {r._count.executions}
                          </button>
                        ) : (
                          <span className="text-grey-50">0</span>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <button onClick={() => toggle(r)} className={`text-xs px-2.5 py-1 rounded-full font-medium ${r.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-grey-40'}`}>
                          {r.isActive ? 'Active' : 'Paused'}
                        </button>
                      </td>
                      <td className="px-5 py-4 text-right space-x-3">
                        <button onClick={() => openPreview(r)} disabled={previewLoading === r.id} className="text-xs text-brand-600 hover:text-brand-700 disabled:opacity-50">
                          {previewLoading === r.id ? 'Loading…' : 'Preview'}
                        </button>
                        <button onClick={() => openTestModal(r)} disabled={testingId === r.id} className="text-xs text-brand-600 hover:text-brand-700 disabled:opacity-50">
                          {testingId === r.id ? 'Sending…' : 'Test'}
                        </button>
                        <button onClick={() => duplicate(r)} className="text-xs text-grey-35 hover:text-grey-15">Duplicate</button>
                        <button onClick={() => openEdit(r)} className="text-xs text-grey-35 hover:text-grey-15">Edit</button>
                        <button onClick={() => remove(r.id)} className="text-xs text-grey-35 hover:text-grey-15">Delete</button>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      )}

      {/* Preview modal */}
      {preview && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center z-[60] p-4" onClick={() => setPreview(null)}>
          <div
            className="bg-white rounded-[12px] shadow-2xl w-full max-w-[760px] max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-surface-border flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-xs text-grey-40 font-medium uppercase tracking-wide">Preview {preview.stepOrder !== undefined ? `· Step ${preview.stepOrder + 1}` : ''}</div>
                <h2 className="text-lg font-semibold text-grey-15 truncate">{preview.ruleName}</h2>
                <div className="text-xs text-grey-40 mt-0.5">Template: {preview.templateName}</div>
              </div>
              <button
                onClick={() => setPreview(null)}
                className="text-grey-40 hover:text-grey-15 text-xl leading-none px-2"
                aria-label="Close"
              >×</button>
            </div>
            <div className="px-6 py-4 border-b border-surface-border bg-surface-light text-[13px] space-y-1.5">
              <div className="flex gap-2"><span className="text-grey-40 w-16 flex-shrink-0">Channel</span><span className="text-grey-15 font-medium uppercase">{preview.channel || 'email'}</span></div>
              <div className="flex gap-2"><span className="text-grey-40 w-16 flex-shrink-0">From</span><span className="text-grey-15">{preview.from.name} &lt;{preview.from.email}&gt;</span></div>
              <div className="flex gap-2"><span className="text-grey-40 w-16 flex-shrink-0">To</span><span className="text-grey-15">{preview.recipient}</span></div>
              {preview.channel !== 'sms' && (
                <div className="flex gap-2"><span className="text-grey-40 w-16 flex-shrink-0">Subject</span><span className="text-grey-15 font-medium">{preview.subject}</span></div>
              )}
              {preview.channel === 'sms' && preview.length !== undefined && (
                <div className="flex gap-2"><span className="text-grey-40 w-16 flex-shrink-0">Length</span><span className="text-grey-15 font-mono">{preview.length} chars · {preview.segments} segment{(preview.segments || 0) > 1 ? 's' : ''}</span></div>
              )}
            </div>
            <div className="flex-1 overflow-auto">
              {preview.channel === 'sms' ? (
                <div className="p-6">
                  <div className="max-w-[320px] mx-auto bg-blue-500 text-white rounded-2xl rounded-bl-sm px-4 py-3 text-sm whitespace-pre-wrap break-words shadow">
                    {preview.smsBody}
                  </div>
                </div>
              ) : (
                <div className="p-6 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: preview.html || '' }} />
              )}
            </div>
            <div className="px-6 py-3 border-t border-surface-border bg-surface-light flex items-center justify-between text-xs text-grey-40">
              <span>Sample values shown for merge tokens. No message sent.</span>
              <button onClick={() => setPreview(null)} className="text-grey-15 hover:text-grey-40 font-medium">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-[12px] shadow-2xl my-8 p-8 w-full max-w-[640px]" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-semibold text-grey-15 mb-6">{editing ? 'Edit Automation' : 'Create Automation'}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Send scheduling after training" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Trigger</label>
                <div className="flex gap-2 flex-wrap">
                  {TRIGGERS.map(t => (
                    <button key={t.value} onClick={() => setTriggerType(t.value)} className={`py-2.5 px-3 text-xs rounded-[8px] border font-medium ${triggerType === t.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-35'}`}>{t.label}</button>
                  ))}
                </div>
              </div>
              {triggerType === 'meeting_ended' && (
                <div className="p-3 bg-surface-weak rounded-[8px]">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={waitForRecording} onChange={(e) => setWaitForRecording(e.target.checked)} className="mt-0.5 h-4 w-4" />
                    <div className="text-xs">
                      <div className="font-medium text-grey-15">Wait for recording before sending</div>
                      <div className="text-grey-40 mt-0.5">First step waits until Meet finishes processing the recording (usually within 10 minutes). Falls back after 4 hours if the recording never lands. Subsequent follow-up steps still queue at their delays.</div>
                    </div>
                  </label>
                </div>
              )}
              {triggerType === 'stage_entered' && (
                <div className="p-3 bg-brand-50 border border-brand-100 rounded-[8px]">
                  <div className="text-xs">
                    <div className="font-medium text-brand-800">Fires when a candidate enters a stage</div>
                    <div className="text-brand-700 mt-0.5 leading-snug">
                      Fires after a movement rule lands the candidate in the stage you select below.
                      <strong> Both pipeline and stage are required.</strong> Only fires on pipelines with rule-based movement enabled — turn it on from the Pipelines page first.
                    </div>
                  </div>
                </div>
              )}
              {!SESSION_WIDE_TRIGGERS.has(triggerType) && (
                <div>
                  <label className="block text-sm font-medium text-grey-20 mb-1.5">Flow (optional — leave empty for all flows)</label>
                  <select value={flowId} onChange={(e) => setFlowId(e.target.value)} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500">
                    <option value="">Any flow</option>
                    {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </div>
              )}
              {(triggerType === 'training_started' || triggerType === 'training_completed') && (
                <div>
                  <label className="block text-sm font-medium text-grey-20 mb-1.5">Training (optional — leave empty for all trainings)</label>
                  <select value={triggerTrainingId} onChange={(e) => setTriggerTrainingId(e.target.value)} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500">
                    <option value="">Any training</option>
                    {trainings.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                  </select>
                  <p className="text-xs text-grey-40 mt-1">
                    Pick a specific training to fire only when that one is {triggerType === 'training_completed' ? 'completed' : 'started'}.
                    Leave on &ldquo;Any&rdquo; to fire for every training in the workspace.
                  </p>
                </div>
              )}
              {pipelines.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-grey-20 mb-1.5">
                    Pipeline <span className="font-normal text-grey-40">(which candidates this rule applies to)</span>
                  </label>
                  <select
                    value={pipelineIdField}
                    onChange={(e) => setPipelineIdField(e.target.value)}
                    className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="">Any pipeline — fires for all candidates</option>
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}{p.isDefault ? ' (default)' : ''}</option>
                    ))}
                  </select>
                  <p className="text-xs text-grey-40 mt-1">
                    Pin to a specific pipeline so e.g. a Cleaner training email doesn&apos;t fire for a Dispatcher candidate. Leave on &ldquo;Any pipeline&rdquo; to fire workspace-wide.
                  </p>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">
                  Pipeline stage <span className="font-normal text-grey-40">(where this rule lives in the journey)</span>
                </label>
                <select value={stageIdField} onChange={(e) => setStageIdField(e.target.value)} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500">
                  <option value="">Auto — match the stage that owns this trigger</option>
                  {editorStages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                <p className="text-xs text-grey-40 mt-1">
                  <b>Auto</b> — fires whenever the trigger event fires, regardless of which stage
                  the candidate is currently in. <b>A specific stage</b> — gates the rule so it
                  only fires when the candidate is in that stage; if they&apos;re elsewhere the
                  send is skipped with <code>wrong_stage</code>.
                </p>
              </div>
              {triggerType === 'automation_completed' && (
                <div>
                  <label className="block text-sm font-medium text-grey-20 mb-1.5">After which automation?</label>
                  <select value={flowId} onChange={(e) => setFlowId(e.target.value)} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500">
                    <option value="">Select automation...</option>
                    {rules.filter(r => !editing || r.id !== editing.id).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                  <p className="text-xs text-grey-40 mt-1">This automation will fire after every step of the selected automation completes.</p>
                </div>
              )}
              {triggerType === 'before_meeting' && (
                <div>
                  <label className="block text-sm font-medium text-grey-20 mb-1.5">Step 1 fires</label>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { value: 15, label: '15 min before' },
                      { value: 60, label: '1 hour before' },
                      { value: 180, label: '3 hours before' },
                      { value: 1440, label: '1 day before' },
                      { value: 2880, label: '2 days before' },
                    ].map(d => (
                      <button key={d.value} onClick={() => setMinutesBefore(d.value)} className={`px-3 py-1.5 text-xs rounded-[6px] border font-medium ${minutesBefore === d.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-35 hover:bg-surface'}`}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      type="number" min={1}
                      value={minutesBefore > 0 ? minutesBefore : ''}
                      onChange={(e) => setMinutesBefore(Math.max(1, parseInt(e.target.value) || 0))}
                      className="w-24 px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <span className="text-xs text-grey-40">minutes before scheduled start</span>
                  </div>
                  <p className="text-xs text-grey-50 mt-1.5">
                    Step 1 fires {minutesBefore >= 1440 ? `${Math.round(minutesBefore / 1440)} day${minutesBefore >= 2880 ? 's' : ''}` : minutesBefore >= 60 ? `${Math.round(minutesBefore / 60)} hour${minutesBefore >= 120 ? 's' : ''}` : `${minutesBefore} minutes`} before the meeting. Auto-cancelled on cancel/reschedule.
                  </p>
                </div>
              )}

              {/* ─── Steps editor ───────────────────────────────────────── */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-grey-20">Steps</label>
                  <span className="text-xs text-grey-40">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
                </div>
                <div className="space-y-3">
                  {steps.map((step, idx) => (
                    <StepCard
                      key={idx}
                      step={step}
                      idx={idx}
                      total={steps.length}
                      isFirst={idx === 0}
                      triggerType={triggerType}
                      templates={templates}
                      smsTemplates={smsTemplates}
                      trainings={trainings}
                      schedulingConfigs={schedulingConfigs}
                      companyEmail={companyEmail}
                      companyPhone={companyPhone}
                      previewLoading={draftPreviewLoading}
                      isEditingTemplate={templateEditorStepIdx === idx && templateEditorChannel === 'email'}
                      isEditingSmsTemplate={templateEditorStepIdx === idx && templateEditorChannel === 'sms'}
                      onChange={(patch) => updateStep(idx, patch)}
                      onRemove={() => removeStep(idx)}
                      onMoveUp={() => moveStep(idx, -1)}
                      onMoveDown={() => moveStep(idx, 1)}
                      onCompanyMissing={() => setShowCompanyEmailWarning(true)}
                      onCompanyPhoneMissing={() => setShowCompanyPhoneWarning(true)}
                      onPreview={(channelOverride) => previewDraftStep(idx, channelOverride)}
                      onCreateDefaultDirect={createDefaultTemplate}
                      onInsertTokenInTemplate={insertTokenInTemplate}
                      onInsertTokenInSmsBody={(kind) => insertTokenInSmsBody(idx, kind)}
                      onCreateTemplate={() => {
                        setTemplateEditorChannel('email')
                        setTemplateEditorStepIdx(idx)
                        setTemplateEditorEditingId(null)
                        // Seed the editor with the step's currently-assigned
                        // template so "+ New template" doubles as "duplicate &
                        // edit the one I'm already using". The "Start from"
                        // picker inside the editor lets the user re-source.
                        const current = step.emailTemplateId
                          ? templates.find((t) => t.id === step.emailTemplateId)
                          : null
                        if (current) {
                          setTemplateEditorSourceId(current.id)
                          setNewTplName(current.name)
                          setNewTplSubject(current.subject)
                          setNewTplBody(current.bodyHtml || current.bodyText || '')
                        } else {
                          setTemplateEditorSourceId(null)
                          setNewTplName(''); setNewTplSubject(''); setNewTplBody('<p>Hi {{candidate_name}},</p>\n<p></p>')
                        }
                      }}
                      onPickDefaultTemplate={(tpl) => {
                        setTemplateEditorChannel('email')
                        setTemplateEditorStepIdx(idx)
                        setTemplateEditorEditingId(null)
                        setTemplateEditorSourceId(null)
                        setNewTplName(tpl.name); setNewTplSubject(tpl.subject); setNewTplBody(tpl.bodyHtml)
                      }}
                      onEditExistingTemplate={(tpl) => {
                        setTemplateEditorChannel('email')
                        setTemplateEditorStepIdx(idx)
                        setTemplateEditorEditingId(tpl.id)
                        setTemplateEditorSourceId(tpl.id)
                        setNewTplName(tpl.name); setNewTplSubject(tpl.subject); setNewTplBody(tpl.bodyHtml)
                      }}
                      onCreateSmsTemplate={() => {
                        setTemplateEditorChannel('sms')
                        setTemplateEditorStepIdx(idx)
                        setSmsTemplateEditorEditingId(null)
                        const current = step.smsTemplateId
                          ? smsTemplates.find((t) => t.id === step.smsTemplateId)
                          : null
                        if (current) {
                          setTemplateEditorSourceId(current.id)
                          setNewTplName(current.name)
                          setNewSmsTplBody(current.body)
                        } else {
                          setTemplateEditorSourceId(null)
                          setNewTplName(''); setNewSmsTplBody('Hi {{candidate_name}}, ')
                        }
                      }}
                      onPickDefaultSmsTemplate={(tpl) => {
                        setTemplateEditorChannel('sms')
                        setTemplateEditorStepIdx(idx)
                        setSmsTemplateEditorEditingId(null)
                        setTemplateEditorSourceId(null)
                        setNewTplName(tpl.name); setNewSmsTplBody(tpl.body)
                      }}
                      onEditExistingSmsTemplate={(tpl) => {
                        setTemplateEditorChannel('sms')
                        setTemplateEditorStepIdx(idx)
                        setSmsTemplateEditorEditingId(tpl.id)
                        setTemplateEditorSourceId(tpl.id)
                        setNewTplName(tpl.name); setNewSmsTplBody(tpl.body)
                      }}
                      smsEditorSlot={templateEditorStepIdx === idx && templateEditorChannel === 'sms' ? (
                        <div ref={tplEditorRef} className="p-4 bg-surface rounded-[8px] border border-surface-border space-y-3 ring-2 ring-purple-300/60">
                          <div className="flex items-center justify-between">
                            <div className="text-xs font-medium text-grey-15">{smsTemplateEditorEditingId ? 'Edit SMS template' : 'New SMS template'}</div>
                            <button onClick={() => setTemplateEditorStepIdx(null)} className="text-xs text-grey-40 hover:text-grey-15">Cancel</button>
                          </div>
                          {smsTemplates.length > 0 && (
                            <div>
                              <label className="block text-xs text-grey-40 mb-1">Start from existing template</label>
                              <select
                                value={templateEditorSourceId ?? ''}
                                onChange={(e) => {
                                  const id = e.target.value
                                  if (!id) { setTemplateEditorSourceId(null); return }
                                  const t = smsTemplates.find((x) => x.id === id)
                                  if (!t) return
                                  setTemplateEditorSourceId(t.id)
                                  setNewTplName(t.name)
                                  setNewSmsTplBody(t.body)
                                }}
                                className="w-full px-3 py-2 border border-surface-border rounded-[6px] text-sm bg-white text-grey-15 focus:outline-none focus:ring-1 focus:ring-purple-500"
                              >
                                <option value="">— Blank template —</option>
                                {smsTemplates.map((t) => (
                                  <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                              </select>
                            </div>
                          )}
                          <div>
                            <label className="block text-xs text-grey-40 mb-1">Template Name</label>
                            <input type="text" value={newTplName} onChange={e => setNewTplName(e.target.value)} placeholder="e.g. 1-hour Reminder" className="w-full px-3 py-2 border border-surface-border rounded-[6px] text-sm text-grey-15 focus:outline-none focus:ring-1 focus:ring-purple-500" />
                            {(() => {
                              const trimmed = newTplName.trim()
                              if (!trimmed) return null
                              const conflict = smsTemplates.some((t) => t.name === trimmed)
                              if (!conflict) return null
                              const final = resolveUniqueSmsTemplateName(trimmed, smsTemplates)
                              return (
                                <p className="mt-1 text-[11px] text-purple-700">
                                  ℹ A template named &ldquo;{trimmed}&rdquo; already exists — saving as <span className="font-mono font-semibold">{final}</span>.
                                </p>
                              )
                            })()}
                          </div>
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="block text-xs text-grey-40">Body</label>
                              <span className={`text-[10px] font-mono ${newSmsTplBody.length > 320 ? 'text-amber-700' : newSmsTplBody.length > 160 ? 'text-grey-15' : 'text-grey-40'}`}>
                                {newSmsTplBody.length}c · {Math.max(1, Math.ceil(newSmsTplBody.length / 160))}s
                              </span>
                            </div>
                            <textarea value={newSmsTplBody} onChange={e => setNewSmsTplBody(e.target.value)} rows={4} className="w-full px-3 py-2 border border-surface-border rounded-[6px] text-sm text-grey-15 font-mono focus:outline-none focus:ring-1 focus:ring-purple-500" />
                          </div>
                          <div className="bg-white rounded-[6px] p-2">
                            <label className="text-[10px] font-medium text-grey-40 uppercase block mb-1">Variables</label>
                            <div className="flex flex-wrap gap-1">{['{{candidate_name}}', '{{flow_name}}', '{{training_link}}', '{{schedule_link}}', '{{meeting_link}}', '{{meeting_time}}', '{{source}}', '{{ad_name}}'].map(v => <button key={v} type="button" onClick={() => navigator.clipboard.writeText(v)} className="text-[10px] px-2 py-0.5 bg-surface border border-surface-border rounded text-grey-15 font-mono hover:bg-purple-50">{v}</button>)}</div>
                          </div>
                          {tplSaveError && (
                            <div className="px-3 py-2 rounded-[6px] bg-red-50 border border-red-200 text-xs text-red-700">
                              {tplSaveError}
                            </div>
                          )}
                          <button onClick={createSmsTemplate} disabled={savingTpl} className="w-full py-2.5 text-xs bg-purple-600 text-white rounded-[6px] hover:bg-purple-700 disabled:opacity-50 font-medium">{savingTpl ? 'Saving...' : smsTemplateEditorEditingId ? 'Update template' : 'Save template & assign to step'}</button>
                        </div>
                      ) : null}
                      editorSlot={templateEditorStepIdx === idx && templateEditorChannel === 'email' ? (
                        <div ref={tplEditorRef} className="p-4 bg-surface rounded-[8px] border border-surface-border space-y-3 ring-2 ring-brand-300/50">
                          <div className="flex items-center justify-between">
                            <div className="text-xs font-medium text-grey-15">{templateEditorEditingId ? 'Edit template' : 'New template'}</div>
                            <button onClick={() => setTemplateEditorStepIdx(null)} className="text-xs text-grey-40 hover:text-grey-15">Cancel</button>
                          </div>
                          {templates.length > 0 && (
                            <div>
                              <label className="block text-xs text-grey-40 mb-1">Start from existing template</label>
                              <select
                                value={templateEditorSourceId ?? ''}
                                onChange={(e) => {
                                  const id = e.target.value
                                  if (!id) { setTemplateEditorSourceId(null); return }
                                  const t = templates.find((x) => x.id === id)
                                  if (!t) return
                                  setTemplateEditorSourceId(t.id)
                                  setNewTplName(t.name)
                                  setNewTplSubject(t.subject)
                                  setNewTplBody(t.bodyHtml || t.bodyText || '')
                                }}
                                className="w-full px-3 py-2 border border-surface-border rounded-[6px] text-sm bg-white text-grey-15 focus:outline-none focus:ring-1 focus:ring-brand-500"
                              >
                                <option value="">— Blank template —</option>
                                {templates.map((t) => (
                                  <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                              </select>
                            </div>
                          )}
                          <div>
                            <label className="block text-xs text-grey-40 mb-1">Template Name</label>
                            <input type="text" value={newTplName} onChange={e => setNewTplName(e.target.value)} placeholder="e.g. Training Invitation" className="w-full px-3 py-2 border border-surface-border rounded-[6px] text-sm text-grey-15 focus:outline-none focus:ring-1 focus:ring-brand-500" />
                            {(() => {
                              const trimmed = newTplName.trim()
                              if (!trimmed) return null
                              const conflict = templates.some((t) => t.name === trimmed)
                              if (!conflict) return null
                              const final = resolveUniqueTemplateName(trimmed, templates)
                              return (
                                <p className="mt-1 text-[11px] text-blue-700">
                                  ℹ A template named &ldquo;{trimmed}&rdquo; already exists — this one will be saved as <span className="font-mono font-semibold">{final}</span>.
                                </p>
                              )
                            })()}
                          </div>
                          <div>
                            <label className="block text-xs text-grey-40 mb-1">Subject</label>
                            <input type="text" value={newTplSubject} onChange={e => setNewTplSubject(e.target.value)} placeholder="e.g. Next step: {{flow_name}}" className="w-full px-3 py-2 border border-surface-border rounded-[6px] text-sm text-grey-15 focus:outline-none focus:ring-1 focus:ring-brand-500" />
                          </div>
                          <div>
                            <label className="block text-xs text-grey-40 mb-1">Body</label>
                            <RichTextEditor ref={richEditorRef} value={newTplBody} onChange={setNewTplBody} rows={8} />
                          </div>
                          <div className="bg-white rounded-[6px] p-2">
                            <label className="text-[10px] font-medium text-grey-40 uppercase block mb-1">Variables</label>
                            <div className="flex flex-wrap gap-1">{['{{candidate_name}}', '{{flow_name}}', '{{training_link}}', '{{schedule_link}}', '{{meeting_link}}', '{{meeting_time}}', '{{source}}', '{{ad_name}}'].map(v => <button key={v} type="button" onClick={() => navigator.clipboard.writeText(v)} className="text-[10px] px-2 py-0.5 bg-surface border border-surface-border rounded text-grey-15 font-mono hover:bg-brand-50">{v}</button>)}</div>
                          </div>
                          {tplSaveError && (
                            <div className="px-3 py-2 rounded-[6px] bg-red-50 border border-red-200 text-xs text-red-700">
                              {tplSaveError}
                            </div>
                          )}
                          <button onClick={createTemplate} disabled={savingTpl} className="w-full py-2.5 text-xs bg-brand-500 text-white rounded-[6px] hover:bg-brand-600 disabled:opacity-50 font-medium">{savingTpl ? 'Saving...' : templateEditorEditingId ? 'Update template' : 'Save template & assign to step'}</button>
                        </div>
                      ) : null}
                    />
                  ))}
                </div>
                <button
                  onClick={addStep}
                  className="mt-3 w-full py-2.5 text-xs rounded-[8px] border border-dashed border-surface-border text-grey-35 hover:bg-surface-light hover:text-grey-15 font-medium"
                >
                  + Add follow-up step
                </button>
              </div>

            </div>
            {saveWarnings.length > 0 && (
              <div className="mt-4 px-3 py-2 rounded-[8px] bg-amber-50 border border-amber-200 text-xs text-amber-800">
                <div className="flex items-start gap-2">
                  <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                  <div className="space-y-1">
                    <div className="font-medium">This message&apos;s wording may not match its trigger:</div>
                    <ul className="list-disc list-inside space-y-1">
                      {saveWarnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                    <div className="pt-1 text-amber-700">Click <strong>Save anyway</strong> to keep this configuration, or close the modal to adjust it.</div>
                  </div>
                </div>
              </div>
            )}
            {saveError && <div className="mt-4 px-3 py-2 rounded-[8px] bg-red-50 border border-red-200 text-xs text-red-700">{saveError}</div>}
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="btn-secondary flex-1">Cancel</button>
              <button
                onClick={() => {
                  const ack = saveWarnings.length > 0
                  if (ack) setWarningsAcked(true)
                  void save({ forceAck: ack })
                }}
                disabled={saving || !name.trim()}
                className="btn-primary flex-1 disabled:opacity-50"
              >
                {saving ? 'Saving...' : saveWarnings.length > 0 ? 'Save anyway' : editing ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {testModal && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center z-[60] p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setTestModal(null); setTestResult(null) } }}
        >
          <div className="bg-white rounded-[12px] shadow-2xl p-6 w-full max-w-[460px]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-grey-15 mb-1">
              Send test {testModal.isSms ? 'SMS' : 'email'}
            </h3>
            <p className="text-sm text-grey-40 mb-4 truncate">
              For automation: <span className="text-grey-15 font-medium">{testModal.rule.name}</span>
            </p>
            <label className="block text-xs text-grey-40 mb-1.5">
              {testModal.isSms ? 'Send to (phone, E.164 e.g. +15551234567)' : 'Send to (email)'}
            </label>
            <input
              type={testModal.isSms ? 'tel' : 'email'}
              value={testRecipient}
              onChange={(e) => { setTestRecipient(e.target.value); if (testResult) setTestResult(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !testingId) submitTest() }}
              placeholder={testModal.isSms ? '+15551234567' : 'you@example.com'}
              autoFocus
              className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="text-[11px] text-grey-40 mt-1.5">
              Remembered for next time. Sending creates a tracked candidate with source = <span className="font-mono">test</span>.
            </p>
            {testResult && (
              <div className={`mt-3 px-3 py-2 rounded-[6px] text-xs border ${
                testResult.kind === 'ok'
                  ? 'bg-green-50 text-green-700 border-green-200'
                  : 'bg-red-50 text-red-700 border-red-200'
              }`}>
                {testResult.message}
              </div>
            )}
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => { setTestModal(null); setTestResult(null) }}
                className="btn-secondary flex-1"
              >
                Close
              </button>
              <button
                onClick={submitTest}
                disabled={!!testingId || !testRecipient.trim()}
                className="btn-primary flex-1 disabled:opacity-50"
              >
                {testingId === testModal.rule.id ? 'Sending…' : `Send ${testModal.isSms ? 'SMS' : 'email'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCompanyEmailWarning && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center z-[60]">
          <div className="bg-white rounded-[12px] shadow-2xl p-6 w-full max-w-[420px]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
              </div>
              <div>
                <h3 className="text-base font-semibold text-grey-15 mb-1">Company email not set up</h3>
                <p className="text-sm text-grey-35">You need to configure a company sender email before automations can send to it.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowCompanyEmailWarning(false)} className="btn-secondary flex-1">Cancel</button>
              <Link href="/dashboard/settings?tab=email" className="btn-primary flex-1 text-center">Go to Settings</Link>
            </div>
          </div>
        </div>
      )}

      {showCompanyPhoneWarning && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center z-[60]">
          <div className="bg-white rounded-[12px] shadow-2xl p-6 w-full max-w-[420px]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
              </div>
              <div>
                <h3 className="text-base font-semibold text-grey-15 mb-1">Company phone not set</h3>
                <p className="text-sm text-grey-35">Add a phone number under Settings → Workspace before SMS automations can send to your company.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowCompanyPhoneWarning(false)} className="btn-secondary flex-1">Cancel</button>
              <Link href="/dashboard/settings" className="btn-primary flex-1 text-center">Go to Settings</Link>
            </div>
          </div>
        </div>
      )}

      {executionsModal && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setExecutionsModal(null) }}
        >
          <div className="bg-white rounded-[12px] shadow-2xl w-full max-w-[720px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 pt-5 pb-3 border-b border-surface-divider flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-grey-15 truncate">Executions — {executionsModal.rule.name}</h2>
                <p className="text-xs text-grey-40 mt-0.5">
                  Every candidate this automation has run for, newest first.
                </p>
              </div>
              <button
                onClick={() => setExecutionsModal(null)}
                aria-label="Close"
                className="w-7 h-7 flex items-center justify-center rounded-md text-grey-50 hover:text-ink hover:bg-surface-light text-lg leading-none"
              >×</button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {executionsModal.loading ? (
                <div className="py-10 text-center text-sm text-grey-40">Loading…</div>
              ) : executionsModal.error ? (
                <div className="m-6 px-3 py-2 rounded-[8px] bg-red-50 text-red-700 text-sm">{executionsModal.error}</div>
              ) : executionsModal.items.length === 0 ? (
                <div className="py-10 text-center text-sm text-grey-40">No executions yet.</div>
              ) : (
                <table className="min-w-full">
                  <thead>
                    <tr className="border-b border-surface-divider bg-surface-light text-xs text-grey-40 uppercase">
                      <th className="px-4 py-2 text-left font-medium">Candidate</th>
                      <th className="px-4 py-2 text-left font-medium">Status</th>
                      <th className="px-4 py-2 text-left font-medium">Channel</th>
                      <th className="px-4 py-2 text-left font-medium">Sent / scheduled</th>
                      <th className="px-4 py-2 text-right font-medium">Step</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-divider">
                    {executionsModal.items.map((e) => {
                      const name = e.session?.candidateName
                        || e.session?.candidateEmail
                        || e.session?.candidatePhone
                        || (e.sessionId ? `Session ${e.sessionId.slice(0, 6)}…` : 'Unknown')
                      const stamp = e.sentAt ?? e.scheduledFor ?? e.createdAt
                      return (
                        <tr key={e.id} className="hover:bg-surface-light text-sm">
                          <td className="px-4 py-2.5 text-grey-15 min-w-0">
                            {e.sessionId ? (
                              <Link href={`/dashboard/candidates/${e.sessionId}`} className="hover:underline text-grey-15 hover:text-brand-600">
                                <span className="font-medium block truncate max-w-[260px]">{name}</span>
                                {e.session?.candidateEmail && (
                                  <span className="block text-[11px] text-grey-40 truncate max-w-[260px]">{e.session.candidateEmail}</span>
                                )}
                              </Link>
                            ) : (
                              <span className="text-grey-40 italic">Session deleted</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                                e.status === 'sent' ? 'bg-green-100 text-green-700'
                                  : e.status === 'failed' ? 'bg-red-100 text-red-700'
                                  : e.status === 'cancelled' ? 'bg-gray-100 text-grey-40'
                                  : e.status === 'queued' ? 'bg-amber-100 text-amber-700'
                                  : 'bg-blue-50 text-blue-700'
                              }`}
                              title={e.errorMessage ?? undefined}
                            >
                              {e.status}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-grey-35 uppercase">{e.channel}</td>
                          <td className="px-4 py-2.5 text-xs text-grey-40">
                            {stamp ? new Date(stamp).toLocaleString() : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-grey-40 text-right">
                            {e.step ? `#${e.step.order + 1}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-6 py-3 border-t border-surface-divider flex items-center justify-between text-xs text-grey-40">
              <span>
                {executionsModal.loading
                  ? ''
                  : `${executionsModal.items.length} execution${executionsModal.items.length === 1 ? '' : 's'} shown`}
              </span>
              <button onClick={() => setExecutionsModal(null)} className="text-sm px-3 py-1.5 rounded-[8px] text-grey-40 hover:text-grey-15">Close</button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

function firstStepDest(r: Rule): 'applicant' | 'company' | 'specific' {
  return (r.steps?.[0]?.emailDestination as 'applicant' | 'company' | 'specific') || (r.emailDestination as 'applicant' | 'company' | 'specific') || 'applicant'
}

/**
 * One step in the rule's sequence. Mirrors the per-rule modal that existed
 * pre-step refactor: channel toggle, body fields, destination, next-step
 * config. Step 0's delay is editable for all triggers except `before_meeting`,
 * where step 0 is anchored to the rule's `minutesBefore` setting.
 */
function StepCard(props: {
  step: StepShape
  idx: number
  total: number
  isFirst: boolean
  triggerType: string
  templates: Template[]
  smsTemplates: SmsTemplateItem[]
  trainings: TrainingItem[]
  schedulingConfigs: SchedulingItem[]
  companyEmail: string | null
  companyPhone: string | null
  previewLoading: boolean
  onChange: (patch: Partial<StepShape>) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onCompanyMissing: () => void
  onCompanyPhoneMissing: () => void
  onPreview: (channel?: 'email' | 'sms') => void
  onCreateDefaultDirect: (tpl: { name: string; subject: string; bodyHtml: string }) => Promise<string | null>
  onInsertTokenInTemplate: (templateId: string, kind: 'training' | 'scheduling' | 'meet_link' | 'background_check', label: string) => Promise<boolean>
  onInsertTokenInSmsBody: (kind: 'training' | 'scheduling' | 'meet_link' | 'background_check') => void
  onCreateTemplate: () => void
  onPickDefaultTemplate: (tpl: { name: string; subject: string; bodyHtml: string }) => void
  // Edit-in-place: opens the inline editor pointed at an existing template
  // so Save patches that row rather than creating a new one. Separate from
  // onPickDefaultTemplate, which always implies "new template".
  onEditExistingTemplate: (tpl: { id: string; name: string; subject: string; bodyHtml: string }) => void
  onCreateSmsTemplate: () => void
  onPickDefaultSmsTemplate: (tpl: { name: string; body: string }) => void
  onEditExistingSmsTemplate: (tpl: { id: string; name: string; body: string }) => void
  isEditingTemplate: boolean
  isEditingSmsTemplate: boolean
  editorSlot: React.ReactNode
  smsEditorSlot: React.ReactNode
}) {
  const { step, idx, total, isFirst, triggerType, templates, smsTemplates, trainings, schedulingConfigs, companyEmail, companyPhone } = props
  const wantsEmail = step.channel === 'email' || step.channel === 'both'
  const wantsSms = step.channel === 'sms' || step.channel === 'both'
  const delayLocked = isFirst && triggerType === 'before_meeting'
  const canPreviewEmail = wantsEmail && !!step.emailTemplateId
  // An SMS step is previewable if it has either a saved-template id or an
  // inline body — mirrors the executor's resolution rule.
  const canPreviewSms = wantsSms && (!!step.smsTemplateId || (!!step.smsBody && step.smsBody.trim().length > 0))

  return (
    <div className="border border-surface-border rounded-[10px] p-4 bg-white">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-brand-50 text-brand-700 text-xs font-semibold">{idx + 1}</span>
          <span className="text-sm font-medium text-grey-15">{isFirst ? 'First step' : 'Follow-up'}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={props.onMoveUp} disabled={idx === 0} className="text-xs px-2 py-1 rounded text-grey-40 hover:text-grey-15 disabled:opacity-30" title="Move up">↑</button>
          <button onClick={props.onMoveDown} disabled={idx === total - 1} className="text-xs px-2 py-1 rounded text-grey-40 hover:text-grey-15 disabled:opacity-30" title="Move down">↓</button>
          {total > 1 && <button onClick={props.onRemove} className="text-xs px-2 py-1 rounded text-red-500 hover:text-red-700" title="Remove step">×</button>}
        </div>
      </div>

      <div className="space-y-3">
        {/* Channel */}
        <div>
          <label className="block text-xs font-medium text-grey-20 mb-1.5">Channel</label>
          <div className="flex gap-2">
            {[
              { v: 'email' as const, l: 'Email' },
              { v: 'sms' as const, l: 'SMS' },
              { v: 'both' as const, l: 'Email + SMS' },
            ].map(({ v, l }) => (
              <button
                key={v}
                onClick={() => {
                  // When the user switches to a channel that requires an SMS
                  // body, prefill it with a trigger-appropriate default if
                  // empty — the textarea's placeholder isn't real content.
                  const wantsSmsNow = v === 'sms' || v === 'both'
                  const smsEmpty = !step.smsBody || step.smsBody.trim().length === 0
                  if (wantsSmsNow && smsEmpty) {
                    props.onChange({ channel: v, smsBody: pickDefaultSmsBody(triggerType) })
                  } else {
                    props.onChange({ channel: v })
                  }
                }}
                className={`flex-1 py-2 text-xs rounded-[8px] border font-medium ${step.channel === v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-35'}`}
              >
                {l}
              </button>
            ))}
          </div>
          {step.channel === 'both' && (
            <p className="text-[11px] text-grey-40 mt-1.5">
              Sends both an email and an SMS at the same time. The candidate needs both an email and a phone number.
            </p>
          )}
        </div>

        {/* Delay + timing mode */}
        {!delayLocked && (() => {
          const isMeetingTrigger = MEETING_TRIGGERS.has(triggerType)
          const mode = step.timingMode || 'trigger'
          const delayLabel = mode === 'before_meeting' ? 'Minutes before meeting'
            : mode === 'after_meeting' ? 'Minutes after meeting'
            : 'Delay after trigger'
          const fireDescription = mode === 'before_meeting'
            ? `Fires ${formatDelay(step.delayMinutes)} BEFORE the candidate's scheduled meeting time.`
            : mode === 'after_meeting'
              ? `Fires ${formatDelay(step.delayMinutes)} AFTER the candidate's scheduled meeting time.`
              : `Fires ${formatDelay(step.delayMinutes)} after the trigger event.`
          return (
          <div>
            {/* Timing-mode picker — only meaningful when the trigger is meeting-related.
                Hidden on follow-ups: they inherit the mode from the first step,
                because mixing "before meeting" and "after trigger" within one rule
                would be incoherent for a recruiter to reason about. */}
            {isMeetingTrigger && isFirst && (
              <div className="mb-2">
                <label className="block text-xs font-medium text-grey-20 mb-1.5">When to fire</label>
                <div className="flex gap-2">
                  {[
                    { v: 'trigger' as const, l: 'After trigger' },
                    { v: 'before_meeting' as const, l: 'Before meeting' },
                    { v: 'after_meeting' as const, l: 'After meeting' },
                  ].map(({ v, l }) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => props.onChange({ timingMode: v })}
                      className={`flex-1 py-1.5 text-xs rounded-[8px] border font-medium ${mode === v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-35'}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <label className="block text-xs font-medium text-grey-20 mb-1.5">{delayLabel}</label>
            <div className="flex flex-wrap gap-1.5">
              {DELAY_PRESETS.map(d => (
                <button key={d.value} onClick={() => props.onChange({ delayMinutes: d.value })} className={`px-3 py-1.5 text-xs rounded-[6px] border font-medium ${step.delayMinutes === d.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-35 hover:bg-surface'}`}>
                  {d.label}
                </button>
              ))}
            </div>
            {!DELAY_PRESETS.some((d) => d.value === step.delayMinutes) && (
              <div className="flex items-center gap-2 mt-2">
                <input
                  type="number" min={0}
                  value={step.delayMinutes}
                  onChange={(e) => props.onChange({ delayMinutes: Math.max(0, parseInt(e.target.value) || 0) })}
                  className="w-24 px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <span className="text-xs text-grey-40">minutes</span>
              </div>
            )}
            {step.delayMinutes > 0 && <p className="text-xs text-grey-50 mt-1">{fireDescription}</p>}
          </div>
          )
        })()}
        {delayLocked && (
          <p className="text-xs text-grey-50">Step 1 of a before_meeting rule fires at the rule&apos;s &quot;X minutes before meeting&quot; setting (above).</p>
        )}

        {/* Email block */}
        {wantsEmail && (
          <div className="p-3 rounded-[8px] bg-blue-50/40 border border-blue-100 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold text-blue-700 uppercase tracking-wide">Email</div>
              <button
                type="button"
                onClick={() => props.onPreview('email')}
                disabled={!canPreviewEmail || props.previewLoading}
                className="text-[11px] text-blue-700 hover:text-blue-900 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                title={!canPreviewEmail ? 'Pick a template first' : 'Preview rendered email'}
              >
                {props.previewLoading ? 'Loading…' : 'Preview email'}
              </button>
            </div>
            {props.isEditingTemplate ? (
              props.editorSlot
            ) : (
            <div>
              <label className="block text-xs text-grey-40 mb-1">Template</label>
              <select
                value={step.emailTemplateId || ''}
                onChange={async (e) => {
                  const value = e.target.value
                  // "default:<name>" → open the inline template editor with
                  // the default's content prefilled. The recruiter can edit
                  // before saving; the editor auto-suffixes the name if it
                  // collides with an existing workspace template.
                  if (value.startsWith('default:')) {
                    const name = value.slice('default:'.length)
                    const defTpl = DEFAULT_EMAIL_TEMPLATES.find((t) => t.name === name)
                    if (!defTpl) return
                    props.onPickDefaultTemplate(defTpl)
                    return
                  }
                  const id = value || null
                  // Auto-pick the matching "Includes link to" option from the
                  // template's tokens, but only when the recruiter hasn't set
                  // one explicitly. Manual selection always wins.
                  const newTpl = id ? templates.find((t) => t.id === id) : null
                  const detected = newTpl
                    ? detectLinkType([newTpl.subject || '', newTpl.bodyHtml || '', newTpl.bodyText || '', step.smsBody || ''].join(' '))
                    : null
                  props.onChange({
                    emailTemplateId: id,
                    ...(detected && !step.nextStepType ? { nextStepType: detected } : {}),
                  })
                }}
                className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Select template...</option>
                {templates.length > 0 && (
                  <optgroup label="Saved templates">
                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </optgroup>
                )}
                {(() => {
                  const missing = DEFAULT_EMAIL_TEMPLATES.filter((d) => !templates.some((t) => t.name === d.name))
                  if (missing.length === 0) return null
                  return (
                    <optgroup label="Add a default (one-click)">
                      {missing.map((tpl) => (
                        <option key={tpl.name} value={`default:${tpl.name}`}>{tpl.name}</option>
                      ))}
                    </optgroup>
                  )
                })()}
              </select>
              {/* Inline preview of the selected template — subject line + first
                  ~140 chars of plain-text body. Lets the recruiter see exactly
                  what'll be sent without opening the full Preview modal. */}
              {(() => {
                const sel = templates.find((t) => t.id === step.emailTemplateId)
                if (!sel) return null
                const bodyText = (sel.bodyHtml || '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                return (
                  <div className="mt-2 p-2.5 bg-white border border-surface-border rounded-[6px] text-[11px] space-y-1">
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 space-y-1 min-w-0">
                        <div className="flex gap-2"><span className="text-grey-40 w-12 flex-shrink-0">Subject</span><span className="text-grey-15 font-medium truncate">{sel.subject}</span></div>
                        {bodyText && <div className="flex gap-2"><span className="text-grey-40 w-12 flex-shrink-0">Body</span><span className="text-grey-35 line-clamp-2">{bodyText.slice(0, 200)}{bodyText.length > 200 ? '…' : ''}</span></div>}
                      </div>
                      <button
                        type="button"
                        onClick={() => props.onEditExistingTemplate({ id: sel.id, name: sel.name, subject: sel.subject, bodyHtml: sel.bodyHtml || '' })}
                        className="text-[11px] text-brand-600 hover:text-brand-700 font-medium whitespace-nowrap flex-shrink-0"
                        title={`Edit "${sel.name}" in place — every rule that uses this template will see the update`}
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                )
              })()}
              <div className="flex flex-wrap gap-1 mt-1.5">
                <button onClick={props.onCreateTemplate} className="text-[11px] text-brand-600 hover:text-brand-700 font-medium">+ New template…</button>
                <span className="text-[11px] text-grey-40">or pick a default:</span>
                {DEFAULT_EMAIL_TEMPLATES.slice(0, 4).map((tpl, i) => (
                  <button
                    key={i}
                    onClick={() => props.onPickDefaultTemplate(tpl)}
                    className="text-[11px] text-grey-35 hover:text-brand-600 underline-offset-2 hover:underline"
                  >
                    {tpl.name}
                  </button>
                ))}
              </div>
            </div>
            )}
            <div>
              <label className="block text-xs text-grey-40 mb-1">Send to</label>
              <div className="flex gap-2">
                {([
                  { v: 'applicant' as const, l: 'Applicant' },
                  { v: 'company' as const, l: 'Company' },
                  { v: 'specific' as const, l: 'Specific' },
                ]).map(({ v, l }) => (
                  <button
                    key={v}
                    onClick={() => {
                      if (v === 'company' && !companyEmail) { props.onCompanyMissing(); return }
                      props.onChange({ emailDestination: v })
                    }}
                    className={`flex-1 py-1.5 text-xs rounded-[8px] border font-medium ${step.emailDestination === v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-35'}`}
                  >
                    {l}
                  </button>
                ))}
              </div>
              {step.emailDestination === 'specific' && (
                <input
                  type="email"
                  value={step.emailDestinationAddress || ''}
                  onChange={(e) => props.onChange({ emailDestinationAddress: e.target.value })}
                  placeholder="recipient@example.com"
                  className="mt-2 w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              )}
              {step.emailDestination === 'company' && companyEmail && (
                <p className="text-[11px] text-grey-40 mt-1">Will send to <span className="font-medium text-grey-20">{companyEmail}</span>.</p>
              )}
            </div>
          </div>
        )}

        {/* SMS block */}
        {wantsSms && (
          <div className="p-3 rounded-[8px] bg-purple-50/40 border border-purple-100 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold text-purple-700 uppercase tracking-wide">SMS</div>
              <button
                type="button"
                onClick={() => props.onPreview('sms')}
                disabled={!canPreviewSms || props.previewLoading}
                className="text-[11px] text-purple-700 hover:text-purple-900 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                title={!canPreviewSms ? 'Pick a template or type a body first' : 'Preview rendered SMS'}
              >
                {props.previewLoading ? 'Loading…' : 'Preview SMS'}
              </button>
            </div>
            {/* Template picker — mirrors the email template dropdown.
                When the inline editor is open for this step, swap the
                dropdown for the editor (props.smsEditorSlot). Otherwise
                show the dropdown, defaults, "+ New template" link, and the
                manage-templates shortcut. Selecting a saved template OR a
                default populates the textarea below; editing the textarea
                detaches the smsTemplateId so the inline edit is what sends. */}
            {props.isEditingSmsTemplate ? (
              props.smsEditorSlot
            ) : (
            <div>
              <label className="block text-xs text-grey-40 mb-1">Template</label>
              <select
                value={step.smsTemplateId || ''}
                onChange={(e) => {
                  const value = e.target.value
                  // "default:<name>" → open the inline editor seeded with
                  // the picked default. Matches the email flow exactly.
                  if (value.startsWith('default:')) {
                    const name = value.slice('default:'.length)
                    const defTpl = DEFAULT_SMS_TEMPLATES.find((t) => t.name === name)
                    if (!defTpl) return
                    props.onPickDefaultSmsTemplate(defTpl)
                    return
                  }
                  const id = value || null
                  if (!id) { props.onChange({ smsTemplateId: null }); return }
                  const picked = smsTemplates.find((t) => t.id === id)
                  if (!picked) { props.onChange({ smsTemplateId: id }); return }
                  const detected = detectLinkType(picked.body)
                  props.onChange({
                    smsTemplateId: id,
                    smsBody: picked.body,
                    ...(detected && !step.nextStepType ? { nextStepType: detected } : {}),
                  })
                }}
                className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value="">{smsTemplates.length === 0 ? 'No saved templates — type a body below' : 'Inline body (no saved template)'}</option>
                {smsTemplates.length > 0 && (
                  <optgroup label="Saved templates">
                    {smsTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </optgroup>
                )}
                {(() => {
                  // Surface defaults whose names aren't already taken by a
                  // saved template, so the dropdown stays useful even before
                  // the recruiter has saved anything.
                  const missing = DEFAULT_SMS_TEMPLATES.filter((d) => !smsTemplates.some((t) => t.name === d.name))
                  if (missing.length === 0) return null
                  return (
                    <optgroup label="Add a default (one-click)">
                      {missing.map((tpl) => (
                        <option key={tpl.name} value={`default:${tpl.name}`}>{tpl.name}</option>
                      ))}
                    </optgroup>
                  )
                })()}
              </select>
              {/* Inline preview of the selected template — like email has.
                  Lets the recruiter eyeball the saved body without scrolling
                  down to the textarea, and "Edit" copies it into the inline
                  editor so they can save a variant. */}
              {(() => {
                const sel = smsTemplates.find((t) => t.id === step.smsTemplateId)
                if (!sel) return null
                return (
                  <div className="mt-2 p-2.5 bg-white border border-surface-border rounded-[6px] text-[11px] space-y-1">
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-grey-35 line-clamp-2 whitespace-pre-wrap">{sel.body}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => props.onEditExistingSmsTemplate({ id: sel.id, name: sel.name, body: sel.body })}
                        className="text-[11px] text-purple-700 hover:text-purple-900 font-medium whitespace-nowrap flex-shrink-0"
                        title={`Edit "${sel.name}" in place — every rule that uses this template will see the update`}
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                )
              })()}
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                <button type="button" onClick={props.onCreateSmsTemplate} className="text-[11px] text-purple-700 hover:text-purple-900 font-medium">+ New template…</button>
                <span className="text-[11px] text-grey-40">or pick a default:</span>
                {DEFAULT_SMS_TEMPLATES.slice(0, 4).map((tpl, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => props.onPickDefaultSmsTemplate(tpl)}
                    className="text-[11px] text-grey-35 hover:text-purple-700 underline-offset-2 hover:underline"
                  >
                    {tpl.name}
                  </button>
                ))}
                <a
                  href="/dashboard/automations/templates?tab=sms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto text-[11px] text-purple-700 hover:text-purple-900 font-medium"
                >Manage →</a>
              </div>
              {step.smsTemplateId && (
                <p className="mt-1 text-[11px] text-grey-40">Editing the body below will detach the template.</p>
              )}
            </div>
            )}
            <textarea
              value={step.smsBody || ''}
              onChange={(e) => {
                const body = e.target.value
                const detected = detectLinkType(body)
                // If the user is editing away from a saved template's body,
                // detach the template so the rule sends the inline edit.
                const linkedTpl = step.smsTemplateId ? smsTemplates.find((t) => t.id === step.smsTemplateId) : null
                const detach = linkedTpl ? linkedTpl.body !== body : false
                props.onChange({
                  smsBody: body,
                  ...(detach ? { smsTemplateId: null } : {}),
                  ...(detected && !step.nextStepType ? { nextStepType: detected } : {}),
                })
              }}
              rows={3}
              placeholder="Hi {{candidate_name}}, your interview starts at {{meeting_time}}. Join: {{meeting_link}}"
              className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono"
            />
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-grey-40">
                Tokens: <code>{'{{candidate_name}}'}</code>, <code>{'{{meeting_time}}'}</code>, <code>{'{{meeting_link}}'}</code>, <code>{'{{schedule_link}}'}</code>.
              </p>
              <span className={`text-[11px] font-mono ${(step.smsBody?.length ?? 0) > 320 ? 'text-amber-700' : (step.smsBody?.length ?? 0) > 160 ? 'text-grey-15' : 'text-grey-40'}`}>
                {step.smsBody?.length ?? 0} chars · {Math.max(1, Math.ceil((step.smsBody?.length ?? 0) / 160))} seg
              </span>
            </div>
            {(() => {
              const hasReplyLine = /reply\s+yes/i.test(step.smsBody || '')
              return (
                <div className="flex items-start gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => {
                      const cur = (step.smsBody || '').trimEnd()
                      const tail = 'Reply YES to confirm or NO to cancel.'
                      const next = cur ? `${cur}\n\n${tail}` : tail
                      props.onChange({ smsBody: next })
                    }}
                    disabled={hasReplyLine}
                    className="px-2 py-1 rounded-[6px] border border-purple-200 bg-purple-50 text-purple-700 font-medium hover:bg-purple-100 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                    title={hasReplyLine ? 'Reply line already in body' : 'Append "Reply YES to confirm or NO to cancel." to the SMS body'}
                  >
                    {hasReplyLine ? '✓ Reply line added' : '+ Insert YES/NO reply line'}
                  </button>
                  <p className="text-grey-40 leading-snug">
                    Appends a confirm/cancel hint. When the candidate replies YES, their interview is marked confirmed; NO / CANCEL deletes the calendar event and moves them to Rejected.
                  </p>
                </div>
              )
            })()}
            <div>
              <label className="block text-xs text-grey-40 mb-1">Send to</label>
              <div className="flex gap-2">
                {([
                  { v: 'applicant' as const, l: 'Applicant' },
                  { v: 'company' as const, l: 'Company' },
                  { v: 'specific' as const, l: 'Specific' },
                ]).map(({ v, l }) => (
                  <button
                    key={v}
                    onClick={() => {
                      if (v === 'company' && !companyPhone) { props.onCompanyPhoneMissing(); return }
                      props.onChange({ smsDestination: v })
                    }}
                    className={`flex-1 py-1.5 text-xs rounded-[8px] border font-medium ${step.smsDestination === v ? 'border-purple-500 bg-purple-50 text-purple-700' : 'border-surface-border text-grey-35'}`}
                  >
                    {l}
                  </button>
                ))}
              </div>
              {step.smsDestination === 'specific' && (
                <input
                  type="tel"
                  value={step.smsDestinationNumber || ''}
                  onChange={(e) => props.onChange({ smsDestinationNumber: e.target.value })}
                  placeholder="+15551234567"
                  className="mt-2 w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              )}
              {step.smsDestination === 'company' && companyPhone && (
                <p className="text-[11px] text-grey-40 mt-1">Will send to <span className="font-medium text-grey-20">{companyPhone}</span>.</p>
              )}
            </div>
          </div>
        )}

        {/* Next-step config */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs font-medium text-grey-20">Includes link to</label>
            {(() => {
              if (!step.nextStepType || step.nextStepType === '') return null
              const tokenMap: Record<string, string> = {
                training: '{{training_link}}',
                scheduling: '{{schedule_link}}',
                meet_link: '{{meeting_link}}',
                background_check: '{{certn_link}}',
              }
              const expectedToken = tokenMap[step.nextStepType]
              if (!expectedToken) return null
              const tpl = step.emailTemplateId ? templates.find((t) => t.id === step.emailTemplateId) : null
              const labelMap: Record<string, string> = {
                training:   step.training?.title || trainings.find((t) => t.id === step.trainingId)?.title || 'Continue',
                scheduling: step.schedulingConfig?.name || schedulingConfigs.find((s) => s.id === step.schedulingConfigId)?.name || 'Book interview',
                meet_link:  'Join interview',
                background_check: 'Start background check',
              }
              const ctaLabel = labelMap[step.nextStepType] || 'Continue'
              const emailHasToken = !wantsEmail || (tpl && (tpl.bodyHtml || '').includes(expectedToken))
              const smsHasToken = !wantsSms || (step.smsBody || '').includes(expectedToken)
              const emailNeedsInsert = wantsEmail && tpl && !(tpl.bodyHtml || '').includes(expectedToken)
              const smsNeedsInsert = wantsSms && !(step.smsBody || '').includes(expectedToken)
              // Already present everywhere it's needed — show a positive indicator
              // so the recruiter knows the link is in place (and explains why
              // there's no Insert button to click).
              if (!emailNeedsInsert && !smsNeedsInsert && (emailHasToken || smsHasToken)) {
                return (
                  <span
                    className="text-[11px] px-2.5 py-1 rounded-[6px] bg-green-50 text-green-700 border border-green-200 font-medium whitespace-nowrap"
                    title={`${expectedToken} is already in the ${wantsEmail && wantsSms ? 'template & SMS body' : wantsEmail ? 'template' : 'SMS body'}`}
                  >
                    ✓ Link in {wantsEmail && wantsSms ? 'template & SMS' : wantsEmail ? 'template' : 'SMS'}
                  </span>
                )
              }
              if (!emailNeedsInsert && !smsNeedsInsert) return null
              return (
                <button
                  type="button"
                  onClick={async () => {
                    if (emailNeedsInsert && tpl) {
                      await props.onInsertTokenInTemplate(tpl.id, step.nextStepType as 'training' | 'scheduling' | 'meet_link' | 'background_check', ctaLabel)
                    }
                    if (smsNeedsInsert) {
                      props.onInsertTokenInSmsBody(step.nextStepType as 'training' | 'scheduling' | 'meet_link' | 'background_check')
                    }
                  }}
                  className="text-[11px] px-2.5 py-1 rounded-[6px] bg-brand-50 text-brand-700 hover:bg-brand-100 border border-brand-200 font-medium whitespace-nowrap"
                  title={emailNeedsInsert && smsNeedsInsert
                    ? `Insert ${expectedToken} into the template & SMS body`
                    : emailNeedsInsert
                      ? `Insert ${expectedToken} into "${tpl?.name}"`
                      : `Insert ${expectedToken} into the SMS body`}
                >
                  + Insert {expectedToken}
                </button>
              )
            })()}
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { v: '', l: 'Nothing' },
              { v: 'training', l: 'Training' },
              { v: 'scheduling', l: 'Scheduling' },
              { v: 'meet_link', l: 'Google Meet' },
              { v: 'background_check', l: 'Background Check' },
            ].map(({ v, l }) => {
              const detected = detectStepLinkType(step, templates)
              const isSelected = (step.nextStepType || '') === v
              const isDetected = !step.nextStepType && v && detected === v
              return (
                <button
                  key={v || 'none'}
                  onClick={() => props.onChange({ nextStepType: v || null })}
                  className={`flex-1 py-1.5 text-xs rounded-[8px] border font-medium ${
                    isSelected ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : isDetected ? 'border-brand-300 bg-brand-50/40 text-brand-700'
                      : 'border-surface-border text-grey-35'
                  }`}
                  title={isDetected ? 'Auto-detected from template content' : undefined}
                >
                  {l}{isDetected ? ' ✦' : ''}
                </button>
              )
            })}
          </div>
          {(() => {
            const detected = detectStepLinkType(step, templates)
            if (!step.nextStepType && detected) {
              const detectedToken = detected === 'meet_link' ? '{{meeting_link}}'
                : detected === 'training' ? '{{training_link}}'
                : detected === 'background_check' ? '{{certn_link}}'
                : '{{schedule_link}}'
              return <p className="text-[11px] text-brand-700/80 mt-1.5">✦ Detected <code>{detectedToken}</code> in the template — click to confirm.</p>
            }
            // Mismatch warning: picker is set but the actual template/SMS body
            // doesn't use the corresponding merge token, so the link won't
            // appear in the rendered message.
            if (step.nextStepType) {
              const tokenMap: Record<string, string> = {
                training: '{{training_link}}',
                scheduling: '{{schedule_link}}',
                meet_link: '{{meeting_link}}',
                background_check: '{{certn_link}}',
              }
              const expectedToken = tokenMap[step.nextStepType]
              if (!expectedToken) return null
              const tpl = step.emailTemplateId ? templates.find((t) => t.id === step.emailTemplateId) : null
              const haystack = [tpl?.subject || '', tpl?.bodyHtml || '', tpl?.bodyText || '', step.smsBody || ''].join(' ')
              if (haystack && !haystack.includes(expectedToken)) {
                return (
                  <div className="mt-2 px-2.5 py-2 rounded-[6px] bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                    ⚠ The selected {wantsEmail && wantsSms ? 'template / SMS body' : wantsEmail ? 'template' : 'SMS body'} doesn&apos;t include <code className="bg-white px-1 rounded">{expectedToken}</code> — the link won&apos;t appear in the rendered message. Add <code className="bg-white px-1 rounded">{expectedToken}</code> to your {wantsEmail ? 'template body' : 'SMS body'} where you want the link to appear.
                  </div>
                )
              }
            }
            return null
          })()}
          {step.nextStepType === 'training' && (
            <div className="mt-2">
              <select value={step.trainingId || ''} onChange={(e) => props.onChange({ trainingId: e.target.value || null })} className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                <option value="">Select training...</option>
                {trainings.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
              <p className="text-[11px] text-grey-40 mt-1">A unique access token is generated per candidate. {'{{training_link}}'} renders the personalized URL.</p>
            </div>
          )}
          {step.nextStepType === 'scheduling' && (
            <div className="mt-2">
              <select value={step.schedulingConfigId || ''} onChange={(e) => props.onChange({ schedulingConfigId: e.target.value || null })} className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                <option value="">Use default link</option>
                {schedulingConfigs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <p className="text-[11px] text-grey-40 mt-1">{'{{schedule_link}}'} renders the tracked redirect URL. Candidate moves to &quot;invited to schedule&quot; when this step succeeds.</p>
            </div>
          )}
          {step.nextStepType === 'meet_link' && (
            <p className="text-[11px] text-grey-40 mt-2">
              {'{{meeting_link}}'} renders the candidate&apos;s scheduled Meet URL — populated automatically from the InterviewMeeting row when the meeting is created (in-app scheduler or Calendly adoption). No additional configuration needed.
            </p>
          )}
          {step.nextStepType === 'background_check' && (
            <p className="text-[11px] text-grey-40 mt-2">
              {'{{certn_link}}'} orders a Certn case for the candidate when this step runs and renders the personalized invite URL. Configure your API key, region, and default check types in <a href="/dashboard/settings?tab=integrations" className="text-brand-500 hover:text-brand-600 underline">Settings → Integrations</a>. The check completes asynchronously (1–2 days) and fires the Background Check Passed/Failed/Needs Review triggers.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Pipeline view, stage-driven. Pills mirror the workspace's funnel stages
 * (the kanban is the source of truth) and counts are derived by mapping
 * rule.triggerType against each stage's StageTrigger events. An extra
 * "Unassigned" pill collects rules whose triggerType isn't claimed by any
 * stage — without it those rules would silently disappear from this view.
 *
 * Two rows: Applicant journey (rules whose first step targets the applicant)
 * and Company notifications (everything else). Both rows share the same
 * stage skeleton so the structure stays consistent.
 */
function AutomationPipeline({
  rules,
  stages,
  activeStageId,
  onPickStage,
}: {
  rules: Rule[]
  stages: FunnelStage[]
  activeStageId: string | null
  onPickStage: (stageIdOrUnassigned: string) => void
}) {
  // Pre-compute event-set per stage and the union of all claimed events so we
  // can decide which rules land in the "Unassigned" bucket.
  const stageEvents = useMemo(() => stages.map((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    events: new Set((s.triggers ?? []).map((t) => t.event)),
    triggerCount: s.triggers?.length ?? 0,
  })), [stages])

  // Count rules per stage. Explicit r.stageId wins (the rule lives at that
  // stage even if its triggerType points elsewhere). Otherwise we fall back
  // to the implicit triggerType→trigger-event match. Rules that resolve to
  // no stage at all land in __unassigned so they remain visible.
  const counts = useMemo(() => {
    const m = new Map<string, { applicant: number; company: number }>()
    for (const s of stageEvents) m.set(s.id, { applicant: 0, company: 0 })
    m.set('__unassigned', { applicant: 0, company: 0 })
    const stageIds = new Set(stageEvents.map((s) => s.id))
    for (const r of rules) {
      const dest = firstStepDest(r) === 'applicant' ? 'applicant' : 'company'
      if (r.stageId && stageIds.has(r.stageId)) {
        m.get(r.stageId)![dest] += 1
        continue
      }
      let matched = false
      for (const s of stageEvents) {
        if (s.events.has(r.triggerType as never)) {
          m.get(s.id)![dest] += 1
          matched = true
        }
      }
      if (!matched) m.get('__unassigned')![dest] += 1
    }
    return m
  }, [rules, stageEvents])

  const unassignedTotal = (counts.get('__unassigned')?.applicant ?? 0)
                       + (counts.get('__unassigned')?.company ?? 0)
  const showUnassigned = unassignedTotal > 0

  const row = (dest: 'applicant' | 'company', title: string, subtitle: string) => {
    let total = 0
    for (const s of stageEvents) total += counts.get(s.id)?.[dest] ?? 0
    total += counts.get('__unassigned')?.[dest] ?? 0
    return (
      <div className="bg-white rounded-[12px] border border-surface-border p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-xs font-semibold text-grey-15 uppercase tracking-wide">{title}</div>
            <div className="text-xs text-grey-40 mt-0.5">{subtitle}</div>
          </div>
          <span className="text-xs text-grey-40">{total} rule{total === 1 ? '' : 's'}</span>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {stageEvents.map((s, i) => {
            const count = counts.get(s.id)?.[dest] ?? 0
            const isActive = activeStageId === s.id
            const empty = count === 0
            const noTriggers = s.triggerCount === 0
            return (
              <div key={s.id} className="flex items-center shrink-0">
                <button
                  onClick={() => onPickStage(s.id)}
                  title={noTriggers ? 'No triggers configured for this stage. Edit in Stages settings.' : `Filter to rules attached to ${s.label}`}
                  className={`px-3 py-2 rounded-[8px] border text-xs font-medium whitespace-nowrap transition-all inline-flex items-center gap-2 ${
                    isActive
                      ? 'border-brand-500 bg-brand-50 text-brand-700 ring-2 ring-brand-200'
                      : empty
                        ? 'border-dashed border-surface-border text-grey-40 bg-white hover:border-grey-25'
                        : 'border-surface-border bg-white text-grey-15 hover:ring-1 hover:ring-grey-25'
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.color }} />
                  <span>{s.label}</span>
                  <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[10px] font-bold ${
                    empty ? 'bg-gray-100 text-grey-40' : 'bg-brand-100 text-brand-700'
                  }`}>
                    {count}
                  </span>
                </button>
                {i < stageEvents.length - 1 && (
                  <svg className="w-3 h-3 text-grey-40 shrink-0" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                    <path d="M4 2l4 4-4 4V2z" />
                  </svg>
                )}
              </div>
            )
          })}
          {showUnassigned && (() => {
            const count = counts.get('__unassigned')?.[dest] ?? 0
            if (count === 0) return null
            const isActive = activeStageId === '__unassigned'
            return (
              <div className="flex items-center shrink-0 ml-2 pl-2 border-l border-surface-divider">
                <button
                  onClick={() => onPickStage('__unassigned')}
                  title="Rules whose trigger isn't attached to any stage. Add the trigger to a stage in Stages settings to surface them on the pipeline."
                  className={`px-3 py-2 rounded-[8px] border text-xs font-medium whitespace-nowrap transition-all inline-flex items-center gap-2 ${
                    isActive
                      ? 'border-amber-500 bg-amber-50 text-amber-700 ring-2 ring-amber-200'
                      : 'border-dashed border-amber-300 text-amber-700 bg-amber-50 hover:ring-1 hover:ring-amber-300'
                  }`}
                >
                  <span>Unassigned</span>
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">
                    {count}
                  </span>
                </button>
              </div>
            )
          })()}
        </div>
      </div>
    )
  }

  return (
    <div className="mb-6 space-y-3">
      {row('applicant', 'Applicant journey', 'Messages sent to the candidate as they move through the pipeline')}
      {row('company', 'Company notifications', 'Notifications sent to your team or a specific inbox')}
    </div>
  )
}
