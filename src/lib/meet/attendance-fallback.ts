/**
 * Personal-Gmail attendance fallback.
 *
 * Workspace Events Meet API and Meet REST `conferenceRecords` both return
 * nothing for personal `@gmail.com` and Workspace Individual accounts (
 * verified 2026-04-30 / 2026-05-04). To advance the candidate card past
 * "Meeting scheduled" on those tenants, we derive a "meeting happened"
 * signal from "Notes by Gemini" Google Docs that Meet auto-creates when
 * `autoSmartNotesGeneration` is on (the personal-Gmail default). The file
 * appears in the host's "Meet Recordings" folder named
 * `"<NameA> and <NameB> - YYYY/MM/DD HH:MM TZ - Notes by Gemini"`. Its
 * existence + creation time is high-confidence evidence the meeting
 * happened — Meet derives the name list from the calendar event, not who
 * actually joined (see commit e8c87cc), so we treat it as a "meeting
 * occurred" signal only, never as a no-show signal.
 *
 * The Drive file id is stored on `InterviewMeeting.driveGeminiNotesFileId`
 * so the UI can deep-link it. Sync-on-read uses presence to emit
 * idempotent meeting_started + meeting_ended events.
 *
 * Read-only Drive API. No file mutations. Keep the queries tight — Drive's
 * `files.list` cost scales with name/createdTime filters, and we run this on
 * every page load that touches the candidate.
 */

import type { OAuth2Client } from 'google-auth-library'

const DRIVE_V3 = 'https://www.googleapis.com/drive/v3'

export interface AttendanceSignal {
  source: 'gemini_notes'
  driveFileId: string
  fileName: string
  /** Creation time per Drive — usually a few minutes after the meeting ended. */
  createdAt: Date
  /**
   * Every Drive file we found in the window for this signal source. Callers
   * persist all of them into InterviewMeetingArtifact even though only one
   * drives the lifecycle decision.
   */
  allFiles?: Array<{ id: string; name: string; createdAt: Date }>
}

async function authedFetch(client: OAuth2Client, url: string): Promise<Response> {
  const tok = await client.getAccessToken()
  if (!tok?.token) throw new Error('No Drive access token')
  return fetch(url, { headers: { Authorization: `Bearer ${tok.token}` } })
}

interface DriveFile {
  id: string
  name: string
  mimeType: string
  createdTime?: string
  modifiedTime?: string
  webViewLink?: string
}

/**
 * Look for "Notes by Gemini" docs whose creation time falls in the meeting's
 * window. Returns ALL matches so callers can persist every artifact found;
 * `findAttendanceForMeeting` separately picks the most recent for the
 * lifecycle signal.
 */
export async function findGeminiNotesForMeeting(
  client: OAuth2Client,
  opts: {
    folderId: string | null
    windowStart: Date
    windowEnd: Date
    /**
     * Required to disambiguate when multiple candidates' meetings overlap the
     * same window. Meet names the Notes doc after the calendar event title
     * (typically "<Candidate> and <Host>"), so a `name contains <candidate>`
     * filter correctly excludes other candidates' docs created in the same
     * minute. The filter is omitted only when explicitly unknown — back-compat
     * for callers that haven't been updated.
     */
    candidateName?: string | null
  },
): Promise<DriveFile[]> {
  // Drive's createdTime window — 1h before scheduled start through 4h after
  // scheduled end covers near-term timing skew + delayed Gemini finalization.
  const after = new Date(opts.windowStart.getTime() - 60 * 60 * 1000).toISOString()
  const before = new Date(opts.windowEnd.getTime() + 4 * 60 * 60 * 1000).toISOString()

  const conds = [
    "mimeType='application/vnd.google-apps.document'",
    `name contains 'Notes by Gemini'`,
    "trashed=false",
    `createdTime>='${after}'`,
    `createdTime<='${before}'`,
  ]
  if (opts.candidateName) {
    const safe = opts.candidateName.replace(/'/g, "\\'")
    conds.push(`name contains '${safe}'`)
  }
  if (opts.folderId) conds.push(`'${opts.folderId}' in parents`)
  const q = encodeURIComponent(conds.join(' and '))
  const fields = encodeURIComponent('files(id,name,mimeType,createdTime,modifiedTime,webViewLink)')
  const res = await authedFetch(client, `${DRIVE_V3}/files?q=${q}&fields=${fields}&pageSize=10&orderBy=createdTime%20desc`)
  if (!res.ok) {
    console.warn('[attendance] Gemini Notes search failed', res.status)
    return []
  }
  const body = await res.json() as { files?: DriveFile[] }
  return body.files ?? []
}

/**
 * Scan the host's Drive for the Gemini Notes doc that proves this meeting
 * happened. Returns null when none is found — caller falls back to the
 * recording artifact (handled in sync-on-read) to decide whether to emit
 * lifecycle events.
 */
export async function findAttendanceForMeeting(
  client: OAuth2Client,
  opts: {
    windowStart: Date
    windowEnd: Date
    folderId: string | null
    candidateName: string | null
  },
): Promise<AttendanceSignal | null> {
  const notes = await findGeminiNotesForMeeting(client, {
    folderId: opts.folderId,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    candidateName: opts.candidateName,
  }).catch(() => [] as DriveFile[])
  if (notes.length === 0) return null
  const primary = notes[0]
  return {
    source: 'gemini_notes',
    driveFileId: primary.id,
    fileName: primary.name,
    createdAt: primary.createdTime ? new Date(primary.createdTime) : new Date(),
    allFiles: notes.map((f) => ({
      id: f.id,
      name: f.name,
      createdAt: f.createdTime ? new Date(f.createdTime) : new Date(),
    })),
  }
}
