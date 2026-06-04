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
    These are business outcomes, not personality traits. Examples by role type:
      • Dispatcher / customer intake / phone sales:
          discovery, scope qualification, service explanation, pricing delivery,
          objection handling, upsell of appropriate add-ons, booking control / closing,
          appointment confirmation, follow-up accuracy.
      • Cleaner / field / in-home service:
          presentation in customer homes, instruction-following, attention to detail,
          reliability signals (showing up, time discipline), safety + professionalism
          around customers and property, recovery when something goes wrong.
      • Other roles: read the JD carefully and infer the equivalent outcome-driving behaviors.

(B) CRITERIA — 4 to 8 scoring criteria that each measure ONE of the success factors above.
    Each criterion must be observable in a recorded screening conversation, AI training call,
    self-intro recording, or interview transcript. Weights sum to ~100; allocate weight in
    proportion to how much each behavior drives outcomes for THIS job.

HARD RULES:
  1. The criteria MUST be grounded in the success factors. Do not invent criteria the factors
     don't justify.
  2. Do NOT use these generic competency labels unless the JD explicitly requires them as
     standalone concerns: ${GENERIC_FORBIDDEN_AXES.join(', ')}.
     If the JD wants "professional phone manner", that's "Phone Manner & Tone" or
     "Customer-Facing Composure" — not bare "Professionalism".
  3. Prefer outcome-anchored names: "Booking Conversion", "Scope Qualification",
     "Service Explanation", "Pricing Delivery", "Objection Handling", "Upsell Ability",
     "Instruction Following", "Customer-Home Presentation" — not "Communication" or
     "Customer Service".
  4. Names are 2-4 words. Descriptions are one sentence stating the observable behavior
     AND why it matters for this job's outcomes.`

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
     OUTCOMES, not isolated statements. Consider whether the candidate:
       - gathered the right information (discovery, scope qualification)
       - explained services clearly enough that the customer could decide
       - delivered pricing without flinching or apologizing
       - handled hesitation and objections without losing the customer
       - moved the conversation toward booking / commitment / next step
       - built customer confidence over the course of the call, or eroded it
     A candidate who recited polite phrases but never moved toward booking
     scores lower than one who asked sharp qualifying questions and closed.
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
