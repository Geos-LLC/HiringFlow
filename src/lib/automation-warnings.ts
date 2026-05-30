/**
 * Soft "are you sure?" guard surfaced in the automation editor's save flow.
 *
 * Targets a class of recruiter mistakes where the trigger and the message
 * body disagree about what event just happened — typically because the
 * recruiter cloned an old rule, edited the body, but left the trigger
 * pointing at the wrong lifecycle event. The Test George incident
 * (2026-05-11) is the seed case: a `before_meeting` reminder whose SMS
 * body told the candidate the meeting had been rescheduled, so every
 * candidate received a "rescheduled" SMS 5 min before every interview.
 *
 * These warnings are advisory, not blocking. The editor renders them
 * inline and the user can choose Save anyway — there are legitimate
 * cases the heuristics will false-positive on (e.g. a `before_meeting`
 * rule whose body discusses an earlier reschedule by design).
 *
 * Pattern matching is purely lexical against the SMS body and email
 * template subject. We don't fetch email template bodies here because
 * the editor doesn't have them on the client; covering subjects catches
 * the most common slip (cloned rules keep the old subject line).
 */

export type WarnableTriggerType =
  | 'meeting_scheduled'
  | 'meeting_rescheduled'
  | 'before_meeting'
  | 'meeting_started'
  | 'meeting_ended'
  | 'meeting_no_show'
  | 'recording_ready'
  | 'transcript_ready'
  | string

export interface WarnableStep {
  channel?: string | null
  smsBody?: string | null
  emailTemplate?: { subject?: string | null } | null
}

/**
 * Pipeline-feature footprint. When the rule is scoped to a specific pipeline,
 * the caller derives this from the pipeline's stage triggers (see
 * derivePipelineFeatures in src/app/dashboard/automations/page.tsx). If a
 * pattern requires a feature the pipeline doesn't have, we skip the warning —
 * e.g. don't tell the recruiter "you should use flow_completed for training"
 * if their pipeline has no training stages at all.
 *
 * Null/undefined ⇒ "any pipeline" ⇒ no filtering, all patterns apply.
 */
export interface PipelineFeatures {
  hasTraining: boolean
  hasMeetings: boolean
  hasBackgroundCheck: boolean
}

export interface WarnableRule {
  triggerType: WarnableTriggerType
  // Optional — when the editor passes the rule name, it's included in the
  // lexical scan. Recruiters often label rules by intent ("Flow Completed
  // follow-up") and forget to align the trigger, so the name itself is
  // frequently the clearest hint that the trigger is wrong.
  name?: string | null
  steps: WarnableStep[]
  pipelineFeatures?: PipelineFeatures | null
}

interface Pattern {
  // Regex applied to lowercased body/subject text. Case-insensitive by
  // virtue of pre-lowercasing — keep these literal without /i.
  test: RegExp
  // Trigger types where the phrase is on-topic. If the rule's trigger
  // isn't in this set, we surface a warning.
  expectedTriggers: WarnableTriggerType[]
  // Short label used in the warning text. "rescheduling" → "Body refers to rescheduling…"
  topic: string
  // Concrete trigger the recruiter probably meant. Surfaced in the
  // suggestion so the warning is actionable.
  suggestedTrigger: WarnableTriggerType
  // Pipeline feature required for this pattern to be relevant. When the rule
  // is pipeline-scoped and the pipeline lacks this feature, we skip the
  // warning — the topic literally can't apply to candidates in that pipeline.
  // Undefined = universal (always relevant; e.g. flow_completed).
  requiresFeature?: keyof PipelineFeatures
}

