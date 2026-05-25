/**
 * Recall.ai REST client.
 *
 * Recall.ai sends a recording bot into a Google Meet call as a regular
 * participant. The bot receives audio/video + participant signaling via Meet's
 * normal WebRTC channels — no chrome extension required, no Meet
 * auto-record dependency. We use it to replace both attendance tracking
 * (Workspace Events + chrome ext scraping) and meeting recording (Meet
 * native auto-record, which silently stops when the host is alone — see
 * project_meet_premature_noshow).
 *
 * Auth: `Authorization: Token <RECALL_API_KEY>` header. API key is per
 * region; the region is fixed at the env level since each region has its
 * own base URL. Default us-east-1.
 *
 * All functions throw RecallApiError on non-2xx, so callers can treat Recall
 * failures uniformly (typically: log + fall back to legacy attendance path
 * for that meeting, never fail the booking).
 */

const REGION_BASE_URLS: Record<string, string> = {
  'us-east-1': 'https://us-east-1.recall.ai',
  'us-west-2': 'https://us-west-2.recall.ai',
  'eu-central-1': 'https://eu-central-1.recall.ai',
  'ap-northeast-1': 'https://ap-northeast-1.recall.ai',
}

function baseUrl(): string {
  const region = process.env.RECALL_REGION || 'us-east-1'
  const url = REGION_BASE_URLS[region]
  if (!url) throw new RecallApiError(0, `Unknown RECALL_REGION '${region}'`)
  return url
}

function authHeader(): string {
  const key = process.env.RECALL_API_KEY
  if (!key) throw new RecallApiError(0, 'RECALL_API_KEY is not set')
  return `Token ${key}`
}

export class RecallApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'RecallApiError'
    this.status = status
    this.body = body
  }
}

async function recallFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  if (!res.ok) {
    let body: unknown = undefined
    try { body = await res.json() } catch { /* ignore */ }
    const msg = typeof body === 'object' && body && 'detail' in body
      ? String((body as { detail?: unknown }).detail)
      : res.statusText || 'Recall API error'
    throw new RecallApiError(res.status, msg, body)
  }
  if (res.status === 204) return undefined as unknown as T
  return res.json() as Promise<T>
}

// ============ Bot lifecycle ============

export interface ScheduleBotInput {
  meetingUrl: string
  joinAt: Date
  /**
   * Display name shown to other participants in the Meet UI. Default is a
   * neutral "Interview Notes" so candidates don't see vendor branding.
   */
  botName?: string
  /**
   * Free-form key/value metadata. Recall echoes this back in every webhook
   * event for the bot. We stash { interviewMeetingId, workspaceId } so the
   * webhook handler can resolve the row without a separate lookup.
   */
  metadata?: Record<string, string>
}

export interface ScheduledBot {
  id: string
  meeting_url?: { meeting_id?: string; platform?: string }
  bot_name?: string
  status_changes?: Array<{ code: string; created_at: string; message?: string }>
  recordings?: Array<RecordingSummary>
  metadata?: Record<string, string>
  join_at?: string
}

export interface RecordingSummary {
  id: string
  started_at?: string
  completed_at?: string
  media_shortcuts?: {
    video_mixed?: { data?: { download_url?: string } }
    audio_mixed?: { data?: { download_url?: string } }
    transcript?: { data?: { download_url?: string } }
  }
}

/**
 * Schedule a bot to join the Meet at `joinAt`. Recall requires `join_at` to
 * be at least 10 minutes in the future for scheduled bots; for meetings that
 * start sooner, the bot is created immediately (no `join_at`) and joins as
 * soon as Recall provisions it. Caller is responsible for that timing call.
 */
export async function scheduleBot(input: ScheduleBotInput): Promise<ScheduledBot> {
  const body: Record<string, unknown> = {
    meeting_url: input.meetingUrl,
    bot_name: input.botName || process.env.RECALL_BOT_NAME || 'Interview Notes',
    // Capture both audio+video + participant events. The recording_config
    // schema accepts a record of "shortcut" media keys; we want
    // video+audio+transcript so the recruiter can play back the call.
    recording_config: {
      transcript: { provider: { recallai_streaming: {} } },
      video_mixed_layout: 'speaker_view',
      // Including participant_events here makes participant join/leave
      // information accessible from GET /api/v1/bot/{id}/recording at the
      // end of the call. Real-time participant webhooks would require a
      // websocket endpoint; we don't need real-time for HF (we read the
      // final state on bot.done).
      participant_events: { type: 'json' },
    },
  }
  if (input.metadata) body.metadata = input.metadata
  // Only attach join_at when the bot is at least 10 min out — Recall rejects
  // a join_at that's <10 min from now. Calls landing inside the 10-min
  // window are dispatched immediately.
  const tenMinFromNow = Date.now() + 10 * 60 * 1000
  if (input.joinAt.getTime() > tenMinFromNow) {
    body.join_at = input.joinAt.toISOString()
  }
  return recallFetch<ScheduledBot>('/api/v1/bot/', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getBot(botId: string): Promise<ScheduledBot> {
  return recallFetch<ScheduledBot>(`/api/v1/bot/${encodeURIComponent(botId)}/`)
}

/**
 * Cancel a scheduled bot. Used when an InterviewMeeting is cancelled or
 * rescheduled (we tear down the old bot and schedule a new one for the new
 * time). No-op if the bot has already joined the call.
 */
export async function deleteBot(botId: string): Promise<void> {
  await recallFetch<void>(`/api/v1/bot/${encodeURIComponent(botId)}/`, {
    method: 'DELETE',
  })
}

// ============ Participant retrieval ============

export interface RecallParticipant {
  id: number
  name?: string
  is_host?: boolean
  platform?: string
  extra_data?: { email?: string; user_id?: string }
  events?: Array<{ code: string; created_at: string }>
}

/**
 * Pulls every participant Recall saw in the meeting, paginated. Returns
 * each row with the latest known display name, host flag, and event log
 * (join / leave timestamps). The handler maps this into our
 * InterviewMeeting.participants[] shape and decides actualStart/End.
 */
interface ParticipantsPage {
  results: RecallParticipant[]
  next: string | null
}

export async function listBotParticipants(botId: string): Promise<RecallParticipant[]> {
  const all: RecallParticipant[] = []
  let cursor: string | null = `/api/v1/bot/${encodeURIComponent(botId)}/participants/`
  while (cursor) {
    const body: ParticipantsPage = await recallFetch<ParticipantsPage>(cursor)
    if (body.results) all.push(...body.results)
    cursor = body.next ? body.next.replace(baseUrl(), '') : null
  }
  return all
}
