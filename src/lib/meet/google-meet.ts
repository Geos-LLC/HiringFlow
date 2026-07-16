/**
 * Google Meet REST API v2 client.
 *
 * Uses raw fetch rather than the googleapis typed client because the Meet v2
 * types lag the REST surface (spaces.create, spaces.patch with
 * artifactConfig.recordingConfig, conferenceRecords.list). Bearer token is
 * pulled from the workspace's OAuth2 client so token refresh still runs
 * through googleapis' auto-refresh.
 *
 * Every function that calls the Meet API is wrapped so a Meet API failure
 * bubbles up as a typed MeetApiError rather than leaking through to the
 * caller. The scheduling route treats MeetApiError as a non-fatal failure
 * (falls back to scheduling without recording, etc.) so Meet API outages do
 * not break the rest of the app.
 */

import type { OAuth2Client } from 'google-auth-library'
import { getAuthedClientForWorkspace } from '../google'

const MEET_V2_BASE = 'https://meet.googleapis.com/v2'

export type RecordingGeneration = 'ON' | 'OFF'
export type AccessType = 'OPEN' | 'TRUSTED' | 'RESTRICTED'
export type EntryPointAccess = 'ALL' | 'CREATOR_APP_ONLY'

export interface MeetSpace {
  name: string              // "spaces/<id>"
  meetingUri: string        // "https://meet.google.com/abc-defg-hij"
  meetingCode: string       // "abc-defg-hij"
  config?: {
    accessType?: AccessType
    entryPointAccess?: EntryPointAccess
    artifactConfig?: {
      recordingConfig?: { autoRecordingGeneration?: RecordingGeneration }
      transcriptionConfig?: { autoTranscriptionGeneration?: RecordingGeneration }
    }
  }
}

export interface ConferenceRecord {
  name: string              // "conferenceRecords/<id>"
  startTime?: string
  endTime?: string
  space?: string
}

export interface Recording {
  name: string              // "conferenceRecords/<id>/recordings/<id>"
  driveDestination?: {
    file?: string           // Drive file ID
    exportUri?: string
  }
  state?: string
  startTime?: string
  endTime?: string
}

export interface Transcript {
  name: string
  docsDestination?: {
    document?: string       // Google Docs doc ID
    exportUri?: string
  }
  state?: string
  startTime?: string
  endTime?: string
}

export class MeetApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly details: unknown
  readonly reason: string | undefined
  constructor(status: number, message: string, details?: unknown, code?: string, reason?: string) {
    super(message)
    this.name = 'MeetApiError'
    this.status = status
    this.details = details
    this.code = code
    this.reason = reason
  }

  /**
   * Best-effort classification of a 403 into a known recording-capability
   * reason. Google's error messages are not stable, so this is intentionally
   * lenient — anything we can't classify becomes 'permission_denied_other'.
   */
  get recordingReason(): 'permission_denied_plan' | 'permission_denied_admin_policy' | 'permission_denied_other' | null {
    if (this.status !== 403) return null
    const hay = `${this.message} ${this.reason ?? ''} ${JSON.stringify(this.details ?? {})}`.toLowerCase()
    if (/admin|policy|workspace admin|organization/.test(hay)) return 'permission_denied_admin_policy'
    if (/plan|license|not supported|upgrade|not available|tier/.test(hay)) return 'permission_denied_plan'
    return 'permission_denied_other'
  }
}

async function accessToken(client: OAuth2Client): Promise<string> {
  const res = await client.getAccessToken()
  if (!res?.token) throw new MeetApiError(401, 'No access token available')
  return res.token
}

