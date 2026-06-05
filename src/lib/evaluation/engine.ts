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

// Model split by step. The rubric derivation is a JSON-shape transformation
// the smaller model handles fine (verified live against the dispatcher JD —
// produces "Lead Qualification / Booking Control / ..." correctly). The
// scoring step is where the actual cognitive work happens — reading
// transcripts, weighing evidence, judging conversational outcomes — and the
// smaller model produces clustered scores that don't differentiate strong
// candidates from average ones the way a recruiter (or ChatGPT-in-browser)
// would. We use gpt-4o for scoring and comparison.
const DERIVE_MODEL = 'gpt-4o-mini'
const SCORE_MODEL = 'gpt-4o'
const COMPARE_MODEL = 'gpt-4o'

export interface DerivedCriterion {
  name: string
  description: string
  weight: number
}

export interface ScoredCriterion extends DerivedCriterion {
  // Null when the criterion couldn't be evaluated because the required
  // data modality wasn't available (e.g. a video-presentation criterion
  // for a candidate with no video). Null scores are EXCLUDED from the
  // overall score and the comparison view shows them as N/A. Missing
  // data does NOT penalize the candidate, but it also doesn't count
  // toward a perfect score — the overall is computed over the criteria
  // that WERE scored, with their weights renormalized to sum to 100.
  score: number | null // 0..100 or null when not scored
  evidence: string
  // Short reason when score is null ("no video recording", "no AI-call
  // transcript"). Empty string when the criterion was actually scored.
  notScoredReason: string
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
  // Pre-scoring reasoning: the model's explicit analysis BEFORE committing
  // to numeric scores. Forces actual cognitive work instead of a snap
  // judgment, and gives the recruiter visibility into why each score
  // landed where it did. Surfaced in the UI as a "Reasoning" block.
  analysis: string
  // Coverage gaps that affected the score (e.g. "no AI-call transcript
  // available"). Empty when the candidate had full material.
  coverageGaps: string[]
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
    model: DERIVE_MODEL,
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
      const hasTranscript = !!cap.transcript?.trim()
      parts.push(`\n## Capture ${i + 1} (${cap.mode}${cap.durationSec ? `, ${Math.round(cap.durationSec)}s` : ''})`)
      if (cap.prompt) parts.push(`Prompt: ${cap.prompt}`)
      if (hasTranscript) {
        parts.push(`Transcript:\n${cap.transcript!.trim()}`)
      } else if (cap.aiSummary) {
        parts.push(`Summary: ${cap.aiSummary}`)
      } else {
        // The recording exists but wasn't transcribed — treat as a coverage
        // gap, NOT as evidence. Make this loud so the model doesn't infer
        // anything from the file's mere existence.
        parts.push(
          `(NO TRANSCRIPT — file was uploaded but the transcription pipeline did not produce text. This recording is NOT evaluable content. Score related criteria as null with notScoredReason="capture exists but was not transcribed".)`,
        )
      }
    })
  }

  if (material.meetings.length > 0) {
    const meetingsWithTranscript = material.meetings.filter((m) => !!m.transcript?.trim())
    const meetingsAttendanceOnly = material.meetings.filter((m) => !m.transcript?.trim())

    if (meetingsWithTranscript.length > 0) {
      parts.push(`\n# Interview Meetings — RECORDED TRANSCRIPTS (${meetingsWithTranscript.length})`)
      parts.push(
        `These are the actual transcripts of the candidate's recorded interviews. Treat this as your strongest evidence for in-person interview behavior. The transcript source (recall.ai or Google Meet / Gemini) may label speakers with display names rather than "user"/"assistant"; identify the candidate by name where possible.`,
      )
      meetingsWithTranscript.forEach((m, i) => {
        const attended = !!m.actualStart
        const duration =
          m.actualStart && m.actualEnd
            ? Math.round((new Date(m.actualEnd).getTime() - new Date(m.actualStart).getTime()) / 1000 / 60)
            : null
        parts.push(
          `\n## Meeting ${i + 1} (transcript via ${m.transcriptSource ?? 'unknown'}) — scheduled ${m.scheduledStart}, attended=${attended}${
            duration !== null ? `, ${duration}min` : ''
          }`,
        )
        parts.push(`Transcript:\n${m.transcript!.trim()}`)
      })
    }

    if (meetingsAttendanceOnly.length > 0) {
      parts.push(`\n# Interview Meetings — ATTENDANCE METADATA ONLY (${meetingsAttendanceOnly.length})`)
      parts.push(
        `These meetings were attended but no transcript was available. You can see that the candidate showed up (or didn't) and for how long, but you have NO information about what was actually said. Do NOT infer dispatcher behaviors, customer-service quality, presentation, or any other criterion from a meeting attendance record. Useful only as a reliability / showing-up signal.`,
      )
      meetingsAttendanceOnly.forEach((m, i) => {
      const attended = !!m.actualStart
      const duration =
        m.actualStart && m.actualEnd
          ? Math.round((new Date(m.actualEnd).getTime() - new Date(m.actualStart).getTime()) / 1000 / 60)
          : null
      const others = m.participants.filter((p) => p.email && !p.email.includes('hirefunnel'))
      parts.push(
        `\n## Meeting ${i + 1} (attendance metadata only) — scheduled ${m.scheduledStart}, attended=${attended}${
          duration !== null ? `, ${duration}min` : ''
        }, attendees=${others.length}`,
      )
      })
    }
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

Missing data — SKIP, don't penalize (CRITICAL):
  - If a criterion's required data modality isn't available for this
    candidate, set its score to null and fill notScoredReason with a
    short explanation ("no video recording", "no AI-call transcript",
    "no interview meeting attended"). DO NOT guess a score and DO NOT
    penalize the candidate for the gap. Missing data is just missing.
  - Concretely:
      • No AI-call / phone-roleplay transcript → criteria that can only
        be observed on a live call (Booking Control, Pricing Delivery,
        Objection Handling, Complaint Recovery, Lead Qualification by
        phone) get score=null with notScoredReason="no AI-call transcript".
      • No video / self-intro recording → camera-presence / presentation
        / engagement criteria get score=null with notScoredReason="no
        video recording".
      • No interview meeting attended → meeting-only criteria get
        score=null.
  - DO score the criteria you CAN observe. If a candidate has a strong
    AI-call but no video, they're scored on the phone behaviors and the
    video-only criteria are null. Their overall reflects their actual
    demonstrated performance on the criteria that were evaluable — no
    artificial cap, no artificial floor.
  - The OUTPUT overallScore field is for YOUR weighted average of the
    SCORED criteria. The engine will renormalize weights so the criteria
    you scored sum to 100; you don't need to do that math. Just compute
    the weighted average over the criteria you actually scored.
  - Populate coverageGaps with the list of missing modalities so the UI
    can show what wasn't evaluated. Empty array when the candidate had
    full material for the rubric.

Overall score & recommendation:
  - overallScore: weighted average over the criteria you actually scored
    (skip the nulls). Round to integer. The engine renormalizes weights
    server-side as a safety net.
  - Recommendation thresholds: ≥85 strong_hire, 70-84 hire, 55-69 borderline,
    <55 no_hire. When more than ~⅓ of the rubric weight couldn't be
    scored, lean toward borderline rather than strong_hire — the high
    score is on partial evidence and the recruiter should verify.

Pre-scoring analysis (REQUIRED — write this FIRST, before the criterion
scores):
  - In 4-8 sentences, walk through what the material actually shows for
    this candidate against the role's success factors. Name the specific
    moments / behaviors / quotes that drove your reasoning. This is the
    thinking work that justifies the numbers — do it explicitly, don't
    skip to scores.
  - This analysis is shown to the recruiter. Write it as if you're
    briefing them, not as internal scratch.

Coverage gaps (REQUIRED list, possibly empty):
  - List every data modality that was MISSING for this candidate
    (e.g. "no AI-call / phone-roleplay transcript", "no video self-intro",
    "no interview meeting attended"). Empty array when the candidate had
    full material for the role's rubric.

Strengths / weaknesses / summary:
  - Each strength / weakness is a one-line statement of an outcome-driving
    behavior the candidate did or failed to do. NOT generic praise/criticism.
  - The summary is 1-2 sentences focused on the candidate's likely job
    performance — would they convert leads, would they show up and present
    well in a customer's home, etc. When coverage gaps exist, the summary
    MUST mention them ("scoring is uncertain because no AI-call transcript
    was available — verify before hire").

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
    model: SCORE_MODEL,
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'evaluation',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          // `analysis` and `coverageGaps` come FIRST in `required` so the
          // structured-output model commits to its reasoning before
          // producing scores. Empirically this produces better
          // differentiation between candidates than skipping straight to
          // the criteria array.
          required: ['analysis', 'coverageGaps', 'criteria', 'overallScore', 'recommendation', 'summary', 'strengths', 'weaknesses'],
          properties: {
            analysis: {
              type: 'string',
              description:
                '4-8 sentences walking through what the material shows. Name specific moments. Reason before scoring.',
            },
            coverageGaps: {
              type: 'array',
              items: { type: 'string' },
              description: 'Missing data modalities (e.g. "no AI-call transcript"). Empty when material is complete.',
            },
            overallScore: { type: 'integer', minimum: 0, maximum: 100 },
            recommendation: { type: 'string', enum: ['strong_hire', 'hire', 'borderline', 'no_hire'] },
            summary: { type: 'string' },
            criteria: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'description', 'weight', 'score', 'evidence', 'notScoredReason'],
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  weight: { type: 'integer' },
                  // Nullable score — null when the data modality the
                  // criterion needs is absent for this candidate. Skip
                  // and renormalize, don't penalize.
                  score: {
                    type: ['integer', 'null'],
                    minimum: 0,
                    maximum: 100,
                    description:
                      'Null when the criterion could not be evaluated due to missing data modality. The engine excludes nulls from the overall and renormalizes weights of the rest.',
                  },
                  evidence: {
                    type: 'string',
                    description:
                      'Direct quote, summarized multi-turn behavior, or literal "no evidence". Must justify the score; never cherry-picked.',
                  },
                  notScoredReason: {
                    type: 'string',
                    description:
                      'Short reason when score is null (e.g. "no video recording"). Empty string when score is a number.',
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

  return {
    ...parsed,
    overallScore: computeOverallFromScoredCriteria(parsed.criteria),
    roleSuccessFactors: derivation.roleSuccessFactors,
  }
}

/**
 * Server-side overall computation. Skips null-scored criteria entirely (the
 * candidate didn't have the data modality for them), then computes a
 * weight-weighted average over the criteria that DID get scored, with their
 * weights renormalized to sum to 100. Returns 0 when no criterion was scored
 * (so the recommendation logic still has a number to act on, though that's
 * an edge case — a candidate with no evaluable material shouldn't get a
 * meaningful overall).
 *
 * This is the "missing data = skip, not penalize" rule the recruiter asked
 * for. Exported so the test suite can verify the renormalization math.
 */
export function computeOverallFromScoredCriteria(
  criteria: Array<{ score: number | null; weight: number }>,
): number {
  const scored = criteria.filter(
    (c): c is { score: number; weight: number } => typeof c.score === 'number',
  )
  if (scored.length === 0) return 0
  const weightSum = scored.reduce((s, c) => s + c.weight, 0) || 1
  const weighted = scored.reduce((s, c) => s + (c.score * c.weight) / weightSum, 0)
  return Math.round(weighted)
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
    model: COMPARE_MODEL,
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