const PATTERNS: Pattern[] = [
  // Rescheduling language → only sensible on meeting_rescheduled
  {
    test: /\breschedul/,
    expectedTriggers: ['meeting_rescheduled'],
    topic: 'rescheduling',
    suggestedTrigger: 'meeting_rescheduled',
    requiresFeature: 'hasMeetings',
  },
  {
    test: /\bmoved to\b/,
    expectedTriggers: ['meeting_rescheduled'],
    topic: 'a meeting being moved',
    suggestedTrigger: 'meeting_rescheduled',
    requiresFeature: 'hasMeetings',
  },
  {
    test: /\bnew (time|link|meeting link|meet link)\b/,
    expectedTriggers: ['meeting_rescheduled'],
    topic: 'a new time / link',
    suggestedTrigger: 'meeting_rescheduled',
    requiresFeature: 'hasMeetings',
  },

  // Post-meeting follow-up language → only sensible on meeting_ended /
  // recording_ready / transcript_ready (the recording-ready handoff is
  // a common follow-up "your recording is ready" use case).
  {
    test: /\bthanks for (the )?(interview|meeting|call|joining|attending|chat)/,
    expectedTriggers: ['meeting_ended', 'recording_ready', 'transcript_ready'],
    topic: 'thanking the candidate after the meeting',
    suggestedTrigger: 'meeting_ended',
    requiresFeature: 'hasMeetings',
  },
  {
    test: /\bafter our (interview|meeting|call|chat)\b/,
    expectedTriggers: ['meeting_ended', 'recording_ready', 'transcript_ready'],
    topic: 'a follow-up after the meeting',
    suggestedTrigger: 'meeting_ended',
    requiresFeature: 'hasMeetings',
  },
  {
    test: /\b(great|nice) (speaking|talking|chatting)\b/,
    expectedTriggers: ['meeting_ended', 'recording_ready', 'transcript_ready'],
    topic: 'a post-meeting follow-up',
    suggestedTrigger: 'meeting_ended',
    requiresFeature: 'hasMeetings',
  },

  // No-show language → only sensible on meeting_no_show
  {
    test: /\b(missed (your|the) (interview|meeting|call))\b/,
    expectedTriggers: ['meeting_no_show'],
    topic: 'a missed meeting',
    suggestedTrigger: 'meeting_no_show',
    requiresFeature: 'hasMeetings',
  },
  {
    test: /\bno[- ]show\b/,
    expectedTriggers: ['meeting_no_show'],
    topic: 'a no-show',
    suggestedTrigger: 'meeting_no_show',
    requiresFeature: 'hasMeetings',
  },
  {
    test: /\b(didn'?t make it|couldn'?t make it|weren'?t able to join|we missed you)\b/,
    expectedTriggers: ['meeting_no_show'],
    topic: 'the candidate not showing up',
    suggestedTrigger: 'meeting_no_show',
    requiresFeature: 'hasMeetings',
  },

  // Application-received / flow-completed language → only sensible right
  // after the candidate finishes the application flow. Universal — every
  // pipeline has flow_completed/flow_passed stages.
  {
    test: /\b(received your application|thanks for applying|we'?ll review|we'?ll be in touch)\b/,
    expectedTriggers: ['flow_completed', 'flow_passed'],
    topic: 'receiving the candidate\'s application',
    suggestedTrigger: 'flow_completed',
  },
  {
    test: /\b(flow[- ]completed|application (received|completed|submitted))\b/,
    expectedTriggers: ['flow_completed', 'flow_passed'],
    topic: 'the candidate completing the application flow',
    suggestedTrigger: 'flow_completed',
  },

  // Training language → only sensible on training_* or automation_completed
  // (the chain trigger that follows the post-flow scheduling email).
  {
    test: /\b(your training is ready|start the training|begin the training|watch the training)\b/,
    expectedTriggers: ['flow_completed', 'flow_passed', 'training_started', 'automation_completed'],
    topic: 'starting the training',
    suggestedTrigger: 'flow_completed',
    requiresFeature: 'hasTraining',
  },
  {
    test: /\b(finished the training|completed the training|training is complete|training is done)\b/,
    expectedTriggers: ['training_completed'],
    topic: 'completing the training',
    suggestedTrigger: 'training_completed',
    requiresFeature: 'hasTraining',
  },

  // Scheduling / "book your interview" language → sensible at the point
  // the candidate is invited to schedule (training_completed in the
  // standard flow, or right after flow_completed for "skip training" funnels).
  {
    test: /\b(book your interview|schedule your interview|pick a time|choose a time)\b/,
    expectedTriggers: ['training_completed', 'flow_completed', 'flow_passed', 'background_check_passed'],
    topic: 'inviting the candidate to schedule',
    suggestedTrigger: 'training_completed',
    requiresFeature: 'hasMeetings',
  },

  // Pre-meeting reminder language → only sensible on before_meeting
  // (and arguably meeting_scheduled for the immediate confirmation).
  {
    test: /\b(your interview (starts|begins) in|reminder:? your interview|interview is coming up|interview starts in (\d+|a few) )\b/,
    expectedTriggers: ['before_meeting', 'meeting_scheduled'],
    topic: 'an upcoming meeting reminder',
    suggestedTrigger: 'before_meeting',
    requiresFeature: 'hasMeetings',
  },
]

function collectText(rule: WarnableRule): string {
  const parts: string[] = []
  if (rule.name) parts.push(rule.name)
  for (const step of rule.steps) {
    if (step.smsBody) parts.push(step.smsBody)
    if (step.emailTemplate?.subject) parts.push(step.emailTemplate.subject)
  }
  return parts.join('\n').toLowerCase()
}

export function detectAutomationWarnings(rule: WarnableRule): string[] {
  const text = collectText(rule)
  if (!text.trim()) return []
  const features = rule.pipelineFeatures ?? null
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of PATTERNS) {
    if (!p.test.test(text)) continue
    if (p.expectedTriggers.includes(rule.triggerType)) continue
    // When the rule is pipeline-scoped, only fire patterns whose topic is
    // reachable in that pipeline. A "you should use flow_completed for
    // training" hint is just noise on a pipeline that doesn't have training
    // stages — the recruiter has explicitly excluded that workflow.
    if (features && p.requiresFeature && !features[p.requiresFeature]) continue
    if (seen.has(p.topic)) continue
    seen.add(p.topic)
    out.push(
      `This message mentions ${p.topic}, but the trigger is "${rule.triggerType}". Use the "${p.suggestedTrigger}" trigger so this fires at the right point in the candidate's journey.`,
    )
  }
  return out
}

/**
 * Derive a PipelineFeatures footprint from a pipeline's stage trigger list.
 * Exported so the editor (and any other warning caller) can compute it
 * consistently. `stageTriggerEvents` is the flat set of `event` strings
 * pulled off each FunnelStage.triggers[].
 */
export function deriveFeaturesFromStageTriggers(stageTriggerEvents: Iterable<string>): PipelineFeatures {
  const events = new Set(stageTriggerEvents)
  return {
    hasTraining:
      events.has('training_started') || events.has('training_completed'),
    hasMeetings:
      events.has('meeting_scheduled') || events.has('meeting_confirmed') ||
      events.has('meeting_cancelled') || events.has('meeting_started') ||
      events.has('meeting_ended') || events.has('meeting_no_show'),
    hasBackgroundCheck:
      events.has('background_check_passed') ||
      events.has('background_check_failed') ||
      events.has('background_check_needs_review'),
  }
}
