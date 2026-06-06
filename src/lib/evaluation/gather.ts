/**
 * Collect every transcript/recording artifact tied to a candidate Session so
 * the evaluator can score against actual material:
 *
 *   1. AI Calls — ElevenLabs conversations bound to AICallCandidate rows that
 *      have sessionId === this session. Pulls each conversation's transcript
 *      via the platform-wide ElevenLabs API key.
 *   2. Captures — CaptureResponse rows with mode in {audio, video, audio_video,
 *      text}. `transcript` column already populated by the existing Deepgram
 *      pipeline; text mode uses the prompt+transcript directly.
 *   3. Meetings — InterviewMeeting metadata (attendance, duration, recording
 *      state). Full transcript text from Drive/Recall isn't fetched yet —
 *      surfaced as metadata only for now, which is enough for the model to
 *      see that the candidate showed up / completed an interview.
 *
 * Returns a normalized envelope the prompt builder uses to render the eval
 * prompt and a `sources` summary persisted on the CandidateEvaluation row.
 */

import { prisma } from '@/lib/prisma'
import { fetchWithEachKey, getElevenLabsApiKeys } from '@/lib/elevenlabs'
import type { VoiceClipInput, VideoClipInput } from './media-observation'
import { fetchMeetingTranscript } from './meeting-transcript'
import { ensureCaptureTranscribed } from './capture-transcription'

export interface GatheredMaterial {
  session: {
    id: string
    candidateName: string | null
    candidateEmail: string | null
    candidatePhone: string | null
    flowName: string | null
    appliedAt: string
    formData: Record<string, string> | null
  }
  aiCalls: Array<{
    conversationId: string
    durationSecs: number
    callSuccessful: string | null
    summary: string | null
    transcript: Array<{ role: string; message: string; timeSecs: number }>
  }>
  captures: Array<{
    id: string
    mode: string
    prompt: string | null
    durationSec: number | null
    transcript: string | null
    aiSummary: string | null
  }>
  meetings: Array<{
    id: string
    scheduledStart: string
    scheduledEnd: string
    actualStart: string | null
    actualEnd: string | null
    participants: Array<{ email?: string; displayName?: string; joinTime?: string; leaveTime?: string }>
    recordingState: string
    transcriptState: string
    // Fetched at gather-time from Recall.ai (recallRecordingId) or Drive
    // (driveTranscriptFileId — Gemini-produced .gdoc). Null when neither
    // source had a transcript or the fetch failed. When non-null, the
    // scoring prompt renders the full text and the meeting counts as
    // evaluable evidence — not just attendance metadata.
    transcript: string | null
    transcriptSource: 'recall' | 'drive' | null
  }>
}

export interface SourcesSummary {
  // Meetings now carry an optional transcript flag. When `hasTranscript` is
  // true, the meeting was a real evaluable source (Recall or Drive transcript
  // was fetched). When false, only attendance metadata reached the scorer.
  meetings: Array<{ id: string; durationSec: number | null; attended: boolean; hasTranscript: boolean; transcriptSource: 'recall' | 'drive' | null }>
  // AI calls carry transcript content when `hasTranscript: true`. The
  // engine only treats true-transcript AI calls as evaluable evidence —
  // empty-transcript conversations are coverage gaps, not sources.
  aiCalls: Array<{ conversationId: string; durationSecs: number; hasTranscript: boolean }>
  // Same rule for captures: a capture without a transcript was uploaded
  // but never processed by the transcription pipeline. UI calls these
  // out as "uploaded but not transcribed" so the recruiter sees the gap.
  captures: Array<{ id: string; mode: string; hasTranscript: boolean }>
}