async function meetFetch<T>(
  client: OAuth2Client,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await accessToken(client)
  const res = await fetch(`${MEET_V2_BASE}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  if (!res.ok) {
    let body: unknown = undefined
    try { body = await res.json() } catch { /* ignore */ }
    const errObj = (body as { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } })?.error
    const msg = errObj?.message || res.statusText || 'Meet API error'
    const reason = errObj?.details?.[0]?.reason
    throw new MeetApiError(res.status, msg, body, errObj?.status, reason)
  }
  // Some endpoints (DELETE) return no body.
  if (res.status === 204) return undefined as unknown as T
  return res.json() as Promise<T>
}

// ---------- spaces ----------

export async function createSpace(
  client: OAuth2Client,
  opts: {
    accessType?: AccessType
    entryPointAccess?: EntryPointAccess
    autoRecording?: RecordingGeneration
    autoTranscription?: RecordingGeneration
  } = {},
): Promise<MeetSpace> {
  const body: Record<string, unknown> = {
    config: {
      accessType: opts.accessType || 'TRUSTED',
      entryPointAccess: opts.entryPointAccess || 'ALL',
      artifactConfig: {
        recordingConfig: { autoRecordingGeneration: opts.autoRecording || 'OFF' },
        transcriptionConfig: { autoTranscriptionGeneration: opts.autoTranscription || 'OFF' },
      },
    },
  }
  return meetFetch<MeetSpace>(client, '/spaces', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getSpace(client: OAuth2Client, spaceName: string): Promise<MeetSpace> {
  const path = spaceName.startsWith('spaces/') ? spaceName : `spaces/${spaceName}`
  return meetFetch<MeetSpace>(client, `/${path}`)
}

/**
 * Look up a Meet space by its meeting code (e.g. "abc-defg-hij" from
 * https://meet.google.com/abc-defg-hij). Used to adopt externally-created
 * Meet spaces (Calendly, direct calendar invites) into our InterviewMeeting
 * table so the webhook + recording flow work for them too.
 *
 * Only succeeds if the caller has access to the space (they must own or have
 * joined it). Throws MeetApiError on 403/404 otherwise.
 */
export async function getSpaceByMeetingCode(client: OAuth2Client, meetingCode: string): Promise<MeetSpace> {
  // The Meet v2 API accepts the meeting code in place of the numeric space id.
  return meetFetch<MeetSpace>(client, `/spaces/${encodeURIComponent(meetingCode)}`)
}

/**
 * Extract the meeting code from a Google Meet URL.
 *   https://meet.google.com/abc-defg-hij        -> "abc-defg-hij"
 *   https://meet.google.com/abc-defg-hij?auth=1 -> "abc-defg-hij"
 *   https://meet.google.com/lookup/xxx          -> null (lookup links are unsupported)
 */
export function parseMeetingCodeFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/i)
  return m ? m[1].toLowerCase() : null
}

export async function updateSpaceSettings(
  client: OAuth2Client,
  spaceName: string,
  patch: {
    autoRecording?: RecordingGeneration
    autoTranscription?: RecordingGeneration
    accessType?: AccessType
  },
): Promise<MeetSpace> {
  const path = spaceName.startsWith('spaces/') ? spaceName : `spaces/${spaceName}`
  const updateMask: string[] = []
  const config: Record<string, unknown> = {}
  if (patch.accessType) {
    config.accessType = patch.accessType
    updateMask.push('config.accessType')
  }
  const artifactConfig: Record<string, unknown> = {}
  if (patch.autoRecording) {
    artifactConfig.recordingConfig = { autoRecordingGeneration: patch.autoRecording }
    updateMask.push('config.artifactConfig.recordingConfig.autoRecordingGeneration')
  }
  if (patch.autoTranscription) {
    artifactConfig.transcriptionConfig = { autoTranscriptionGeneration: patch.autoTranscription }
    updateMask.push('config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration')
  }
  if (Object.keys(artifactConfig).length) config.artifactConfig = artifactConfig
  const qs = `?updateMask=${encodeURIComponent(updateMask.join(','))}`
  return meetFetch<MeetSpace>(client, `/${path}${qs}`, {
    method: 'PATCH',
    body: JSON.stringify({ config }),
  })
}

export async function endActiveConference(client: OAuth2Client, spaceName: string): Promise<void> {
  const path = spaceName.startsWith('spaces/') ? spaceName : `spaces/${spaceName}`
  await meetFetch<void>(client, `/${path}:endActiveConference`, { method: 'POST', body: '{}' })
}

// ---------- spaces.members (cohost management) ----------
//
// Meet v2 space members. Assigning a workspace teammate the COHOST role lets
// them start the meeting, admit knockers, and end for all — the powers that
// otherwise only belong to the space owner (the workspace's connected Google
// account). Without this, an assigned host on the calendar can join but can't
// actually run the meeting.

export type MemberRole = 'ROLE_UNSPECIFIED' | 'COHOST'

export interface SpaceMember {
  name: string        // "spaces/{space}/members/{member}"
  email?: string
  role?: MemberRole
}

export async function createSpaceMember(
  client: OAuth2Client,
  spaceName: string,
  email: string,
  role: MemberRole = 'COHOST',
): Promise<SpaceMember> {
  const path = spaceName.startsWith('spaces/') ? spaceName : `spaces/${spaceName}`
  return meetFetch<SpaceMember>(client, `/${path}/members`, {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  })
}

export async function listSpaceMembers(
  client: OAuth2Client,
  spaceName: string,
): Promise<SpaceMember[]> {
  const path = spaceName.startsWith('spaces/') ? spaceName : `spaces/${spaceName}`
  const all: SpaceMember[] = []
  let pageToken: string | undefined
  do {
    const qs = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''
    const body = await meetFetch<{ members?: SpaceMember[]; nextPageToken?: string }>(
      client,
      `/${path}/members${qs}`,
    )
    if (body.members) all.push(...body.members)
    pageToken = body.nextPageToken
  } while (pageToken)
  return all
}

export async function deleteSpaceMember(
  client: OAuth2Client,
  memberName: string,
): Promise<void> {
  const path = memberName.startsWith('spaces/') ? memberName : `spaces/${memberName}`
  await meetFetch<void>(client, `/${path}`, { method: 'DELETE' })
}

// ---------- conferenceRecords ----------

export async function listConferenceRecords(
  client: OAuth2Client,
  spaceName: string,
): Promise<ConferenceRecord[]> {
  const filter = encodeURIComponent(`space.name="${spaceName}"`)
  const body = await meetFetch<{ conferenceRecords?: ConferenceRecord[] }>(
    client,
    `/conferenceRecords?filter=${filter}`,
  )
  return body.conferenceRecords || []
}

export async function listRecordings(
  client: OAuth2Client,
  conferenceRecordName: string,
): Promise<Recording[]> {
  const body = await meetFetch<{ recordings?: Recording[] }>(
    client,
    `/${conferenceRecordName}/recordings`,
  )
  return body.recordings || []
}

export async function listTranscripts(
  client: OAuth2Client,
  conferenceRecordName: string,
): Promise<Transcript[]> {
  const body = await meetFetch<{ transcripts?: Transcript[] }>(
    client,
    `/${conferenceRecordName}/transcripts`,
  )
  return body.transcripts || []
}

export interface Participant {
  name?: string
  earliestStartTime?: string
  latestEndTime?: string
  signedinUser?: { user?: string; displayName?: string }
  anonymousUser?: { displayName?: string }
  phoneUser?: { displayName?: string }
}

/**
 * List all participants on a conference record, paging through every result.
 * Used by the on-read sync path so we can compute no-show / attendance from
 * Meet API directly when Workspace Events isn't delivering (personal Gmail
 * accounts, scope verification gap, etc.).
 */
export async function listParticipants(
  client: OAuth2Client,
  conferenceRecordName: string,
): Promise<Participant[]> {
  const all: Participant[] = []
  let pageToken: string | undefined
  do {
    const qs = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''
    const body = await meetFetch<{ participants?: Participant[]; nextPageToken?: string }>(
      client,
      `/${conferenceRecordName}/participants${qs}`,
    )
    if (body.participants) all.push(...body.participants)
    pageToken = body.nextPageToken
  } while (pageToken)
  return all
}

// ---------- workspace-scoped helpers ----------

/**
 * Thin wrapper that pulls the authed OAuth client for a workspace and invokes
 * a Meet operation. Returns null on integration-not-found so callers can treat
 * "no Meet integration" as a graceful no-op instead of an error.
 */
export async function withWorkspaceMeetClient<T>(
  workspaceId: string,
  fn: (client: OAuth2Client) => Promise<T>,
): Promise<T | null> {
  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) return null
  return fn(authed.client)
}
