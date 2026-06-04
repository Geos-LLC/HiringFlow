/**
 * Candidate AI evaluation engine.
 *
 * Two-stage flow:
 *   1. Derive 3-6 ROLE SUCCESS FACTORS from the JD (the observable behaviors
 *      that actually predict success in THIS job — booking conversion,
 *      objection handling, scope qualification, etc.), then translate those
 *      factors into 4-8 weighted scoring criteria. Done in a single
 *      Structured-Outputs call so the model commits to factors before the
 *      criteria depend on them.
 *
 *   2. Score the candidate against those criteria using the actual transcripts
 *      and (optional) AI media observations. Scoring is OUTCOME-driven for
 *      customer-facing/phone roles — did the conversation move toward a
 *      booking, was the scope qualified, was confidence built — not isolated
 *      quote matching.
 *
 * Both stages use OpenAI Structured Outputs (json_schema, strict) so the
 * response shape is guaranteed parseable. Model: gpt-4o-mini.
 */

import { openai } from '@/lib/openai'
import type { GatheredMaterial } from './gather'
import type { VoiceObservationResult, VideoObservationResult } from './media-observation'

const MODEL = 'gpt-4o-mini'

export interface DerivedCriterion {
  name: string
  description: string
  weight: number
}

export interface ScoredCriterion extends DerivedCriterion {
  score: number // 0..100
  evidence: string
}

export interface RubricDerivation {
  roleSuccessFactors: string[]
  criteria: DerivedCriterion[]
}

export interface EvaluationResult {
  overallScore: number
  recommendation: 'strong_hire' | 'hire' | 'borderline' | 'no_hire'
  summary: string
  criteria: ScoredCriterion[]
  strengths: string[]
  weaknesses: string[]
  // Carried from the derivation step so the API route can persist the
  // factors the rubric was built from. Not scored by the model — purely
  // informative for the recruiter UI.
  roleSuccessFactors: string[]
}

// Generic competency axes that AREN'T allowed unless the JD literally calls
// for them. The derivation prompt names this list explicitly so the model
// won't fall back to bland HR vocabulary. Kept here too so tests can assert
// the list is faithfully reflected in the prompt.
export const GENERIC_FORBIDDEN_AXES = [
  'Communication',
  'Professionalism',
  'Organization',
  'Organizational Skills',
  'Technical Proficiency',
  'Customer Service Excellence',
  'Customer Service',
  'Time Management',
  'Problem Solving',
  'Teamwork',
  'Attention to Detail',
] as const

