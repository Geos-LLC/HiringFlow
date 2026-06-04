/**
 * AI media observation — descriptive, evidence-based observations of a
 * candidate's voice and video clips. NOT psychometric measurement.
 *
 * The output is the kind of thing a hiring manager could say after watching
 * the clip themselves: "spoke at steady pace, articulated pricing clearly,
 * brief hesitation when asked about availability." Strictly evidence-based.
 * The schema deliberately excludes anything that could be read as a judgment
 * of trustworthiness, honesty, intelligence, or attractiveness.
 *
 * Two channels:
 *   - voice  → gpt-4o-audio-preview, multimodal audio input. Real audio
 *              data is uploaded; the model returns pace / clarity /
 *              hesitation / energy / articulation observations.
 *   - video  → gpt-4o vision, sample frames as image inputs. Returns
 *              presentation / camera presence / engagement observations.
 *              Frame extraction requires ffmpeg; until that pipeline is
 *              provisioned, video returns a stub with reason='no_frames'.
 *
 * Results are cached in MediaAnalysisCache keyed by (asset, kind, model,
 * analysisVersion) so re-runs on the same recording don't re-charge the
 * model. Recruiter can force-refresh via the "Re-analyze media" button
 * (not shipped in the first PR).
 */

import { openai } from '@/lib/openai'
import { prisma } from '@/lib/prisma'
import { s3Download } from '@/lib/s3'

const VOICE_MODEL = 'gpt-4o-audio-preview'
const VIDEO_MODEL = 'gpt-4o'
const ANALYSIS_VERSION = 1

export type AssetType = 'capture' | 'ai_call' | 'meeting'

export interface VoiceClipObservation {
  assetType: AssetType
  assetId: string
  durationSec: number | null
  pace: string
  clarity: string
  hesitation: string
  energy: string
  articulation: string
  evidence: string[]
}

export interface VideoClipObservation {
  assetType: AssetType
  assetId: string
  durationSec: number | null
  cameraPresence: string
  presentation: string
  engagement: string
  evidence: string[]
}

export interface VoiceObservationResult {
  clips: VoiceClipObservation[]
  summary: string
}

export interface VideoObservationResult {
  clips: VideoClipObservation[]
  summary: string
  // Non-null when no frames could be extracted for any clip. Lets the UI
  // surface "video frame extraction pipeline not provisioned" without
  // silently rendering empty observations.
  unavailableReason?: string
}

export interface VoiceClipInput {
  assetType: AssetType
  assetId: string
  durationSec: number | null
  // One of: 's3' (capture in our bucket), 'url' (ElevenLabs audio, Recall
  // recording). For 's3' we fetch via the AWS SDK; for 'url' we plain fetch.
  source:
    | { kind: 's3'; storageKey: string; mimeType: string }
    | { kind: 'url'; url: string; mimeType?: string; headers?: Record<string, string> }
}

export interface VideoClipInput {
  assetType: AssetType
  assetId: string
  durationSec: number | null
  source:
    | { kind: 's3'; storageKey: string; mimeType: string }
    | { kind: 'url'; url: string; mimeType?: string; headers?: Record<string, string> }
}

// Hard cap so a stray 30-min meeting can't burn $50 of multimodal calls in
// one click. Tuned to fit the typical self-intro recording (≤2 min) plus
// short AI call samples.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024 // ~25 MB — fits ~10 min of mp3

async function fetchAudioBytes(input: VoiceClipInput): Promise<{ data: Buffer; mimeType: string } | null> {
  try {
    if (input.source.kind === 's3') {
      const buf = await s3Download(input.source.storageKey)
      if (!buf) return null
      if (buf.byteLength > MAX_AUDIO_BYTES) return null
      return { data: Buffer.from(buf), mimeType: input.source.mimeType }
    }
    const res = await fetch(input.source.url, {
      headers: input.source.headers,
    })
    if (!res.ok) return null
    const arr = new Uint8Array(await res.arrayBuffer())
    if (arr.byteLength > MAX_AUDIO_BYTES) return null
    return { data: Buffer.from(arr), mimeType: input.source.mimeType ?? res.headers.get('content-type') ?? 'audio/mpeg' }
  } catch {
    return null
  }
}

function mimeToFormat(mime: string): 'mp3' | 'wav' | 'flac' | 'opus' | 'ogg' | 'm4a' | 'webm' | 'mp4' {
  const m = mime.toLowerCase()
  if (m.includes('mp3') || m.includes('mpeg')) return 'mp3'
  if (m.includes('wav')) return 'wav'
  if (m.includes('flac')) return 'flac'
  if (m.includes('opus')) return 'opus'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('m4a')) return 'm4a'
  if (m.includes('webm')) return 'webm'
  return 'mp4'
}

/**
 * Observe one audio clip. Cached by (workspace, asset, kind, model, version)
 * so the second eval on the same recording is free.
 */