async function fetchElevenLabsConversation(conversationId: string) {
  try {
    const keys = await getElevenLabsApiKeys()
    let data: any = null
    let apiKey: string | null = null
    for (const k of keys) {
      const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`, {
        headers: { 'xi-api-key': k },
      })
      if (res.ok) { data = await res.json(); apiKey = k; break }
    }
    if (!data || !apiKey) return null
    return {
      conversationId,
      apiKey,
      // Detail endpoint nests duration; mirror the dashboard helper.
      durationSecs: data.metadata?.call_duration_secs ?? data.call_duration_secs ?? 0,
      callSuccessful: data.analysis?.call_successful ?? null,
      summary: data.analysis?.transcript_summary ?? null,
      transcript: Array.isArray(data.transcript)
        ? data.transcript.map((t: any) => ({
            role: String(t.role ?? 'unknown'),
            message: String(t.message ?? ''),
            timeSecs: Number(t.time_in_call_secs ?? 0),
          }))
        : [],
    }
  } catch {
    return null
  }
}

export async function gatherCandidateMaterial(
  sessionId: string,
  workspaceId: string,
): Promise<{
  material: GatheredMaterial
  sources: SourcesSummary
  // Clips eligible for media observation. Same source list as the transcripts
  // but with the storage refs the observer needs (storageKey / signed URL).
  // The eval engine only actually fetches/sends these when includeVoice or
  // includeVideo is set on the request.
  voiceClips: VoiceClipInput[]
  videoClips: VideoClipInput[]
} | null> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, workspaceId },
    include: {
      flow: true,
      interviewMeetings: { where: { cancelledAt: null }, orderBy: { scheduledStart: 'asc' } },
      captureResponses: { where: { status: 'processed' }, orderBy: { createdAt: 'asc' } },
      aiCallCandidates: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!session) return null

  // Resolve ElevenLabs API keys once. Empty list means we silently skip AI
  // call transcripts — the eval still runs against captures + meetings.
  const hasKeys = (await getElevenLabsApiKeys()).length > 0

  // Collect every conversation id across all AICallCandidate rows attached to
  // this session, dedup, then fetch in parallel. fetchElevenLabsConversation
  // tries each configured key, so calls from either account resolve.
  const conversationIds = Array.from(
    new Set(session.aiCallCandidates.flatMap((c) => c.conversationIds)),
  )
  const aiCalls = hasKeys
    ? (await Promise.all(conversationIds.map((cid) => fetchElevenLabsConversation(cid))))
        .filter((c): c is NonNullable<typeof c> => c !== null)
    : []

  const captureRows = session.captureResponses

  // On-demand Deepgram for captures that landed in S3 but never got a
  // transcript. Either the originating flow step had transcription
  // disabled, or the file predates the pipeline. We backfill at gather-
  // time so the scoring prompt sees real candidate words — without this,
  // a self-intro recording is invisible to text scoring and the criteria
  // for it would have to be marked null. Persists back to the row so a
  // re-run doesn't pay Deepgram twice.
  const captures = await Promise.all(
    captureRows.map(async (c) => {
      let transcript = c.transcript
      const needsTranscribe = !transcript?.trim() && !!c.storageKey && (c.mode === 'audio' || c.mode === 'video' || c.mode === 'audio_video')
      if (needsTranscribe) {
        const text = await ensureCaptureTranscribed({
          id: c.id,
          storageKey: c.storageKey,
          mimeType: c.mimeType,
          durationSec: c.durationSec,
        })
        if (text) transcript = text
      }
      return {
        id: c.id,
        mode: c.mode,
        prompt: c.prompt,
        durationSec: c.durationSec,
        transcript,
        aiSummary: c.aiSummary,
      }
    }),
  )

  // Voice + video clips for the observation engine.
  //   - Audio captures (mode='audio') feed voice only.
  //   - Video captures (mode in {video, audio_video}) feed both voice (audio
  //     track) and video (frames).
  //   - AI calls feed voice via the ElevenLabs audio endpoint. Latest call
  //     only — per the product spec ("analyze the latest AI call").
  //   - Meetings: out of scope for the first PR (Recall.ai download dance is
  //     not worth blocking voice MVP on).
  const voiceClips: VoiceClipInput[] = []
  const videoClips: VideoClipInput[] = []

  for (const c of captureRows) {
    if (!c.storageKey || !c.mimeType) continue
    if (c.mode === 'audio') {
      voiceClips.push({
        assetType: 'capture',
        assetId: c.id,
        durationSec: c.durationSec ?? null,
        source: { kind: 's3', storageKey: c.storageKey, mimeType: c.mimeType },
      })
    } else if (c.mode === 'video' || c.mode === 'audio_video') {
      voiceClips.push({
        assetType: 'capture',
        assetId: c.id,
        durationSec: c.durationSec ?? null,
        source: { kind: 's3', storageKey: c.storageKey, mimeType: c.mimeType },
      })
      videoClips.push({
        assetType: 'capture',
        assetId: c.id,
        durationSec: c.durationSec ?? null,
        source: { kind: 's3', storageKey: c.storageKey, mimeType: c.mimeType },
      })
    }
  }

  // EVERY AI call with substantive audio gets a voice clip. Previously we
  // only sampled the latest one — but if a candidate has 7 calls and the
  // last one was a 30s hangup, voice observation would judge them on that
  // tiny sample. Now: send every call that's at least 30s long, capped at
  // the 8 longest so a hyper-active candidate doesn't burn the rate budget.
  if (aiCalls.length > 0) {
    const substantive = aiCalls
      .filter((c) => (c.durationSecs ?? 0) >= 30)
      .sort((a, b) => (b.durationSecs ?? 0) - (a.durationSecs ?? 0))
      .slice(0, 8)
    for (const call of substantive) {
      voiceClips.push({
        assetType: 'ai_call',
        assetId: call.conversationId,
        durationSec: call.durationSecs ?? null,
        source: {
          kind: 'url',
          url: `https://api.elevenlabs.io/v1/convai/conversations/${call.conversationId}/audio`,
          mimeType: 'audio/mpeg',
          // Each conversation belongs to exactly one account; bake the key
          // that successfully fetched the detail so audio download works too.
          headers: { 'xi-api-key': call.apiKey },
        },
      })
    }
  }

  // Meetings — fetch transcripts in parallel from Recall.ai / Drive, then
  // FILTER to only meetings that produced a substantive transcript. Rule
  // per recruiter spec: "we need only meetings with records and where the
  // candidate attended because we analyze transcripts."
  //
  // A transcript exists ⇔ a recording bot or Meet/Gemini was in the room
  // capturing speech. ≥200 chars of content ⇒ real conversation happened
  // (not a 1-min host-only join with no audio). Below the threshold we
  // treat the meeting as "scheduled but unusable for scoring" and drop it
  // from material AND sources entirely.
  const MIN_TRANSCRIPT_CHARS = 200
  const meetingsAll = await Promise.all(
    session.interviewMeetings.map(async (m) => {
      const t = await fetchMeetingTranscript({
        id: m.id,
        workspaceId,
        recallRecordingId: m.recallRecordingId,
        driveTranscriptFileId: m.driveTranscriptFileId,
      })
      return {
        id: m.id,
        scheduledStart: m.scheduledStart.toISOString(),
        scheduledEnd: m.scheduledEnd.toISOString(),
        actualStart: m.actualStart?.toISOString() ?? null,
        actualEnd: m.actualEnd?.toISOString() ?? null,
        participants: Array.isArray(m.participants) ? (m.participants as any[]) : [],
        recordingState: m.recordingState,
        transcriptState: m.transcriptState,
        transcript: t?.text ?? null,
        transcriptSource: t?.source ?? null,
      }
    }),
  )
  const meetings = meetingsAll.filter(
    (m) => !!m.transcript && m.transcript.trim().length >= MIN_TRANSCRIPT_CHARS,
  )

  const material: GatheredMaterial = {
    session: {
      id: session.id,
      candidateName: session.candidateName,
      candidateEmail: session.candidateEmail,
      candidatePhone: session.candidatePhone,
      flowName: session.flow?.name ?? null,
      appliedAt: session.startedAt.toISOString(),
      formData: (session.formData as Record<string, string> | null) ?? null,
    },
    aiCalls,
    captures,
    meetings,
  }

  const sources: SourcesSummary = {
    meetings: meetings.map((m) => ({
      id: m.id,
      durationSec:
        m.actualStart && m.actualEnd
          ? (new Date(m.actualEnd).getTime() - new Date(m.actualStart).getTime()) / 1000
          : null,
      attended: !!m.actualStart,
      hasTranscript: !!m.transcript && m.transcript.trim().length > 0,
      transcriptSource: m.transcriptSource,
    })),
    aiCalls: aiCalls.map((c) => ({
      conversationId: c.conversationId,
      durationSecs: c.durationSecs,
      hasTranscript: c.transcript.length > 0,
    })),
    captures: captures.map((c) => ({
      id: c.id,
      mode: c.mode,
      hasTranscript: !!c.transcript && c.transcript.trim().length > 0,
    })),
  }

  return { material, sources, voiceClips, videoClips }
}
