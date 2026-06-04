/**
 * Candidate AI evaluation engine.
 *
 * Two-stage flow:
 *   1. Ask the model to derive role-specific scoring criteria from the JD
 *      (so Dispatcher and Cleaner evaluations score against different
 *      dimensions). Returned as { name, description, weight } items, weights
 *      summing to 100.
 *   2. Ask the model to grade the candidate's actual transcripts against
 *      those criteria — 0..100 per criterion + evidence quote + summary +
 *      strengths + weaknesses + recommendation.
 *
 * Both stages use the OpenAI Structured Outputs (json_schema response_format)
 * so the result is guaranteed parseable. Model: gpt-4o-mini (cheap + fast,
 * already configured for the rest of HF).
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

export interface EvaluationResult {
  overallScore: number
  recommendation: 'strong_hire' | 'hire' | 'borderline' | 'no_hire'
  summary: string
  criteria: ScoredCriterion[]
  strengths: string[]
  weaknesses: string[]
}

async function deriveCriteria(positionDescription: string): Promise<DerivedCriterion[]> {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'criteria',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['criteria'],
          properties: {
            criteria: {
              type: 'array',
              minItems: 4,
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'description', 'weight'],
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  weight: { type: 'integer', minimum: 5, maximum: 50 },
                },
              },
            },
          },
        },
      },
    },
    messages: [
      {
        role: 'system',
        content:
          'You design role-specific hiring rubrics. Given a job description, output 4-8 evaluation criteria with weights summing to ~100. Each criterion targets a single, observable behavior in a recorded screening conversation. Pick criteria the actual JD emphasizes — do NOT default to generic axes when the role calls for specific skills (e.g. dispatcher → quoting accuracy; cleaner → product knowledge; sales → objection handling). Names are 2-4 words. Descriptions are one sentence.',
      },
      {
        role: 'user',
        content: `Position description:\n\n${positionDescription}\n\nReturn the rubric.`,
      },
    ],
  })

  const raw = completion.choices[0]?.message?.content
  if (!raw) throw new Error('Empty criteria response from model')
  const parsed = JSON.parse(raw) as { criteria: DerivedCriterion[] }

  // Normalize weights to sum to 100 — the schema allows the model to drift.
  const total = parsed.criteria.reduce((s, c) => s + c.weight, 0) || 1
  return parsed.criteria.map((c) => ({
    ...c,
    weight: Math.round((c.weight / total) * 100),
  }))
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

async function scoreCandidate(
  positionDescription: string,
  criteria: DerivedCriterion[],
  material: GatheredMaterial,
  voice: VoiceObservationResult | null,
  video: VideoObservationResult | null,
): Promise<EvaluationResult> {
  const observationBlock = renderObservationsForPrompt(voice, video)
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
                  evidence: { type: 'string' },
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
      {
        role: 'system',
        content:
          'You are an experienced hiring manager scoring a candidate against a fixed rubric using only the provided material. For each criterion: give a 0-100 score and a one-sentence evidence quote from the transcript or observation (or "no evidence" if the material did not cover that criterion — penalize the score in that case). Compute overallScore as the weight-weighted average of criterion scores. Recommendation thresholds: ≥85=strong_hire, 70-84=hire, 55-69=borderline, <55=no_hire. Be specific and honest — bland praise is worse than no feedback. When AI Media Observation is provided, treat it as descriptive evidence (pace, clarity, hesitation, energy, articulation, presentation) — never as a measure of trustworthiness, honesty, or personality, and never reject a candidate solely on observation findings.',
      },
      {
        role: 'user',
        content: `Position description:\n\n${positionDescription}\n\nRubric (you MUST return all of these in the same order with the same weights):\n${JSON.stringify(
          criteria,
          null,
          2,
        )}\n\nCandidate material:\n\n${renderTranscriptsForPrompt(material)}${observationBlock}`,
      },
    ],
  })

  const raw = completion.choices[0]?.message?.content
  if (!raw) throw new Error('Empty evaluation response from model')
  return JSON.parse(raw) as EvaluationResult
}

export async function runEvaluation(
  positionDescription: string,
  material: GatheredMaterial,
  voice?: VoiceObservationResult | null,
  video?: VideoObservationResult | null,
): Promise<EvaluationResult> {
  const criteria = await deriveCriteria(positionDescription)
  return scoreCandidate(positionDescription, criteria, material, voice ?? null, video ?? null)
}
