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
  }>
}

export interface SourcesSummary {
  meetings: Array<{ id: string; durationSec: number | null; attended: boolean }>
  aiCalls: Array<{ conversationId: string; durationSecs: number; hasTranscript: boolean }>
  captures: Array<{ id: string; mode: string; hasTranscript: boolean }>
}

async function fetchElevenLabsConversation(apiKey: string, conversationId: string) {
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`, {
      headers: { 'xi-api-key': apiKey },
    })
    if (!res.ok) return null
    const data = await res.json()
    return {
      conversationId,
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
): Promise<{ material: GatheredMaterial; sources: SourcesSummary } | null> {
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

  // Resolve ElevenLabs API key once. Missing key means we silently skip AI
  // call transcripts — the eval still runs against captures + meetings.
  const platformKey = await prisma.platformSetting.findUnique({ where: { key: 'elevenlabs_api_key' } })
  const apiKey = platformKey?.value || null

  // Collect every conversation id across all AICallCandidate rows attached to
  // this session, dedup, then fetch in parallel.
  const conversationIds = Array.from(
    new Set(session.aiCallCandidates.flatMap((c) => c.conversationIds)),
  )
  const aiCalls = apiKey
    ? (await Promise.all(conversationIds.map((cid) => fetchElevenLabsConversation(apiKey, cid))))
        .filter((c): c is NonNullable<typeof c> => c !== null)
    : []

  const captures = session.captureResponses.map((c) => ({
    id: c.id,
    mode: c.mode,
    prompt: c.prompt,
    durationSec: c.durationSec,
    transcript: c.transcript,
    aiSummary: c.aiSummary,
  }))

  const meetings = session.interviewMeetings.map((m) => ({
    id: m.id,
    scheduledStart: m.scheduledStart.toISOString(),
    scheduledEnd: m.scheduledEnd.toISOString(),
    actualStart: m.actualStart?.toISOString() ?? null,
    actualEnd: m.actualEnd?.toISOString() ?? null,
    participants: Array.isArray(m.participants) ? (m.participants as any[]) : [],
    recordingState: m.recordingState,
    transcriptState: m.transcriptState,
  }))

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

  return { material, sources }
}
