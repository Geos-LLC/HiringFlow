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
import { extractFramesFromBuffer } from './video-frames'

// Voice observation runs in TWO stages because audio-capable OpenAI models
// (`gpt-audio`, `gpt-audio-mini`) DO NOT accept any response_format param —
// not json_schema, not even json_object. `gpt-4o-audio-preview` is also a
// 404 on current accounts. Stage 1: the audio model produces a free-form
// observation in a known headed layout. Stage 2: gpt-4o-mini re-shapes
// that text into the strict JSON the rest of the engine consumes.
const VOICE_AUDIO_MODEL = 'gpt-audio-mini'
const VOICE_STRUCTURE_MODEL = 'gpt-4o-mini'
const VIDEO_MODEL = 'gpt-4o'
// Bumped to invalidate the silent-failure shape stored against the previous
// VOICE_MODEL constant. Old cache entries for those keys are stale forever
// because nothing produces them anymore — they just don't match.
const ANALYSIS_VERSION = 2

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

const VOICE_AUDIO_SYSTEM_PROMPT = `You observe a candidate audio recording for a hiring manager. Report DESCRIPTIVE observations only — pace, clarity, hesitation, energy, articulation. Each observation is one short sentence with neutral language. Never make claims about trustworthiness, honesty, attractiveness, intelligence, age, or personality. Never invent content not present in the audio. If the audio is silent or too short to assess a dimension, say so plainly.

Output your observation in this exact shape (plain text, no code fences):

Pace: <one sentence>
Clarity: <one sentence>
Hesitation: <one sentence>
Energy: <one sentence>
Articulation: <one sentence>
Evidence:
- <quoted or timestamped moment>
- <quoted or timestamped moment>
- <up to 6 lines>`

const VOICE_STRUCTURE_SYSTEM_PROMPT = `Convert a free-form voice observation into strict JSON. Preserve every observation verbatim — DO NOT paraphrase, summarize, or re-write. If the input names a dimension as "no audible content" / "silent" / "too short", carry that phrasing into the corresponding field.`

/**
 * Two-stage voice observation:
 *   1. gpt-audio-mini receives the actual audio and outputs a headed text
 *      block (audio models cannot use json_schema or json_object).
 *   2. gpt-4o-mini re-shapes that text into strict JSON.
 *
 * The result is cached per (workspace, asset, kind, model, version). Errors
 * propagate up with a real reason so the recruiter can see what failed —
 * silent nulls hid the entire pipeline being broken for hours.
 */
async function observeVoiceClip(
  workspaceId: string,
  input: VoiceClipInput,
): Promise<VoiceClipObservation> {
  // Cache lookup keyed by the audio model — re-runs against the same clip
  // skip both API calls.
  const cached = await prisma.mediaAnalysisCache.findUnique({
    where: {
      workspaceId_assetType_assetId_kind_model_analysisVersion: {
        workspaceId,
        assetType: input.assetType,
        assetId: input.assetId,
        kind: 'voice',
        model: VOICE_AUDIO_MODEL,
        analysisVersion: ANALYSIS_VERSION,
      },
    },
  })
  if (cached) return cached.result as unknown as VoiceClipObservation

  const audio = await fetchAudioBytes(input)
  if (!audio) {
    throw new Error(
      input.source.kind === 's3'
        ? `Audio fetch failed (S3 key=${input.source.storageKey.slice(-32)})`
        : 'Audio fetch failed (URL refused or exceeded size cap)',
    )
  }

  // Stage 1: free-form headed text from the audio model.
  const audioCompletion = await openai.chat.completions.create({
    model: VOICE_AUDIO_MODEL,
    modalities: ['text'],
    messages: [
      { role: 'system', content: VOICE_AUDIO_SYSTEM_PROMPT },
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
            text: `Asset type: ${input.assetType}. Asset id: ${input.assetId}. Duration: ${input.durationSec ?? 'unknown'}s. Observe the candidate's voice and respond in the required shape.`,
          },
        ],
      },
    ],
  })
  const audioText = audioCompletion.choices[0]?.message?.content
  if (!audioText) throw new Error('Audio model returned an empty response')

  // Stage 2: strict-JSON reshape with a text model.
  const structureCompletion = await openai.chat.completions.create({
    model: VOICE_STRUCTURE_MODEL,
    temperature: 0,
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
            pace: { type: 'string' },
            clarity: { type: 'string' },
            hesitation: { type: 'string' },
            energy: { type: 'string' },
            articulation: { type: 'string' },
            evidence: {
              type: 'array',
              minItems: 0,
              maxItems: 6,
              items: { type: 'string' },
            },
          },
        },
      },
    },
    messages: [
      { role: 'system', content: VOICE_STRUCTURE_SYSTEM_PROMPT },
      { role: 'user', content: audioText },
    ],
  })
  const raw = structureCompletion.choices[0]?.message?.content
  if (!raw) throw new Error('Structure model returned an empty response')
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
      model: VOICE_AUDIO_MODEL,
      analysisVersion: ANALYSIS_VERSION,
      result: result as any,
      durationSec: input.durationSec,
    },
  })

  return result
}

