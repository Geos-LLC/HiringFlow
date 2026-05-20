/**
 * POST /api/google-meet/attendance
 *
 * Direct ingest endpoint for the HireFunnel Google Meet attendance Chrome
 * extension. The extension scrapes the Meet participant panel, accumulates
 * join/leave events locally, and POSTs a snapshot here on heartbeat + at
 * meeting end. The backend mirrors what the Workspace Events webhook would
 * have done on a Workspace tenant: writes `participants[]`, sets
 * `actualStart/actualEnd`, and emits idempotent `meeting_started` /
 * `meeting_ended` / `meeting_no_show` SchedulingEvents.
 *
 * Why a separate endpoint (vs the existing Drive attendance-sheet path):
 * the Drive-sheet pipeline only resolves several minutes after the meeting
 * ends and depends on the third-party "Google Meet Attendance List"
 * extension uploading a Sheet. This path is live: the recruiter sees the
 * candidate card move while the meeting is still in progress.
 *
 * Auth: shared secret in `Authorization: Bearer <token>` (env
 * `MEET_EXTENSION_KEY`). The extension stores the token in its options
 * page; one shared key per HireFunnel deploy is intentional — we want
 * every recruiter using the extension to be able to post attendance for
 * any meeting their workspace owns. Cross-workspace scoping happens via
 * the `meetingCode` lookup, which carries enough entropy on its own.
 *
 * Idempotency:
 *   - Participants are merged by (lowercased) email+name key.
 *   - meeting_started / meeting_ended / meeting_no_show dedupe on
 *     (sessionId, eventType, metadata.interviewMeetingId), matching the
 *     guard used by sync-on-read so the Drive-sheet and extension paths
 *     can both run without double-firing.
 *
 * CORS: the extension's content script POSTs from `https://meet.google.com`
 * origin, so we ack the preflight + emit the standard ACAO headers.
 */

import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { createHash } from 'crypto'
import { prisma } from '@/lib/prisma'
import { logSchedulingEvent } from '@/lib/scheduling'
import { fireMeetingLifecycleAutomations } from '@/lib/automation'
import { bumpSessionActivity } from '@/lib/session-activity'
import { ensureHostIdentity } from '@/lib/meet/sync-on-read'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface ExtParticipant {
  participantName: string
  participantEmail?: string | null
  // True when the extension synthesized this row from chrome.identity
  // for the host themselves — used as a fallback host indicator when
  // neither email nor displayName match the workspace's GoogleIntegration
  // (e.g. the recruiter signed into Chrome with a different Google
  // account than the one HireFunnel is connected to).
  isSelf?: boolean
  firstSeenAt: string
  lastSeenAt: string
  totalSecondsPresent: number
  joinEvents?: string[]
  leaveEvents?: string[]
}

interface ExtPayload {
  meetingCode: string
  meetingUrl?: string
  hireFunnelSessionId?: string | null
  meetingStartedAt: string
  meetingEndedAt?: string | null
  source?: string
  extensionUserId?: string | null
  participants: ExtParticipant[]
  // True if the extension is sending the final snapshot (meeting ended /
  // tab closed / user left). Drives whether we fire meeting_ended +
  // evaluate no-show.
  isFinal?: boolean
}

type StoredParticipant = {
  email: string | null
  displayName: string | null
  isSelf?: boolean
  joinTime?: string
  leaveTime?: string
  totalSecondsPresent?: number
  joinEvents?: string[]
  leaveEvents?: string[]
  source?: 'chrome_extension'
}

const NO_SHOW_MIN_SECONDS = 30
// Four-tier host detection. The extension synthesizes an isSelf row from
// chrome.identity, which is the most reliable signal — it doesn't depend
// on either name strings matching across Google products. Email match
// against the workspace's connected GoogleIntegration is next; display-name
// match is the third. The fourth tier covers the case Meet renders the
// same host as a second participant tile with no email and no isSelf flag
// (observed in xcr-paay-dfi on 2026-05-20: "Sayapingeorge" + "George Sayapin"
// both belonged to the same recruiter). We compare the displayName tokens
// against the email local-part — they share at least one token when it's
// really the same person, and the comparison is symmetric so "George Sayapin"
// matches "sayapingeorge@gmail.com" via the "george" / "sayapin" tokens.
// Returning false on all four lets the candidate-side logic fire
// `meeting_no_show` correctly.
function isHostParticipant(p: StoredParticipant, hostEmail: string | null, hostName: string | null): boolean {
  if (p.isSelf) return true
  const email = (p.email || '').toLowerCase()
  if (hostEmail && email && email === hostEmail.toLowerCase()) return true
  const dn = (p.displayName || '').toLowerCase().trim()
  if (hostName && dn && dn === hostName.toLowerCase().trim()) return true
  if (hostEmail && dn && displayNameMatchesEmailLocalPart(dn, hostEmail)) return true
  return false
}

