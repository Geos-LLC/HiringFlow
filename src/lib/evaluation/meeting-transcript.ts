/**
 * Meeting transcript fetcher for the candidate evaluation engine.
 *
 * Pulls plain-text transcripts for interview meetings so the scorer can read
 * what the candidate actually said in a recorded interview — instead of only
 * seeing attendance metadata ("she showed up for 19 min"). Tries the sources
 * we have in priority order:
 *
 *   1. Recall.ai recording transcript (when the meeting was recorded via the
 *      Recall bot — `recallRecordingId` is set on InterviewMeeting). Recall
 *      provides a download URL on the recording's `media_shortcuts.transcript`.
 *      The downloaded file is JSON with per-segment speaker + text.
 *
 *   2. Drive transcript file (when Meet/Workspace Events captured a Gemini
 *      transcript — `driveTranscriptFileId` set). Exported as plain text via
 *      `drive.files.export(mimeType=text/plain)`.
 *
 * Returns the cleaned transcript text + provider tag. Null when neither
 * source is available or the fetch failed. No retries — a transcript fetch
 * failure during eval just means the meeting falls back to attendance
 * metadata for that run.
 */

import { prisma } from '@/lib/prisma'
import { getAuthedClientForWorkspace } from '@/lib/google'
import type { OAuth2Client } from 'google-auth-library'

const RECALL_REGION_BASE: Record<string, string> = {
  'us-east-1': 'https://us-east-1.recall.ai',
  'us-west-2': 'https://us-west-2.recall.ai',
  'eu-central-1': 'https://eu-central-1.recall.ai',
  'ap-northeast-1': 'https://ap-northeast-1.recall.ai',
}

const DRIVE_V3 = 'https://www.googleapis.com/drive/v3'

export interface MeetingTranscriptResult {
  text: string
  source: 'recall' | 'drive'
  provider: string
}

export async function fetchMeetingTranscript(meeting: {
  id: string
  workspaceId: string
  recallRecordingId: string | null
  driveTranscriptFileId: string | null
}): Promise<MeetingTranscriptResult | null> {
  if (meeting.recallRecordingId) {
    const recall = await tryRecallTranscript(meeting.recallRecordingId)
    if (recall) return recall
  }
  if (meeting.driveTranscriptFileId) {
    const drive = await tryDriveTranscript(meeting.workspaceId, meeting.driveTranscriptFileId)
    if (drive) return drive
  }
  return null
}

// ---------- Recall.ai ----------

interface RecallRecordingDetail {
  id: string
  media_shortcuts?: {
    transcript?: { data?: { download_url?: string; format?: string } }
  }
}

function recallBase(): string {
  const region = process.env.RECALL_REGION || 'us-east-1'
  return RECALL_REGION_BASE[region] ?? RECALL_REGION_BASE['us-east-1']
}

async function tryRecallTranscript(recordingId: string): Promise<MeetingTranscriptResult | null> {
  const apiKey = process.env.RECALL_API_KEY
  if (!apiKey) return null
  try {
    const detailRes = await fetch(`${recallBase()}/api/v1/recording/${encodeURIComponent(recordingId)}/`, {
      headers: { Authorization: `Token ${apiKey}` },
    })
    if (!detailRes.ok) return null
    const detail = (await detailRes.json()) as RecallRecordingDetail
    const downloadUrl = detail.media_shortcuts?.transcript?.data?.download_url
    if (!downloadUrl) return null

    const dlRes = await fetch(downloadUrl)
    if (!dlRes.ok) return null
    const raw = await dlRes.text()

    return { text: normalizeRecallTranscript(raw), source: 'recall', provider: 'recallai' }
  } catch (err) {
    console.error('[meeting-transcript] recall fetch failed', { recordingId, err: (err as Error).message })
    return null
  }
}

/**
 * Recall delivers transcripts as JSON per segment by default
 * (`[{ words: [{text, start, end, speaker}] }, ...]`) — but the shape varies
 * by provider. We try to reduce any reasonable shape to "Speaker: text" lines
 * and fall back to the raw body when it's already plain text.
 */
function normalizeRecallTranscript(raw: string): string {
  // Already plain text — Recall provider can be plain.
  if (!raw.trim().startsWith('[') && !raw.trim().startsWith('{')) {
    return raw.trim()
  }
  try {
    const parsed = JSON.parse(raw)
    const segments: string[] = []
    if (Array.isArray(parsed)) {
      for (const seg of parsed) {
        if (!seg) continue
        const words: any[] = Array.isArray(seg.words) ? seg.words : []
        const speaker = seg.speaker ?? seg.participant?.name ?? 'Speaker'
        const text = words.length > 0
          ? words.map((w) => w.text ?? '').join(' ').trim()
          : (seg.text ?? '').trim()
        if (text) segments.push(`${speaker}: ${text}`)
      }
    }
    if (segments.length > 0) return segments.join('\n')
  } catch {
    /* fall through */
  }
  // Could not parse — return raw (up to a cap so the prompt doesn't explode).
  return raw.slice(0, 60_000)
}

// ---------- Google Drive ----------

async function tryDriveTranscript(
  workspaceId: string,
  fileId: string,
): Promise<MeetingTranscriptResult | null> {
  try {
    const authed = await getAuthedClientForWorkspace(workspaceId)
    if (!authed) return null
    const text = await exportDriveDocAsText(authed.client, fileId)
    if (!text) return null
    return { text: text.trim(), source: 'drive', provider: 'google_meet_gemini' }
  } catch (err) {
    console.error('[meeting-transcript] drive fetch failed', { fileId, err: (err as Error).message })
    return null
  }
}

async function exportDriveDocAsText(client: OAuth2Client, fileId: string): Promise<string | null> {
  const tok = await client.getAccessToken()
  if (!tok?.token) return null
  const res = await fetch(
    `${DRIVE_V3}/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${tok.token}` } },
  )
  if (!res.ok) {
    // Fall back to alt=media for non-Doc files (e.g. .txt files Recall might have written).
    const altRes = await fetch(`${DRIVE_V3}/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    })
    if (!altRes.ok) return null
    return altRes.text()
  }
  return res.text()
}