export async function observeVoice(
  workspaceId: string,
  clips: VoiceClipInput[],
): Promise<VoiceObservationResult> {
  if (clips.length === 0) {
    return { clips: [], summary: 'No audio clips were available to observe.' }
  }

  const observed: VoiceClipObservation[] = []
  // Track per-clip errors so we surface ACTUAL failure reasons instead of
  // collapsing every miss into "could not complete". The summary previously
  // hid a 404 model name for hours.
  const failures: string[] = []
  for (const clip of clips) {
    try {
      const r = await observeVoiceClip(workspaceId, clip)
      observed.push(r)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error('[media-observation] voice clip failed', { assetId: clip.assetId, reason })
      failures.push(`${clip.assetType}/${clip.assetId.slice(0, 10)}: ${reason}`)
    }
  }

  if (observed.length === 0) {
    return {
      clips: [],
      summary:
        `Voice observation could not complete for any of the ${clips.length} clip${clips.length === 1 ? '' : 's'}. Failures: ` +
        failures.slice(0, 5).join('; '),
    }
  }

  const summary = await summarizeMediaObservations(observed, 'voice')
  const tail = failures.length > 0 ? ` ${failures.length} clip${failures.length === 1 ? '' : 's'} failed: ${failures.slice(0, 3).join('; ')}` : ''
  return { clips: observed, summary: `${summary}${tail}` }
}

async function fetchVideoBytes(input: VideoClipInput): Promise<Buffer | null> {
  try {
    if (input.source.kind === 's3') {
      const buf = await s3Download(input.source.storageKey)
      if (!buf) return null
      return Buffer.from(buf)
    }
    const res = await fetch(input.source.url, { headers: input.source.headers })
    if (!res.ok) return null
    const arr = new Uint8Array(await res.arrayBuffer())
    return Buffer.from(arr)
  } catch {
    return null
  }
}

/**
 * Observe one video clip. Downloads the source, extracts evenly-spaced
 * frames via ffmpeg-static, sends them to gpt-4o vision, and returns a
 * structured descriptive observation. Cached the same way as voice.
 *
 * Frame-based observations only — pace/clarity/etc. live on voice. Here we
 * stick to what's visible: camera presence, presentation, engagement.
 */
async function observeVideoClip(
  workspaceId: string,
  input: VideoClipInput,
): Promise<VideoClipObservation | null> {
  const cached = await prisma.mediaAnalysisCache.findUnique({
    where: {
      workspaceId_assetType_assetId_kind_model_analysisVersion: {
        workspaceId,
        assetType: input.assetType,
        assetId: input.assetId,
        kind: 'video',
        model: VIDEO_MODEL,
        analysisVersion: ANALYSIS_VERSION,
      },
    },
  })
  if (cached) return cached.result as unknown as VideoClipObservation

  const videoBytes = await fetchVideoBytes(input)
  if (!videoBytes) return null

  const frames = await extractFramesFromBuffer(videoBytes, input.durationSec)
  if (!frames || frames.length === 0) return null

  try {
    const completion = await openai.chat.completions.create({
      model: VIDEO_MODEL,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'video_observation',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['cameraPresence', 'presentation', 'engagement', 'evidence'],
            properties: {
              cameraPresence: { type: 'string', description: 'One short sentence: framing, eye contact, posture, distance to camera.' },
              presentation: { type: 'string', description: 'One short sentence: visible setting, lighting, attire — observational only.' },
              engagement: { type: 'string', description: 'One short sentence: gestures, facial activity, attentiveness signals visible in the frames.' },
              evidence: {
                type: 'array',
                minItems: 1,
                maxItems: 6,
                items: { type: 'string' },
                description: 'Reference specific frame timestamps (e.g. "at 4.5s") for each observation.',
              },
            },
          },
        },
      },
      messages: [
        {
          role: 'system',
          content:
            'You observe sampled frames from a candidate video for a hiring manager. Report DESCRIPTIVE observations only — camera presence, presentation, engagement. Each observation is one short sentence with neutral language. Never make claims about trustworthiness, honesty, attractiveness, intelligence, age, race, gender, or personality. Never invent content not present in the frames. If a frame is dark, blurry, or absent, say so plainly rather than guessing.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Asset type: ${input.assetType}. Asset id: ${input.assetId}. Duration: ${input.durationSec ?? 'unknown'}s. ${frames.length} frames sampled at evenly-spaced timestamps. Describe what you observe.`,
            },
            ...frames.map((f) => ({
              type: 'image_url' as const,
              image_url: {
                url: `data:${f.mimeType};base64,${f.base64}`,
                detail: 'low' as const,
              },
            })),
          ],
        },
      ],
    })

    const raw = completion.choices[0]?.message?.content
    if (!raw) return null
    const parsed = JSON.parse(raw) as Omit<VideoClipObservation, 'assetType' | 'assetId' | 'durationSec'>
    const result: VideoClipObservation = {
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
        kind: 'video',
        model: VIDEO_MODEL,
        analysisVersion: ANALYSIS_VERSION,
        result: result as any,
        durationSec: input.durationSec,
      },
    })

    return result
  } catch (err) {
    console.error('[media-observation] video clip failed', { assetId: input.assetId, err: (err as Error).message })
    return null
  }
}

export async function observeVideo(
  workspaceId: string,
  clips: VideoClipInput[],
): Promise<VideoObservationResult> {
  if (clips.length === 0) {
    return {
      clips: [],
      summary: '',
      unavailableReason: 'No video clips were available for this candidate.',
    }
  }

  const observed: VideoClipObservation[] = []
  for (const clip of clips) {
    const r = await observeVideoClip(workspaceId, clip)
    if (r) observed.push(r)
  }

  if (observed.length === 0) {
    return {
      clips: [],
      summary: '',
      unavailableReason:
        'Video clips were present but frame extraction or vision-model observation failed for all of them.',
    }
  }

  const summary = await summarizeMediaObservations(observed, 'video')
  return { clips: observed, summary }
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