/**
 * True when the displayName shares a meaningful (≥4 char) token with the
 * email local-part. Splits both sides into alphabetic tokens and looks for
 * substring containment in either direction so "george sayapin" matches
 * "sayapingeorge@gmail.com" via "george" or "sayapin". Min-length floor
 * avoids false positives on short tokens shared with candidate names ("a",
 * "an", "the"). Pure ASCII fold — non-Latin display names won't match this
 * way, but they're already covered by the email/isSelf tiers when present.
 */
function displayNameMatchesEmailLocalPart(displayName: string, email: string): boolean {
  const local = email.toLowerCase().split('@')[0] || ''
  if (local.length < 4) return false
  const dnTokens = displayName.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 4)
  if (dnTokens.length === 0) return false
  const localStripped = local.replace(/[^a-z]/g, '')
  for (const tok of dnTokens) {
    if (localStripped.includes(tok)) return true
    if (tok.includes(localStripped)) return true
  }
  return false
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: corsHeaders() })
}

export async function POST(request: NextRequest) {
  // 1. Auth — workspace-scoped bearer token. Issued by
  //    POST /api/integrations/extension/token, stored as SHA-256 hash.
  const auth = request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
  if (!token) return jsonResponse(401, { error: 'unauthorized' })
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const tokenRow = await prisma.extensionToken.findUnique({
    where: { tokenHash },
    select: { id: true, workspaceId: true, revokedAt: true },
  })
  if (!tokenRow || tokenRow.revokedAt) return jsonResponse(401, { error: 'unauthorized' })
  const tokenWorkspaceId = tokenRow.workspaceId
  // Fire-and-forget lastUsedAt bump.
  prisma.extensionToken.update({
    where: { id: tokenRow.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {})

  // 2. Parse body.
  let body: ExtPayload
  try {
    body = await request.json() as ExtPayload
  } catch {
    return jsonResponse(400, { error: 'invalid_json' })
  }
  if (!body || typeof body !== 'object') return jsonResponse(400, { error: 'invalid_payload' })
  const meetingCode = (body.meetingCode || '').trim()
  if (!meetingCode) return jsonResponse(400, { error: 'meeting_code_required' })
  if (!Array.isArray(body.participants)) return jsonResponse(400, { error: 'participants_required' })

  // 3. Match the meeting. Scoped to the token's workspace so a token
  //    issued by workspace A cannot post attendance for a meeting code
  //    that happens to exist in workspace B.
  const meeting = await prisma.interviewMeeting.findFirst({
    where: { meetingCode, workspaceId: tokenWorkspaceId },
    select: {
      id: true, workspaceId: true, sessionId: true,
      scheduledStart: true, scheduledEnd: true,
      actualStart: true, actualEnd: true,
      participants: true,
    },
  })
  if (!meeting) {
    // Meeting not yet known to HireFunnel. Could be a Calendly-adopted
    // meeting whose calendar push hasn't fired, or a plain Meet link the
    // recruiter created outside HireFunnel. Don't 500 — ack with 202 so
    // the extension can retry on the next heartbeat.
    return jsonResponse(202, { ok: false, reason: 'meeting_not_found', retry: true })
  }

  // 4. Resolve host hints from the workspace's connected Google account so
  //    we can exclude the recruiter from the no-show count. Backfill
  //    googleDisplayName first if missing — legacy integrations connected
  //    before that column was populated leave it null, which breaks the
  //    displayName tier of host detection.
  await ensureHostIdentity(meeting.workspaceId).catch(() => {})
  const integ = await prisma.googleIntegration.findUnique({
    where: { workspaceId: meeting.workspaceId },
    select: { googleEmail: true, googleDisplayName: true },
  })
  const hostEmail = integ?.googleEmail ?? null
  const hostName = integ?.googleDisplayName ?? null

  // 5. Merge participants into the existing JSON column. Dedupe by
  //    (lowercased email | normalized name). The extension's row is
  //    authoritative for any (totalSecondsPresent / joinEvents / leaveEvents)
  //    it carries — those represent its richer in-meeting timing.
  const existing: StoredParticipant[] = Array.isArray(meeting.participants)
    ? (meeting.participants as unknown as StoredParticipant[])
    : []
  const byKey = new Map<string, StoredParticipant>()
  for (const p of existing) {
    const key = participantKey(p.email, p.displayName)
    if (key) byKey.set(key, p)
  }
  for (const incoming of body.participants) {
    const email = (incoming.participantEmail || null)?.toLowerCase() || null
    const name = (incoming.participantName || '').trim() || null
    const key = participantKey(email, name)
    if (!key) continue
    const prev = byKey.get(key)
    const merged: StoredParticipant = {
      email,
      displayName: name,
      // isSelf is sticky: once the extension has flagged this row as the
      // host (typically on the first snapshot, via chrome.identity), we
      // never want a later snapshot — where chrome.identity might have
      // briefly returned null — to silently re-classify them as a
      // candidate.
      isSelf: !!incoming.isSelf || !!prev?.isSelf,
      // earliest first-seen wins as joinTime; latest last-seen wins as leaveTime
      joinTime: minIso(prev?.joinTime, incoming.firstSeenAt),
      leaveTime: maxIso(prev?.leaveTime, incoming.lastSeenAt),
      totalSecondsPresent: Math.max(prev?.totalSecondsPresent ?? 0, incoming.totalSecondsPresent || 0),
      joinEvents: dedupeIso([...(prev?.joinEvents || []), ...(incoming.joinEvents || [])]),
      leaveEvents: dedupeIso([...(prev?.leaveEvents || []), ...(incoming.leaveEvents || [])]),
      source: 'chrome_extension',
    }
    byKey.set(key, merged)
  }
  const merged = Array.from(byKey.values())

  // 6. Decide actualStart / actualEnd.
  //    actualStart = earliest non-host firstSeenAt that survived the merge.
  //    actualEnd   = body.meetingEndedAt (final) OR the latest lastSeenAt.
  const nonHostStarts = merged
    .filter((p) => !isHostParticipant(p, hostEmail, hostName))
    .map((p) => p.joinTime)
    .filter(Boolean) as string[]
  const earliestNonHost = nonHostStarts.length
    ? nonHostStarts.reduce((a, b) => (a < b ? a : b))
    : null
  const latestSeen = merged
    .map((p) => p.leaveTime)
    .filter(Boolean)
    .sort()
    .pop() ?? null

  const update: Prisma.InterviewMeetingUpdateInput = {
    participants: merged as unknown as Prisma.InputJsonValue,
  }
  let newActualStart: Date | null = meeting.actualStart
  if (!meeting.actualStart && earliestNonHost) {
    newActualStart = new Date(earliestNonHost)
    update.actualStart = newActualStart
  }
  let newActualEnd: Date | null = meeting.actualEnd
  if (body.isFinal) {
    const endIso = body.meetingEndedAt || latestSeen
    if (endIso && !meeting.actualEnd) {
      newActualEnd = new Date(endIso)
      update.actualEnd = newActualEnd
    }
  }
  await prisma.interviewMeeting.update({ where: { id: meeting.id }, data: update })

  // 7. Audit log. Always write — gives recruiters a timeline of every
  //    snapshot the extension uploaded for this meeting.
  await logSchedulingEvent({
    sessionId: meeting.sessionId,
    eventType: 'attendance_uploaded',
    metadata: {
      interviewMeetingId: meeting.id,
      meetingCode,
      isFinal: !!body.isFinal,
      participantCount: merged.length,
      source: body.source || 'chrome_extension_google_meet',
      extensionUserId: body.extensionUserId || null,
      at: new Date().toISOString(),
    },
  }).catch((err) => console.error('[attendance] audit log failed:', err))

  // 8. Lifecycle events. Anyone non-host with positive presence triggers
  //    meeting_started exactly once. Final snapshot drives meeting_ended
  //    (always) plus a no-show check (only when zero non-host presence).
  const nonHostPresent = merged.some(
    (p) => !isHostParticipant(p, hostEmail, hostName) &&
           (p.totalSecondsPresent ?? 0) >= 1,
  )

  let firedStarted = false
  let firedEnded = false
  let firedNoShow = false

  if (nonHostPresent && newActualStart) {
    firedStarted = await emitLifecycleOnce(
      meeting.id, meeting.sessionId, 'meeting_started', newActualStart,
      { source: 'chrome_extension', meetingCode },
    )
  }

  if (body.isFinal) {
    const endAt = newActualEnd ?? new Date()
    if (nonHostPresent) {
      firedEnded = await emitLifecycleOnce(
        meeting.id, meeting.sessionId, 'meeting_ended', endAt,
        { source: 'chrome_extension', meetingCode },
      )
      // Bump session activity once attendance is confirmed by the live
      // signal — same rationale as applyAttendanceSignal.
      if (firedStarted || firedEnded) {
        await bumpSessionActivity(meeting.sessionId).catch(() => {})
      }
    } else {
      // Final snapshot, no non-host presence. Don't immediately fire
      // meeting_no_show — the host may have closed/switched the tracked tab
      // before the candidate joined (we've seen the extension upload
      // isFinal=true within 4 min of scheduledStart while the candidate
      // arrived a minute later). Wait until the scheduled meeting time has
      // fully elapsed; by then either a later snapshot brought the candidate
      // into participants[] (in which case nonHostPresent flips true on the
      // next isFinal), or the meeting genuinely passed without attendance.
      const meetingTimeElapsed = Date.now() >= meeting.scheduledEnd.getTime()
      if (meetingTimeElapsed) {
        const total = merged.reduce(
          (acc, p) => acc + (isHostParticipant(p, hostEmail, hostName) ? 0 : (p.totalSecondsPresent ?? 0)),
          0,
        )
        if (total < NO_SHOW_MIN_SECONDS) {
          firedNoShow = await emitNoShowOnce(meeting.id, meeting.sessionId, meetingCode)
        }
      }
    }
  }

  return jsonResponse(200, {
    ok: true,
    meetingId: meeting.id,
    sessionId: meeting.sessionId,
    participantCount: merged.length,
    fired: {
      meeting_started: firedStarted,
      meeting_ended: firedEnded,
      meeting_no_show: firedNoShow,
    },
  })
}

function participantKey(email: string | null | undefined, name: string | null | undefined): string | null {
  const e = unduplicateEmailGlue((email || '').toLowerCase().trim())
  if (e) return `e:${e}`
  // Recover an email that's been glued into the display name by a buggy
  // scrape (older extension versions concatenate the participant's name
  // span and email span as one textContent string when Meet renders them
  // inline). Using the embedded email as the key makes this row collapse
  // with snapshots that captured the email cleanly.
  const rawName = (name || '').trim()
  const embeddedEmail = rawName.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)
  if (embeddedEmail) return `e:${unduplicateEmailGlue(embeddedEmail[0].toLowerCase())}`
  if (!isPlausibleParticipantName(rawName)) return null
  const sanitized = sanitizeNameForKey(rawName)
  if (sanitized) return `n:${sanitized}`
  return null
}

/**
 * Reject DOM-text leaks the extension's scraper sometimes mistakes for a
 * participant. The xcr-paay-dfi meeting on 2026-05-20 captured a row whose
 * displayName was `.ink-canvas-parent {` — a CSS rule from a Meet whiteboard
 * tile — and counted it as a candidate for 394 seconds. Plausible names
 * must contain at least one Unicode letter or digit and must not start with
 * punctuation that signals markup ('.', '{', '<', '>', '#', '/', '*').
 */
// Built via RegExp constructor so the Unicode property escape is checked at
// runtime (current TS target rejects /\p{...}/u as a literal).
const NAME_HAS_LETTER_OR_DIGIT = new RegExp('[\\p{L}\\p{N}]', 'u')

function isPlausibleParticipantName(name: string): boolean {
  if (!name) return false
  const trimmed = name.trim()
  if (trimmed.length === 0) return false
  if (/^[.{<>#/*]/.test(trimmed)) return false
  // Letter or digit, including non-Latin (Cyrillic candidates etc.).
  if (!NAME_HAS_LETTER_OR_DIGIT.test(trimmed)) return false
  return true
}

/**
 * `"Sayapingeorgesayapingeorge@gmail.com"` is structurally a valid email
 * but is in fact `<displayName><email-local>@domain` glued together by
 * Meet's panel rendering. Detect the doubled-local-part case (left half
 * equals right half, case-insensitive) and trim it back to the real
 * address. Conservative threshold (half ≥ 4) avoids false positives on
 * short repetitive locals like `abc@x.com`.
 */
function unduplicateEmailGlue(addr: string): string {
  if (!addr) return addr
  const m = addr.match(/^([\w.+-]+)@([\w-]+\.[\w.-]+)$/)
  if (!m) return addr
  const local = m[1]
  if (local.length % 2 !== 0) return addr
  const half = local.length / 2
  if (half < 4) return addr
  if (local.slice(0, half).toLowerCase() !== local.slice(half).toLowerCase()) return addr
  return `${local.slice(half)}@${m[2]}`
}

/**
 * Defensive name-cleanup mirroring the extension's sanitizeNameCandidate:
 * strips embedded emails, the "devices" badge that leaks in from the
 * multi-device participant tile, and collapses exact-doubled patterns
 * ("Елена КорольЕлена Король" → "Елена Король") so two scrapes of the same
 * person produce the same dedupe key.
 */
function sanitizeNameForKey(s: string): string {
  if (!s) return ''
  let out = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
  out = out.replace(/devices?/gi, ' ')
  out = out.replace(/\s+/g, ' ').trim()
  // Collapse exact-doubled patterns ("KatKat" → "Kat",
  // "Елена КорольЕлена Король" → "Елена Король"). The previous floor of
  // `left.length >= 6 || contains whitespace` let short doubled names like
  // "KatKat" slip through and dedupe-fail against the clean "Kat" row.
  // Floor of 2 still rejects accidental doubles like "AA" → "A" being
  // meaningless, but catches every real-world Meet panel doubling we've
  // observed (3+ char given names included).
  if (out.length >= 4) {
    for (let len = Math.floor(out.length / 2); len >= 2; len--) {
      const left = out.slice(0, len)
      const after = out.slice(len).trimStart()
      if (after.toLowerCase() !== left.toLowerCase()) continue
      out = left.trim()
      break
    }
  }
  return out.toLowerCase().trim()
}

function minIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}

function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

function dedupeIso(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  out.sort()
  return out
}

async function emitLifecycleOnce(
  interviewMeetingId: string,
  sessionId: string,
  eventType: 'meeting_started' | 'meeting_ended',
  at: Date,
  extra: Record<string, unknown>,
): Promise<boolean> {
  const existing = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId,
      eventType,
      metadata: { path: ['interviewMeetingId'], equals: interviewMeetingId },
    },
    select: { id: true },
  })
  if (existing) return false
  await logSchedulingEvent({
    sessionId,
    eventType,
    metadata: { interviewMeetingId, at: at.toISOString(), ...extra },
  })
  await fireMeetingLifecycleAutomations(sessionId, eventType).catch((err) =>
    console.error(`[attendance] ${eventType} automations failed:`, err),
  )
  return true
}

async function emitNoShowOnce(
  interviewMeetingId: string,
  sessionId: string,
  meetingCode: string,
): Promise<boolean> {
  const existing = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId,
      eventType: 'meeting_no_show',
      metadata: { path: ['interviewMeetingId'], equals: interviewMeetingId },
    },
    select: { id: true },
  })
  if (existing) return false
  await logSchedulingEvent({
    sessionId,
    eventType: 'meeting_no_show',
    metadata: {
      interviewMeetingId,
      meetingCode,
      source: 'chrome_extension',
      at: new Date().toISOString(),
    },
  })
  await fireMeetingLifecycleAutomations(sessionId, 'meeting_no_show').catch((err) =>
    console.error('[attendance] no-show automations failed:', err),
  )
  return true
}
