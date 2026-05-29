/**
 * Google Drive artifact fetch, narrowed to files created by Meet.
 *
 * Primary scope is drive.meet.readonly (Meet-generated recordings/transcripts
 * only). If DRIVE_ARTIFACT_SCOPE_ESCALATION=1, drive.readonly was also
 * requested and we can read any file the user can see. We never need generic
 * Drive write.
 *
 * Downloads are streamed through this app so candidates/recruiters do not need
 * Drive ACLs on the file. Range requests are forwarded to Drive so HTML5
 * <video> scrubbing works.
 */

import type { OAuth2Client } from 'google-auth-library'

const DRIVE_V3 = 'https://www.googleapis.com/drive/v3'

export interface DriveFileMeta {
  id: string
  name: string
  mimeType: string
  size?: string
  thumbnailLink?: string
  webViewLink?: string
  createdTime?: string
}

export async function getFileMeta(client: OAuth2Client, fileId: string): Promise<DriveFileMeta> {
  const tok = await client.getAccessToken()
  if (!tok?.token) throw new Error('No Drive access token')
  const fields = encodeURIComponent('id,name,mimeType,size,thumbnailLink,webViewLink,createdTime')
  const res = await fetch(`${DRIVE_V3}/files/${fileId}?fields=${fields}`, {
    headers: { Authorization: `Bearer ${tok.token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Drive files.get ${res.status}: ${text}`)
  }
  return res.json() as Promise<DriveFileMeta>
}

/**
 * Find the user's "Meet Recordings" folder. Workspace Individual + personal
 * Gmail accounts get their Meet recordings auto-saved here even though the
 * Meet REST API's conferenceRecords.recordings endpoint returns nothing for
 * those tiers. Returns null if Drive doesn't return a folder with that name —
 * either the user has never recorded a meeting, or their locale/spelling
 * differs (rare; Google appears to use this exact English name globally).
 */
export async function findMeetRecordingsFolderId(client: OAuth2Client): Promise<string | null> {
  const tok = await client.getAccessToken()
  if (!tok?.token) throw new Error('No Drive access token')
  const q = encodeURIComponent("name='Meet Recordings' and mimeType='application/vnd.google-apps.folder' and trashed=false")
  const fields = encodeURIComponent('files(id,name)')
  const res = await fetch(`${DRIVE_V3}/files?q=${q}&fields=${fields}&pageSize=5`, {
    headers: { Authorization: `Bearer ${tok.token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Drive files.list (Meet Recordings folder) ${res.status}: ${text}`)
  }
  const body = await res.json() as { files?: Array<{ id: string; name: string }> }
  return body.files?.[0]?.id ?? null
}

/**
 * Search the user's Meet recordings by candidate name + creation-time window.
 * Used when Meet REST API returns no conferenceRecords (personal Gmail /
 * Workspace Individual tenants) — Drive still has the artifact and the
 * filename encodes who attended.
 *
 * Filename convention: `<Name1> and <Name2> - YYYY/MM/DD HH:MM TZ - Recording`
 * (or comma-separated for 3+ people). See parseRecordingFilename.
 */
export async function searchMeetRecordings(
  client: OAuth2Client,
  opts: {
    folderId?: string | null
    candidateName?: string
    /**
     * Meet space code (e.g. "jaj-acxe-ayr"). When provided, restricts the
     * search to filenames containing that code. The personal-Gmail Gemini
     * Notes pipeline names every recording `<code> (YYYY-MM-DD HH:MM TZ)`,
     * so matching by code is the single most reliable way to bind the right
     * Drive file to the meeting regardless of when Gemini finalizes it.
     */
    meetingCode?: string | null
    createdAfter?: Date
    createdBefore?: Date
    limit?: number
  },
): Promise<DriveFileMeta[]> {
  const tok = await client.getAccessToken()
  if (!tok?.token) throw new Error('No Drive access token')
  const conditions: string[] = ["mimeType='video/mp4'", "trashed=false"]
  if (opts.folderId) conditions.push(`'${opts.folderId}' in parents`)
  if (opts.candidateName) {
    const safe = opts.candidateName.replace(/'/g, "\\'")
    conditions.push(`name contains '${safe}'`)
  }
  if (opts.meetingCode) {
    const safe = opts.meetingCode.replace(/'/g, "\\'")
    conditions.push(`name contains '${safe}'`)
  }
  if (opts.createdAfter) conditions.push(`createdTime>='${opts.createdAfter.toISOString()}'`)
  if (opts.createdBefore) conditions.push(`createdTime<='${opts.createdBefore.toISOString()}'`)
  const q = encodeURIComponent(conditions.join(' and '))
  const fields = encodeURIComponent('files(id,name,mimeType,size,thumbnailLink,webViewLink,createdTime)')
  const pageSize = opts.limit ?? 5
  const res = await fetch(`${DRIVE_V3}/files?q=${q}&fields=${fields}&pageSize=${pageSize}&orderBy=createdTime%20desc`, {
    headers: { Authorization: `Bearer ${tok.token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Drive files.list (recordings) ${res.status}: ${text}`)
  }
  const body = await res.json() as { files?: DriveFileMeta[] }
  return body.files || []
}

/**
 * Search the user's Meet transcripts. Same naming convention as recordings —
 * `<Names> - YYYY/MM/DD HH:MM TZ - Transcript` — but they land as Google Docs
 * (`application/vnd.google-apps.document`) instead of MP4s. Used by the
 * sync-on-read fallback for personal Gmail / Workspace Individual tenants
 * where the Workspace Events `transcript.fileGenerated` webhook never fires.
 */
export async function searchMeetTranscripts(
  client: OAuth2Client,
  opts: {
    folderId?: string | null
    candidateName?: string
    createdAfter?: Date
    createdBefore?: Date
    limit?: number
  },
): Promise<DriveFileMeta[]> {
  const tok = await client.getAccessToken()
  if (!tok?.token) throw new Error('No Drive access token')
  const conditions: string[] = [
    "mimeType='application/vnd.google-apps.document'",
    "name contains 'Transcript'",
    "trashed=false",
  ]
  if (opts.folderId) conditions.push(`'${opts.folderId}' in parents`)
  if (opts.candidateName) {
    const safe = opts.candidateName.replace(/'/g, "\\'")
    conditions.push(`name contains '${safe}'`)
  }
  if (opts.createdAfter) conditions.push(`createdTime>='${opts.createdAfter.toISOString()}'`)
  if (opts.createdBefore) conditions.push(`createdTime<='${opts.createdBefore.toISOString()}'`)
  const q = encodeURIComponent(conditions.join(' and '))
  const fields = encodeURIComponent('files(id,name,mimeType,size,thumbnailLink,webViewLink,createdTime)')
  const pageSize = opts.limit ?? 5
  const res = await fetch(`${DRIVE_V3}/files?q=${q}&fields=${fields}&pageSize=${pageSize}&orderBy=createdTime%20desc`, {
    headers: { Authorization: `Bearer ${tok.token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Drive files.list (transcripts) ${res.status}: ${text}`)
  }
  const body = await res.json() as { files?: DriveFileMeta[] }
  return body.files || []
}

/**
 * Parse a Meet recording filename: returns the participant names + the
 * timestamp Google embedded. Null if the filename doesn't match the pattern.
 *
 * Examples observed:
 *   "Letheria  and Georgiy Sayapin - 2026/04/30 15:00 EDT - Recording"
 *   "Georgiy Sayapin and Georgiy Sayapin - 2026/04/30 18:26 EDT - Recording"
 *   "X, Y, and Z - YYYY/MM/DD HH:MM TZ - Recording"  (3+ attendees)
 */
export function parseRecordingFilename(filename: string): { names: string[]; timestamp: string | null } | null {
  const match = filename.match(/^(.+?)\s+-\s+(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}\s+\S+)\s+-\s+Recording\s*$/i)
  if (!match) return null
  const namesPart = match[1].trim()
  // Normalize Oxford comma form ", and " into plain " and " so split is uniform.
  const normalized = namesPart.replace(/,\s+and\s+/gi, ' and ')
  const names = normalized.split(/\s+and\s+|,\s+/).map((n) => n.trim()).filter(Boolean)
  return { names, timestamp: match[2] }
}

/**
 * Decide who attended a meeting from its recording filename.
 *
 *   hasHost: whether the connected Google account's display name appears
 *   hasCandidate: whether the candidate's name appears (substring match —
 *     handles trailing whitespace and minor formatting differences from the
 *     candidate's intake form)
 *   nonHostCount: number of distinct names that are NOT the host. Zero means
 *     it was a host-only recording → no-show.
 *
 * Returns null if the filename doesn't match the expected pattern at all.
 */
export function inferAttendanceFromFilename(
  filename: string,
  hostName: string,
  candidateName: string,
): { hasHost: boolean; hasCandidate: boolean; nonHostCount: number } | null {
  const parsed = parseRecordingFilename(filename)
  if (!parsed) return null
  const hostLower = hostName.trim().toLowerCase()
  const candLower = candidateName.trim().toLowerCase()
  const seenNonHost = new Set<string>()
  let hasHost = false
  let hasCandidate = false
  for (const n of parsed.names) {
    const nLower = n.toLowerCase()
    if (nLower === hostLower) {
      hasHost = true
    } else {
      seenNonHost.add(nLower)
      if (candLower && (nLower.includes(candLower) || candLower.includes(nLower))) {
        hasCandidate = true
      }
    }
  }
  return { hasHost, hasCandidate, nonHostCount: seenNonHost.size }
}

/**
 * Stream a Drive file's bytes, forwarding the inbound Range header so the
 * browser can scrub. The returned Response is intended to be returned
 * directly from a Next.js route handler.
 */
export async function streamFile(
  client: OAuth2Client,
  fileId: string,
  rangeHeader?: string | null,
): Promise<Response> {
  const tok = await client.getAccessToken()
  if (!tok?.token) throw new Error('No Drive access token')
  const headers: Record<string, string> = { Authorization: `Bearer ${tok.token}` }
  if (rangeHeader) headers['Range'] = rangeHeader
  const res = await fetch(`${DRIVE_V3}/files/${fileId}?alt=media`, { headers })
  if (!res.ok && res.status !== 206) {
    const text = await res.text().catch(() => '')
    return new Response(text || 'Drive fetch failed', { status: res.status })
  }
  // Forward content-type, content-length, content-range, accept-ranges so the
  // browser handles Range/seek correctly.
  const passThrough: Record<string, string> = { 'Accept-Ranges': 'bytes' }
  const ct = res.headers.get('content-type'); if (ct) passThrough['Content-Type'] = ct
  const cl = res.headers.get('content-length'); if (cl) passThrough['Content-Length'] = cl
  const cr = res.headers.get('content-range'); if (cr) passThrough['Content-Range'] = cr
  return new Response(res.body, { status: res.status, headers: passThrough })
}