export const DERIVE_RUBRIC_SYSTEM_PROMPT = `You design hiring rubrics that predict on-the-job success, not generic HR competencies.

Your output has TWO sections:

(A) ROLE SUCCESS FACTORS — 3 to 6 observable behaviors that DIRECTLY predict success in this specific job.
    These are business outcomes, not personality traits. Examples by role type
    (illustrative — derive the actual factors from THIS JD):
      • Dispatcher / customer intake / residential cleaning / phone sales:
          building rapport quickly with homeowners, qualifying cleaning scope
          naturally (not via interrogation), explaining services clearly,
          delivering pricing confidently, handling objections and hesitation,
          recovering from customer complaints, upselling appropriate add-ons,
          controlling the call toward booking, scheduling accurately and
          confirming appointment details.
      • Cleaner / field / in-home service:
          professional presentation in customer homes, instruction-following,
          reliability signals (showing up, time discipline), attention to detail,
          customer-home professionalism, recovery when something goes wrong.
      • Sales / closing roles:
          discovery, value demonstration, objection handling, urgency creation,
          closing conversion, follow-up discipline.
      • Operations / coordination roles:
          process accuracy, documentation discipline, cross-team coordination,
          error recovery, throughput.
      • Other roles: read the JD carefully and infer the equivalent
        outcome-driving behaviors. Do NOT default to dispatcher behaviors when
        the JD is about something else.

(B) CRITERIA — 4 to 8 scoring criteria that each measure ONE of the success factors above.
    Each criterion must be observable in a recorded screening conversation, AI training call,
    self-intro recording, or interview transcript. Weights sum to ~100; allocate weight in
    proportion to how much each behavior drives outcomes for THIS job.

HARD RULES:
  1. IDENTIFY the role type before doing anything else. If the JD title or
     summary mentions dispatcher, scheduler, intake coordinator, customer
     intake, phone sales, sales manager, sales dispatcher, booking agent —
     treat this as a PHONE INTAKE / SALES role and use that family's
     success behaviors. The role type is decided by the role nature, NOT
     by which bullets happen to appear under "Responsibilities".
  2. The criteria MUST be grounded in the success factors. Do not invent
     criteria the factors don't justify.
  3. DO NOT mechanically rename JD responsibility bullets into criterion
     names. This is the most common failure mode. Translate each
     responsibility into the underlying outcome behavior it implies for
     this role family:
       BAD (literal bullet paraphrase, DO NOT produce these):
         "Client Request Processing", "Schedule Coordination",
         "Team Support Coordination", "Task Monitoring and Reporting",
         "Customer Communication Excellence", "Customer Communication",
         "Request Handling", "Coordination Skills".
       GOOD (outcome behavior the bullet actually requires):
         "Receive and process client requests" → "Lead Qualification" +
            "Service Explanation" + "Booking Control" (because for a
            dispatcher, processing a client request IS qualifying scope,
            explaining service, and closing the booking).
         "Create and coordinate schedules" → "Scheduling Accuracy".
         "Support and coordinate the work of the cleaning team" →
            stays a success FACTOR but typically doesn't become a
            scoring criterion unless the recording shows it.
         "Handle objections and convert leads" → "Objection Handling" +
            "Booking Control" + "Upsell Ability".
         "Provide excellent customer service and communication" →
            "Rapport Building" + "Complaint Recovery" (NOT bare
            "Customer Service" or "Communication").
  4. Do NOT use these generic competency labels unless the JD explicitly
     requires them as standalone concerns: ${GENERIC_FORBIDDEN_AXES.join(', ')}.
     If the JD wants "professional phone manner", that's "Phone Manner &
     Tone" or "Customer-Facing Composure" — not bare "Professionalism".
  5. Prefer outcome-anchored names. Good examples for the relevant role
     families:
       • Dispatcher / phone intake / sales dispatcher: "Lead Qualification",
         "Service Explanation", "Pricing Delivery", "Booking Control",
         "Upsell Ability", "Objection Handling", "Complaint Recovery",
         "Scheduling Accuracy", "Rapport Building".
       • Cleaner / field: "Instruction Following", "Customer-Home Presentation",
         "Reliability Signals", "Detail Coverage", "Property Safety".
       • Sales: "Discovery Depth", "Value Demonstration", "Closing Conversion",
         "Follow-Up Discipline".
     Avoid bare "Communication" or "Customer Service".
  6. Names are 2-4 words. Descriptions are one sentence stating the observable
     behavior AND why it matters for this job's outcomes.`