async function observeVoiceClip(
  workspaceId: string,
  input: VoiceClipInput,
): Promise<VoiceClipObservation | null> {
  // Cache lookup
  const cached = await prisma.mediaAnalysisCache.findUnique({
    where: {
      workspaceId_assetType_assetId_kind_model_analysisVersion: {
        workspaceId,
        assetType: input.assetType,
        assetId: input.assetId,
        kind: 'voice',
        model: VOICE_MODEL,
        analysisVersion: ANALYSIS_VERSION,
      },
    },
  })
  if (cached) return cached.result as unknown as VoiceClipObservation

  const audio = await fetchAudioBytes(input)
  if (!audio) return null

  try {
    const completion = await openai.chat.completions.create({
      model: VOICE_MODEL,
      modalities: ['text'],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'voice_observation',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['pace', 'clarity', 'hesitation', 'energy', 'articulation', 'evidence'],
            properties: {
              pace: { type: 'string', description: 'One short sentence describing speaking pace.' },
              clarity: { type: 'string', description: 'One short sentence describing diction / intelligibility.' },
              hesitation: { type: 'string', description: 'One short sentence describing pauses / fillers / restarts.' },
              energy: { type: 'string', description: 'One short sentence describing vocal energy / liveliness.' },
              articulation: { type: 'string', description: 'One short sentence describing word formation / pronunciation.' },
              evidence: {
                type: 'array',
                minItems: 1,
                maxItems: 6,
                items: { type: 'string' },
                description: 'Specific timestamped or quoted moments backing the observations.',
              },
            },
          },
        },
      },
      messages: [
        {
          role: 'system',
          content:
            'You observe a candidate audio recording for a hiring manager. Report DESCRIPTIVE observations only — pace, clarity, hesitation, energy, articulation. Each observation is one short sentence with neutral language. Never make claims about trustworthiness, honesty, attractiveness, intelligence, age, or personality. Never invent content not present in the audio. If the audio is silent or too short to assess a dimension, say so plainly.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: audio.data.toString('base64'),
                format: mimeToFormat(audio.mimeType),
              },
            } as any,
            {
              type: 'text',
              text: `Asset type: ${input.assetType}. Asset id: ${input.assetId}. Duration: ${input.durationSec ?? 'unknown'}s. Describe what you observe in the candidate's voice.`,
            },
          ],
        },
      ],
    })

    const raw = completion.choices[0]?.message?.content
    if (!raw) return null
    const parsed = JSON.parse(raw) as Omit<VoiceClipObservation, 'assetType' | 'assetId' | 'durationSec'>
    const result: VoiceClipObservation = {
      assetType: input.assetType,
      assetId: input.assetId,
      durationSec: input.durationSec,
      ...parsed,
    }

    await prisma.mediaAnalysisCache.create({
      data: {
        workspaceId,
        assetType: input.assetType,
        assetId: input.assetId,
        kind: 'voice',
        model: VOICE_MODEL,
        analysisVersion: ANALYSIS_VERSION,
        result: result as any,
        durationSec: input.durationSec,
      },
    })

    return result
  } catch (err) {
    console.error('[media-observation] voice clip failed', { assetId: input.assetId, err: (err as Error).message })
    return null
  }
}

export async function observeVoice(
  workspaceId: string,
  clips: VoiceClipInput[],
): Promise<VoiceObservationResult> {
  if (clips.length === 0) {
    return { clips: [], summary: 'No audio clips were available to observe.' }
  }

  const observed: VoiceClipObservation[] = []
  for (const clip of clips) {
    const r = await observeVoiceClip(workspaceId, clip)
    if (r) observed.push(r)
  }

  if (observed.length === 0) {
    return { clips: [], summary: 'Audio clips were present but observation could not complete (file too large, unreadable, or model error).' }
  }

  // Cheap aggregate summary across clips using the smaller text model.
  const summary = await summarizeMediaObservations(observed, 'voice')

  return { clips: observed, summary }
}

/**
 * Video observation stub. The frame-extraction pipeline (ffmpeg in a Lambda)
 * isn't provisioned yet, so the first PR returns a clearly-labeled
 * unavailable result instead of fabricating frame-based observations. The
 * schema field is preserved so future PRs can populate clips[] without a
 * migration. UI surfaces this as "Video frame extraction not yet available."
 */
export async function observeVideo(
  _workspaceId: string,
  clips: VideoClipInput[],
): Promise<VideoObservationResult> {
  if (clips.length === 0) {
    return {
      clips: [],
      summary: '',
      unavailableReason: 'No video clips were available for this candidate.',
    }
  }
  return {
    clips: [],
    summary: '',
    unavailableReason:
      'Video frame extraction pipeline is not yet provisioned. Voice observation runs from the same recordings; video frame analysis will land in a follow-up PR.',
  }
}

async function summarizeMediaObservations(
  clips: Array<VoiceClipObservation | VideoClipObservation>,
  kind: 'voice' | 'video',
): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `Write a one-paragraph summary of these per-clip ${kind} observations across the candidate's recordings. Stay descriptive and evidence-based — same constraints as the per-clip observations: no claims about trustworthiness, honesty, intelligence, attractiveness, or personality. Reference specific moments only when they were in the input.`,
        },
        { role: 'user', content: JSON.stringify(clips, null, 2) },
      ],
    })
    return completion.choices[0]?.message?.content?.trim() ?? ''
  } catch {
    return ''
  }
}