export async function deriveCriteria(positionDescription: string): Promise<RubricDerivation> {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'rubric',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['roleSuccessFactors', 'criteria'],
          properties: {
            roleSuccessFactors: {
              type: 'array',
              minItems: 3,
              maxItems: 6,
              items: { type: 'string' },
              description:
                'Observable behaviors that directly predict success in this specific role. Outcome-driving, not generic HR competencies.',
            },
            criteria: {
              type: 'array',
              minItems: 4,
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'description', 'weight'],
                properties: {
                  name: { type: 'string', description: '2-4 words, outcome-anchored.' },
                  description: { type: 'string', description: 'One sentence: observable behavior + why it matters for this job.' },
                  weight: { type: 'integer', minimum: 5, maximum: 50 },
                },
              },
            },
          },
        },
      },
    },
    messages: [
      { role: 'system', content: DERIVE_RUBRIC_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Position description:\n\n${positionDescription}\n\nDerive the role success factors first, then build the rubric criteria from them.`,
      },
    ],
  })

  const raw = completion.choices[0]?.message?.content
  if (!raw) throw new Error('Empty rubric response from model')
  const parsed = JSON.parse(raw) as RubricDerivation

  // Normalize weights to sum to 100 — the schema allows the model to drift.
  const total = parsed.criteria.reduce((s, c) => s + c.weight, 0) || 1
  return {
    roleSuccessFactors: parsed.roleSuccessFactors,
    criteria: parsed.criteria.map((c) => ({
      ...c,
      weight: Math.round((c.weight / total) * 100),
    })),
  }
}

function renderTranscriptsForPrompt(material: GatheredMaterial): string {
  const parts: string[] = []

  parts.push(`# Candidate\n`)
  parts.push(`Name: ${material.session.candidateName ?? '(unknown)'}`)
  if (material.session.flowName) parts.push(`Applied to: ${material.session.flowName}`)
  parts.push(`Applied: ${material.session.appliedAt}`)
  if (material.session.formData && Object.keys(material.session.formData).length > 0) {
    parts.push(`Application form:`)
    for (const [k, v] of Object.entries(material.session.formData)) {
      parts.push(`  ${k}: ${v}`)
    }
  }

  if (material.aiCalls.length > 0) {
    parts.push(`\n# AI Training Calls (${material.aiCalls.length})`)
    parts.push(
      `Context: the AI plays a customer; the candidate plays the dispatcher/staff member being trained. Score the candidate (labeled "user" in transcripts).`,
    )
    material.aiCalls.forEach((call, i) => {
      parts.push(`\n## AI Call ${i + 1} (${call.durationSecs}s, result=${call.callSuccessful ?? 'n/a'})`)
      if (call.summary) parts.push(`Summary: ${call.summary}`)
      if (call.transcript.length > 0) {
        parts.push(`Transcript:`)
        call.transcript.forEach((t) => parts.push(`  [${t.role}] ${t.message}`))
      } else {
        parts.push(`(transcript empty)`)
      }
    })
  }

  if (material.captures.length > 0) {
    parts.push(`\n# Self-Introduction & Screening Recordings (${material.captures.length})`)
    material.captures.forEach((cap, i) => {
      parts.push(`\n## Capture ${i + 1} (${cap.mode}${cap.durationSec ? `, ${Math.round(cap.durationSec)}s` : ''})`)
      if (cap.prompt) parts.push(`Prompt: ${cap.prompt}`)
      if (cap.transcript?.trim()) parts.push(`Transcript:\n${cap.transcript.trim()}`)
      else if (cap.aiSummary) parts.push(`Summary: ${cap.aiSummary}`)
      else parts.push(`(no transcript)`)
    })
  }

  if (material.meetings.length > 0) {
    parts.push(`\n# Interview Meetings (${material.meetings.length})`)
    material.meetings.forEach((m, i) => {
      const attended = !!m.actualStart
      const duration =
        m.actualStart && m.actualEnd
          ? Math.round((new Date(m.actualEnd).getTime() - new Date(m.actualStart).getTime()) / 1000 / 60)
          : null
      const others = m.participants.filter((p) => p.email && !p.email.includes('hirefunnel'))
      parts.push(
        `\n## Meeting ${i + 1} — scheduled ${m.scheduledStart}, attended=${attended}${
          duration !== null ? `, ${duration}min` : ''
        }, attendees=${others.length}`,
      )
    })
  }

  if (
    material.aiCalls.length === 0 &&
    material.captures.length === 0 &&
    material.meetings.length === 0
  ) {
    parts.push(`\n(No recorded material available for this candidate.)`)
  }

  return parts.join('\n')
}

function renderObservationsForPrompt(
  voice: VoiceObservationResult | null,
  video: VideoObservationResult | null,
): string {
  if (!voice && !video) return ''
  const parts: string[] = [`\n# AI Media Observation (descriptive, not psychometric)`]
  if (voice && voice.clips.length > 0) {
    parts.push(`\n## Voice observations`)
    parts.push(voice.summary || '(no summary)')
    for (const c of voice.clips) {
      parts.push(`- [${c.assetType}/${c.assetId.slice(0, 8)}] pace: ${c.pace}; clarity: ${c.clarity}; hesitation: ${c.hesitation}; energy: ${c.energy}; articulation: ${c.articulation}`)
      for (const e of c.evidence) parts.push(`    evidence: ${e}`)
    }
  }
  if (video && video.clips.length > 0) {
    parts.push(`\n## Video observations`)
    parts.push(video.summary || '(no summary)')
    for (const c of video.clips) {
      parts.push(`- [${c.assetType}/${c.assetId.slice(0, 8)}] presentation: ${c.presentation}; camera presence: ${c.cameraPresence}; engagement: ${c.engagement}`)
      for (const e of c.evidence) parts.push(`    evidence: ${e}`)
    }
  } else if (video?.unavailableReason) {
    parts.push(`\n## Video observations`)
    parts.push(`(unavailable: ${video.unavailableReason})`)
  }
  return parts.join('\n')
}

export const SCORE_CANDIDATE_SYSTEM_PROMPT = `You score a candidate against a fixed outcome-driven rubric using only the provided material.

How to score each criterion (0-100):
  1. Treat each criterion as a BUSINESS BEHAVIOR, not an HR adjective. Ask:
     did the candidate actually do this behavior in a way that would drive
     the desired outcome for THIS job?
  2. For customer-facing or phone-based roles, evaluate COMPLETE CONVERSATION
     OUTCOMES across the whole call, not isolated statements. Specifically
     check whether the candidate:
       - OPENED the conversation naturally and built rapport quickly
         (instead of stiff scripted openers or going straight into questions)
       - GATHERED required information in a NATURAL order, conversationally
         (discovery, scope qualification) — NOT a back-to-back interrogation
         that drains the customer
       - EXPLAINED services clearly enough that the customer could decide
       - DELIVERED pricing confidently — no flinching, no apologizing,
         no over-discounting
       - HANDLED objections, hesitation, and complaints by acknowledging
         and recovering, rather than ignoring or deflecting
       - OFFERED appropriate add-ons / upsells in context (not pushy,
         not absent)
       - MOVED the conversation toward booking, commitment, or a clear
         next step
       - CONFIRMED appointment details accurately (date, time, address,
         scope) before ending the call
       - BUILT customer confidence over the course of the call, or eroded it
     A candidate who recited polite phrases but never qualified scope,
     stumbled on price, or never closed scores LOWER than one who
     conversationally discovered, quoted confidently, handled an objection,
     and confirmed the booking — even if the second candidate had a less
     polished opener.
  3. For field/cleaner/in-home roles, evaluate behaviors visible in the
     self-intro recording and any captures: presentation, instruction
     following, reliability signals, attention to detail, professionalism
     around customers and property.

Evidence rules:
  - Evidence MUST justify the score. Use whichever of these fits the behavior:
      • A direct quote ("$129 base plus $50 per hour")
      • A summary of multi-turn behavior across the conversation
        ("Asked about square footage and bedroom count before quoting, then
         confirmed the date and offered the eco add-on")
      • The literal string "no evidence" — and PENALIZE the score in that case
  - Do NOT cherry-pick a polite sentence as proof of a behavior the candidate
    didn't actually perform.
  - When AI Media Observation is provided, treat it as descriptive evidence
    (pace, clarity, hesitation, energy, articulation, presentation, camera
    presence, engagement). It informs but never decides — and is NEVER used
    as a measure of trustworthiness, honesty, or personality.

Overall score & recommendation:
  - overallScore is the weight-weighted average of the criterion scores.
  - Recommendation thresholds: ≥85 strong_hire, 70-84 hire, 55-69 borderline,
    <55 no_hire.

Strengths / weaknesses / summary:
  - Each strength / weakness is a one-line statement of an outcome-driving
    behavior the candidate did or failed to do. NOT generic praise/criticism.
  - The summary is 1-2 sentences focused on the candidate's likely job
    performance — would they convert leads, would they show up and present
    well in a customer's home, etc. Specific over bland.

Be specific and honest — bland praise is worse than no feedback. Never reject
a candidate solely on observation findings.`

async function scoreCandidate(
  positionDescription: string,
  derivation: RubricDerivation,
  material: GatheredMaterial,
  voice: VoiceObservationResult | null,
  video: VideoObservationResult | null,
): Promise<EvaluationResult> {
  const observationBlock = renderObservationsForPrompt(voice, video)
  const successFactorsBlock =
    derivation.roleSuccessFactors.length > 0
      ? `\n\nRole success factors (the outcomes this rubric was built from):\n` +
        derivation.roleSuccessFactors.map((f) => `  - ${f}`).join('\n')
      : ''
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'evaluation',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['overallScore', 'recommendation', 'summary', 'criteria', 'strengths', 'weaknesses'],
          properties: {
            overallScore: { type: 'integer', minimum: 0, maximum: 100 },
            recommendation: { type: 'string', enum: ['strong_hire', 'hire', 'borderline', 'no_hire'] },
            summary: { type: 'string' },
            criteria: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'description', 'weight', 'score', 'evidence'],
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  weight: { type: 'integer' },
                  score: { type: 'integer', minimum: 0, maximum: 100 },
                  evidence: {
                    type: 'string',
                    description:
                      'Direct quote, summarized multi-turn behavior, or literal "no evidence". Must justify the score; never cherry-picked.',
                  },
                },
              },
            },
            strengths: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 8 },
            weaknesses: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 8 },
          },
        },
      },
    },
    messages: [
      { role: 'system', content: SCORE_CANDIDATE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Position description:\n\n${positionDescription}${successFactorsBlock}\n\nRubric (you MUST return all of these in the same order with the same weights):\n${JSON.stringify(
          derivation.criteria,
          null,
          2,
        )}\n\nCandidate material:\n\n${renderTranscriptsForPrompt(material)}${observationBlock}`,
      },
    ],
  })

  const raw = completion.choices[0]?.message?.content
  if (!raw) throw new Error('Empty evaluation response from model')
  const parsed = JSON.parse(raw) as Omit<EvaluationResult, 'roleSuccessFactors'>
  return { ...parsed, roleSuccessFactors: derivation.roleSuccessFactors }
}

export async function runEvaluation(
  positionDescription: string,
  material: GatheredMaterial,
  voice?: VoiceObservationResult | null,
  video?: VideoObservationResult | null,
): Promise<EvaluationResult> {
  const derivation = await deriveCriteria(positionDescription)
  return scoreCandidate(positionDescription, derivation, material, voice ?? null, video ?? null)
}

// =================================================================
// Cross-candidate comparison summary
// =================================================================
//
// Given a set of saved evaluations for candidates being considered for the
// SAME role, produce a role-aware relative summary so the recruiter can see
// at-a-glance: who's best for immediate conversion, who fits operations
// better, who needs coaching, who has risk flags.
//
// The bucket labels are NOT hardcoded — the model derives 3-5 deployment
// buckets from the role's success factors, then assigns each candidate to
// a bucket with a one-line reason. This stays consistent with the rest of
// the engine's "role-dynamic, no hardcoded categories" architecture.

export interface ComparisonInputEvaluation {
  sessionId: string
  candidateName: string | null
  overallScore: number
  recommendation: EvaluationResult['recommendation']
  summary: string
  criteria: Array<{ name: string; weight: number; score: number; evidence: string }>
  strengths: string[]
  weaknesses: string[]
  roleSuccessFactors?: string[] | null
}

export interface ComparisonBucket {
  label: string
  description: string
  sessionIds: string[]
  reason: string
}

export interface ComparisonRiskFlag {
  sessionId: string
  flag: string
  severity: 'low' | 'medium' | 'high'
}

export interface ComparisonTrainingItem {
  sessionId: string
  // What this candidate would need to be ready for the role.
  needs: string
}

export interface ComparisonResult {
  // 3-5 deployment buckets, model-derived from the role's success factors.
  // Each bucket can hold 0 or more candidates. A candidate can appear in
  // at most one bucket — the model picks the best fit.
  buckets: ComparisonBucket[]
  trainingRequired: ComparisonTrainingItem[]
  riskFlags: ComparisonRiskFlag[]
  // 2-3 sentence overview: who you'd hire, who you'd put where, who you'd
  // pass on. Specific over bland.
  summary: string
}

export const COMPARE_CANDIDATES_SYSTEM_PROMPT = `You compare candidates evaluated against the SAME role and produce a relative deployment summary.

Output structure:
  1. BUCKETS — derive 3-5 deployment buckets from the role's success factors.
     Each bucket is a slot the recruiter would actually fill. Examples
     depending on the role:
       • Phone-intake / dispatcher: "Strongest for immediate dispatcher
         conversion", "Strongest for operations / process discipline",
         "Coachable — needs training", "Pass".
       • Field / cleaner: "Ready for solo work", "Ready with checklist
         supervision", "Needs ride-along training", "Pass".
       • Sales: "Ready to quota", "Ramp candidate", "Pass".
     Bucket LABELS must reflect THIS role's outcomes — do NOT use generic
     "Top performer / Average / Weak". Each bucket gets a one-line
     description of why the bucket exists, and the sessionIds of the
     candidates assigned to it with a one-line reason per assignment.

  2. TRAINING REQUIRED — for any candidate who would need specific coaching
     to be ready, name the actual skill gap (e.g. "needs pricing-delivery
     reps", "needs scope-qualification practice"), not "needs training".

  3. RISK FLAGS — concrete behaviors that would put the company or the
     customer at risk. Severity: low / medium / high. Examples:
     "deflected complaint instead of recovering" (medium),
     "made up pricing not on the rate card" (high),
     "didn't confirm appointment details before ending the call" (medium).

  4. SUMMARY — 2-3 sentences telling the recruiter who to hire, who to
     deploy where, and who to pass on. Specific over bland.

Hard rules:
  - Every candidate in the input MUST appear in exactly ONE bucket. Don't
    silently drop anyone.
  - Compare candidates RELATIVELY, not absolutely — even if all candidates
    are weak, the strongest still goes in the highest-quality bucket
    available, and the recruiter can decide whether to hire from it.
  - Reasons must reference SPECIFIC criteria scores or evidence from the
    input, not generic language.
  - Do NOT invent criteria or behaviors the evaluations don't mention.`

export async function compareEvaluations(
  positionDescription: string,
  evaluations: ComparisonInputEvaluation[],
): Promise<ComparisonResult> {
  if (evaluations.length < 2) {
    throw new Error('Need at least 2 evaluations to produce a comparison')
  }

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'comparison',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['buckets', 'trainingRequired', 'riskFlags', 'summary'],
          properties: {
            buckets: {
              type: 'array',
              minItems: 2,
              maxItems: 5,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'description', 'sessionIds', 'reason'],
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                  sessionIds: { type: 'array', items: { type: 'string' } },
                  reason: { type: 'string' },
                },
              },
            },
            trainingRequired: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['sessionId', 'needs'],
                properties: {
                  sessionId: { type: 'string' },
                  needs: { type: 'string' },
                },
              },
            },
            riskFlags: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['sessionId', 'flag', 'severity'],
                properties: {
                  sessionId: { type: 'string' },
                  flag: { type: 'string' },
                  severity: { type: 'string', enum: ['low', 'medium', 'high'] },
                },
              },
            },
            summary: { type: 'string' },
          },
        },
      },
    },
    messages: [
      { role: 'system', content: COMPARE_CANDIDATES_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Position description:\n\n${positionDescription}\n\nCandidates (use sessionId verbatim in your output):\n\n${JSON.stringify(
          evaluations,
          null,
          2,
        )}`,
      },
    ],
  })

  const raw = completion.choices[0]?.message?.content
  if (!raw) throw new Error('Empty comparison response from model')
  return JSON.parse(raw) as ComparisonResult
}
