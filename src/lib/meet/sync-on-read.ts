/**
 * On-read sync: pulls Meet API state for an InterviewMeeting and populates
 * the typed columns + participants list, mirroring what the Workspace Events
 * webhook would have written. Lets us compute no-show / attendance without
 * relying on Pub/Sub delivery — required for personal Gmail accounts (where
 * Workspace Events is silently unsupported) and as a defense-in-depth fallback
 * for Workspace tenants when push delivery hiccups.
 *
 * Idempotent and best-effort:
 * - Skips meetings whose actualEnd is already populated (webhook beat us, or
 *   we synced earlier).
 * - Skips meetings whose scheduledEnd hasn't passed yet + a grace window —
 *   no point pulling for a meeting still in progress.
 * - Throttles repeat attempts via meetApiSyncedAt so a flapping API doesn't
 *   produce N requests per page load.
 * - All Meet API errors are caught and logged; a sync failure must never
 *   break the listing endpoint that triggered it.
 *
 * When a no-show is detected, fires the same fireMeetingLifecycleAutomations
 * pathway as the webhook handler (move to Rejected, stamp rejectionReason,
 * dispatch the no-show follow-up email rule).
 */

import type { InterviewMeeting, Prisma } from '@prisma/client'
import type { OAuth2Client } from 'google-auth-library'
import { prisma } from '../prisma'
import { fetchUserInfo, getAuthedClientForWorkspace } from '../google'
import { withWorkspaceMeetClient, listConferenceRecords, listParticipants, listRecordings, listTranscripts, type Participant } from './google-meet'
import { findMeetRecordingsFolderId, searchMeetRecordings, searchMeetTranscripts } from './google-drive'
import { findAttendanceForMeeting, type AttendanceSignal } from './attendance-fallback'
import { recordArtifact, recordArtifacts } from './artifacts'
import { logSchedulingEvent } from '../scheduling'
import { fireMeetingLifecycleAutomations } from '../automation'
import { bumpSessionActivity } from '../session-activity'

// Wait this long after scheduledEnd before pulling state. Avoids racing the
// recording artifact pipeline on Workspace tenants and avoids treating a
// meeting that ran 2 min over as "no conference yet".
const GRACE_AFTER_SCHEDULED_END_MS = 15 * 60 * 1000

// Don't re-pull more often than this if a previous sync already ran. Caps
// outbound API calls when many meetings are still pending recording artifacts.
const MIN_RESYNC_INTERVAL_MS = 5 * 60 * 1000

type SyncableMeeting = Pick<InterviewMeeting,
  'id' | 'workspaceId' | 'sessionId' | 'meetSpaceName' |
  'scheduledStart' | 'scheduledEnd' | 'actualStart' | 'actualEnd' |
  'recordingState' | 'transcriptState' |
  'meetApiSyncedAt' |
  'driveRecordingFileId' | 'driveGeminiNotesFileId' | 'driveTranscriptFileId'
>

// How long after scheduledEnd we keep doing artifact rescans, even when the
// primary recording pointer is already set. Catches the case where a host
// reopens the Meet link hours after the scheduled window and produces a
// second recording in Drive (we want it in the artifact list so the UI can
// show every recording, not just the first one we found).
const ARTIFACT_RESCAN_WINDOW_MS = 24 * 60 * 60 * 1000

function shouldSync(m: SyncableMeeting): boolean {
  if (m.actualEnd) {
    const recordingTerminal =
      m.recordingState === 'ready' || m.recordingState === 'failed' ||
      m.recordingState === 'unavailable' || m.recordingState === 'disabled'
    const transcriptTerminal =
      m.transcriptState === 'ready' || m.transcriptState === 'failed' ||
      m.transcriptState === 'unavailable' || m.transcriptState === 'disabled'
    // Recording or transcript artifact still pending → keep checking for it.
    // Google sometimes lands the transcript long after the recording (esp. on
    // Workspace tenants where the live transcript.fileGenerated webhook never
    // delivered) so we must re-enter the sync until both are terminal.
    if (!recordingTerminal || !transcriptTerminal) {
      if (m.meetApiSyncedAt && Date.now() - m.meetApiSyncedAt.getTime() < MIN_RESYNC_INTERVAL_MS) return false
      return true
    }
    // Even after the recording is "ready", keep rescanning Drive for late
    // artifacts (the host reopening the Meet link an hour later produces a
    // second mp4 we'd otherwise miss). Bounded by ARTIFACT_RESCAN_WINDOW_MS
    // and throttled by MIN_RESYNC_INTERVAL_MS so we don't hammer Drive.
    if (m.scheduledEnd && Date.now() < m.scheduledEnd.getTime() + ARTIFACT_RESCAN_WINDOW_MS) {
      if (m.meetApiSyncedAt && Date.now() - m.meetApiSyncedAt.getTime() < MIN_RESYNC_INTERVAL_MS) return false
      return true
    }
    return false
  }
  // No actualEnd — only sync once the meeting window + grace has passed.
  const end = m.scheduledEnd?.getTime()
  if (!end) return false
  if (Date.now() < end + GRACE_AFTER_SCHEDULED_END_MS) return false
  // Throttle repeat attempts within the resync window.
  if (m.meetApiSyncedAt && Date.now() - m.meetApiSyncedAt.getTime() < MIN_RESYNC_INTERVAL_MS) return false
  return true
}

/**
 * Sync a single meeting from Meet API. Safe to call on any meeting — it'll
 * no-op when shouldSync returns false. Returns true if any state was updated.
 */
export async function syncMeetingFromMeetApi(meeting: SyncableMeeting): Promise<boolean> {
  if (!shouldSync(meeting)) return false

  // Stamp the sync attempt timestamp upfront so concurrent loaders don't both
  // hit Meet API for the same meeting in parallel.
  await prisma.interviewMeeting.update({
    where: { id: meeting.id },
    data: { meetApiSyncedAt: new Date() },
  }).catch(() => {})

  // Self-heal googleUserId + googleDisplayName on integrations connected
  // before those fields were captured. The Drive recording-filename path
  // needs the display name to identify the host; the Workspace path needs
  // userId to identify the host in participants. One userinfo call covers
  // both, and only runs once per integration thanks to the not-null guards.
  await ensureHostIdentity(meeting.workspaceId).catch((err) =>
    console.error('[meet-sync] ensureHostIdentity failed:', (err as Error).message),
  )

  let updated = false
  try {
    const result = await withWorkspaceMeetClient(meeting.workspaceId, async (client) => {
      const conferences = await listConferenceRecords(client, meeting.meetSpaceName)
      if (conferences.length === 0) {
        // Empty conferenceRecords means either no one joined OR Google won't
        // return conference data for this account tier. Personal @gmail.com
        // and Workspace Individual always return empty even when the meeting
        // actually happened. For those tenants we fall back to the Drive
        // recording filename as the attendance signal — recordings still land
        // in the user's Drive even when the API conferenceRecords endpoint is
        // gated.
        const integ = await prisma.googleIntegration.findUnique({
          where: { workspaceId: meeting.workspaceId },
          select: { hostedDomain: true, meetRecordingsFolderId: true },
        })
        if (integ?.hostedDomain) {
          // Workspace tenant — empty really means no conference happened.
          await maybeFlagNoShow(meeting, [], { reason: 'no_conference_started' })
          return false
        }
        // Personal Gmail / Workspace Individual fallback. Drive Recording +
        // Gemini Notes prove the meeting happened but can't disambiguate
        // attendees → emit meeting_started/ended only; recruiter manually
        // marks no-show if the candidate didn't show.
        const session = await prisma.session.findUnique({
          where: { id: meeting.sessionId },
          select: { candidateName: true },
        })
        const folderId = await ensureFolderId(client, meeting.workspaceId, integ?.meetRecordingsFolderId ?? null)
        const driveOutcome = await syncFromDriveRecording(client, meeting, folderId)
        if (driveOutcome.updated) updated = true

        const transcriptUpdated = await syncFromDriveTranscript(client, meeting, folderId)
        if (transcriptUpdated) updated = true

        const attendance = await findAttendanceForMeeting(client, {
          windowStart: meeting.scheduledStart,
          windowEnd: meeting.scheduledEnd,
          folderId,
          candidateName: session?.candidateName ?? null,
        }).catch((err) => {
          console.warn('[meet-sync] attendance fallback failed:', (err as Error).message)
          return null
        })

        const lifecycleFired = await applyAttendanceSignal(meeting, attendance, driveOutcome)
        if (lifecycleFired) updated = true
        return updated
      }

      // Use the most recent conference. (Multiple are possible if the host
      // reopened the space; the latest one is what the candidate would have
      // joined.)
      const conf = [...conferences].sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))[0]
      const participants = await listParticipants(client, conf.name)

      const data: Prisma.InterviewMeetingUpdateInput = {}
      if (conf.startTime) data.actualStart = new Date(conf.startTime)
      if (conf.endTime) data.actualEnd = new Date(conf.endTime)
      data.participants = participants.map(toParticipantRow) as unknown as Prisma.InputJsonValue

      // Recording artifact (best-effort). Skip when the recruiter explicitly
      // removed the recording from the candidate profile — re-linking would
      // silently undo their action on the next page load.
      let recordingJustReady = false
      if (meeting.recordingState !== 'unavailable') {
        try {
          const recs = await listRecordings(client, conf.name)
          const rec = recs[0]
          if (rec?.driveDestination?.file && rec.state === 'FILE_GENERATED') {
            if (meeting.recordingState !== 'ready') recordingJustReady = true
            data.recordingState = 'ready'
            data.driveRecordingFileId = rec.driveDestination.file
          } else if (rec && rec.state && rec.state !== 'FILE_GENERATED') {
            // Recording exists but artifact not finalized yet.
            if (meeting.recordingState !== 'ready') data.recordingState = 'processing'
          }
        } catch (err) {
          console.error('[meet-sync] listRecordings failed for', meeting.id, ':', (err as Error).message)
        }
      }

      // Transcript artifact — mirrors the recording path. Required because the
      // Workspace Events `transcript.fileGenerated` webhook may never fire
      // (suspended subscription, dropped Pub/Sub delivery, or a meeting that
      // happened before we were subscribed). Without this, the Doc exists in
      // Drive but the UI stays stuck on "Transcript: processing" forever.
      let transcriptJustReady = false
      if (meeting.transcriptState !== 'unavailable' && meeting.transcriptState !== 'disabled') {
        try {
          const tx = await listTranscripts(client, conf.name)
          const t = tx[0]
          if (t?.docsDestination?.document && t.state === 'FILE_GENERATED') {
            if (meeting.transcriptState !== 'ready') transcriptJustReady = true
            data.transcriptState = 'ready'
            data.driveTranscriptFileId = t.docsDestination.document
          } else if (t && t.state && t.state !== 'FILE_GENERATED') {
            if (meeting.transcriptState !== 'ready') data.transcriptState = 'processing'
          }
        } catch (err) {
          console.error('[meet-sync] listTranscripts failed for', meeting.id, ':', (err as Error).message)
        }
      }

      await prisma.interviewMeeting.update({ where: { id: meeting.id }, data })
      updated = true

      // The Workspace Events webhook normally fires `recording_ready`. When
      // that subscription is suspended (USER_SCOPE_REVOKED) the webhook stops,
      // and this sync becomes the only path that ever observes the recording.
      // Fire the trigger here too so automations don't silently stall.
      // Idempotent: the engine's execution table guards against double-send.
      if (recordingJustReady) {
        await fireMeetingLifecycleAutomations(meeting.sessionId, 'recording_ready').catch((err) =>
          console.error('[meet-sync] fire recording_ready failed for', meeting.id, ':', (err as Error).message))
      }
      if (transcriptJustReady) {
        await logSchedulingEvent({
          sessionId: meeting.sessionId,
          eventType: 'transcript_ready',
          metadata: { interviewMeetingId: meeting.id, driveFileId: data.driveTranscriptFileId as string, source: 'meet_api_sync' },
        }).catch((err) => console.error('[meet-sync] log transcript_ready failed for', meeting.id, ':', (err as Error).message))
        await fireMeetingLifecycleAutomations(meeting.sessionId, 'transcript_ready').catch((err) =>
          console.error('[meet-sync] fire transcript_ready failed for', meeting.id, ':', (err as Error).message))
      }

      // No-show evaluation, but only once we have a real end time. Mid-meeting
      // pulls (if a recruiter loads the page during the call) won't flag.
      if (conf.endTime) {
        await maybeFlagNoShow(meeting, participants.map(toParticipantRow))
      }
      return true
    })
    return result || updated
  } catch (err) {
    console.error('[meet-sync] failed for meeting', meeting.id, ':', (err as Error).message)
    return updated
  }
}

/**
 * Sync every meeting in a workspace whose state is stale and could benefit.
 * Concurrency-capped so we never fan out to dozens of Meet API calls on a
 * single page load.
 */
export async function syncWorkspaceMeetings(workspaceId: string): Promise<number> {
  const candidates = await prisma.interviewMeeting.findMany({
    where: { workspaceId },
    select: {
      id: true, workspaceId: true, sessionId: true, meetSpaceName: true,
      scheduledStart: true, scheduledEnd: true, actualStart: true, actualEnd: true,
      recordingState: true, transcriptState: true,
      meetApiSyncedAt: true,
      driveRecordingFileId: true, driveGeminiNotesFileId: true, driveTranscriptFileId: true,
    },
  })
  const stale = candidates.filter((m) => shouldSync(m))
  if (stale.length === 0) return 0

  const CONCURRENCY = 4
  let synced = 0
  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    const batch = stale.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map((m) => syncMeetingFromMeetApi(m)))
    synced += results.filter(Boolean).length
  }
  return synced
}

function toParticipantRow(p: Participant): { email: string | null; displayName: string | null; joinTime?: string; leaveTime?: string } {
  return {
    // Despite the field name, this stores `users/{id}` for signed-in users —
    // matches what the webhook handler writes and what evaluateNoShow expects.
    email: p.signedinUser?.user || null,
    displayName: p.signedinUser?.displayName || p.anonymousUser?.displayName || p.phoneUser?.displayName || null,
    joinTime: p.earliestStartTime,
    leaveTime: p.latestEndTime,
  }
}

/**
 * Drive recording artifact lookup. Links the recording file to the meeting
 * but does not infer attendance from the filename (Meet derives the filename
 * from the calendar event title, not actual attendees).
 *
 * The file's existence is still useful as a "meeting happened" signal —
 * applyAttendanceSignal consumes the returned `recordingFileId` to emit a
 * meeting_started/ended pair when no attendance sheet is available.
 */
async function syncFromDriveRecording(
  client: OAuth2Client,
  meeting: SyncableMeeting,
  folderId: string | null,
): Promise<{ updated: boolean; recordingFileId: string | null; createdAt: Date | null }> {
  // Honor explicit removal by the recruiter. recordingState='unavailable'
  // means "remove recording" was clicked — re-finding the file in Drive and
  // writing it back would silently undo that on the next page load.
  if (meeting.recordingState === 'unavailable') {
    return { updated: false, recordingFileId: null, createdAt: null }
  }
  if (!folderId) return { updated: false, recordingFileId: null, createdAt: null }

  // Search window: 15 min before scheduledStart through actualEnd (or
  // scheduledEnd) + 2 hours. Drive search no longer filters by candidate name —
  // Meet's filename is derived from the calendar event title and won't always
  // contain the stored `session.candidateName` (e.g. Cyrillic-displayed
  // candidate, Latin-stored session name). The +2h upper bound covers
  // Gemini Notes' slow finalization on personal Gmail tenants (verified
  // 2026-05-29 with Alyona Rybachenko: meeting ended 15:34, video file
  // landed in Drive at 16:36 — 62 minutes later — which the prior +30 min
  // window missed entirely).
  const start = meeting.scheduledStart ?? new Date(0)
  const endBound = meeting.actualEnd ?? meeting.scheduledEnd ?? new Date(Date.now() + 24 * 60 * 60 * 1000)
  const candidates = await searchMeetRecordings(client, {
    folderId,
    createdAfter: new Date(start.getTime() - 15 * 60 * 1000),
    createdBefore: new Date(endBound.getTime() + 2 * 60 * 60 * 1000),
    limit: 10,
  }).catch((err) => {
    console.error('[meet-sync] searchMeetRecordings failed:', (err as Error).message)
    return []
  })

  if (candidates.length === 0) return { updated: false, recordingFileId: null, createdAt: null }

  // Persist EVERY recording we found into the artifact table — handles the
  // case where the host reopened the link and made a second recording, or
  // where a reschedule URL swap left an older recording on the prior space.
  await recordArtifacts(meeting.id, 'recording', candidates.map((f) => ({
    driveFileId: f.id,
    fileName: f.name,
    meetSpaceName: meeting.meetSpaceName,
    driveCreatedTime: f.createdTime ? new Date(f.createdTime) : new Date(),
  }))).catch((err) => console.warn('[meet-sync] recordArtifacts(recording) failed:', (err as Error).message))

  // Primary pointer policy: pick the longest-running recording (largest
  // file) so the UI surfaces the "real" interview rather than e.g. a 30s
  // post-meeting reopen. searchMeetRecordings returns mp4s only, so size is
  // a fair proxy for length. Fall back to newest if sizes are missing.
  const chosen = pickPrimaryRecording(candidates)
  const createdAt = chosen.createdTime ? new Date(chosen.createdTime) : new Date()

  // Allow swapping the primary pointer when a later sync finds a clearly
  // longer recording (1.5×+ the size of the current primary). The original
  // write-once policy locked in whatever the first sync picked, which broke
  // late-arriving-candidate cases: the host alone produced a short recording
  // first; the conversation recording landed later and was bigger but the
  // first pick stayed primary. Recruiter has no UI to manually re-pick, so
  // the system has to self-correct from the artifact list.
  if (meeting.driveRecordingFileId && meeting.driveRecordingFileId !== chosen.id) {
    const current = candidates.find((c) => c.id === meeting.driveRecordingFileId)
    const currentSize = current?.size && /^\d+$/.test(current.size) ? Number(current.size) : null
    const chosenSize = chosen.size && /^\d+$/.test(chosen.size) ? Number(chosen.size) : null
    const significantlyLarger =
      currentSize !== null && chosenSize !== null && chosenSize >= currentSize * 1.5
    const currentMissingFromDrive = !current
    if (!significantlyLarger && !currentMissingFromDrive) {
      return { updated: false, recordingFileId: meeting.driveRecordingFileId, createdAt }
    }
    console.log('[meet-sync] swapping primary recording', {
      meetingId: meeting.id,
      from: meeting.driveRecordingFileId,
      to: chosen.id,
      reason: currentMissingFromDrive ? 'current_not_in_drive' : 'larger_candidate_found',
      currentSize, chosenSize,
    })
  }

  const data: Prisma.InterviewMeetingUpdateInput = {
    driveRecordingFileId: chosen.id,
    recordingState: 'ready',
  }
  if (!meeting.actualEnd) {
    // Recording's createdTime is right after the meeting ends — close enough
    // for "Ended" UI. scheduledStart stays authoritative for the start time.
    data.actualEnd = createdAt
  }
  const prevReady = meeting.recordingState === 'ready'
  await prisma.interviewMeeting.update({ where: { id: meeting.id }, data })
  // Personal-Gmail path: Workspace Events webhook never fires for these
  // tenants at all, so this is the *only* place recording_ready ever gets
  // emitted. Engine de-dupes via the execution table.
  if (!prevReady) {
    await fireMeetingLifecycleAutomations(meeting.sessionId, 'recording_ready').catch((err) =>
      console.error('[meet-sync] fire recording_ready failed for', meeting.id, ':', (err as Error).message))
  }
  return { updated: true, recordingFileId: chosen.id, createdAt }
}

/**
 * Pick the "primary" recording from a set of candidates. Prefers the largest
 * file (proxy for longest duration — the real interview rather than a host
 * reopening the link briefly); falls back to newest if sizes are unavailable.
 */
function pickPrimaryRecording<T extends { id: string; size?: string; createdTime?: string }>(candidates: T[]): T {
  const sized = candidates.filter((c) => c.size && /^\d+$/.test(c.size))
  if (sized.length > 0) {
    return sized.reduce((best, cur) => (Number(cur.size) > Number(best.size) ? cur : best))
  }
  return [...candidates].sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''))[0]
}

/**
 * Drive transcript artifact lookup. Personal Gmail / Workspace Individual
 * tenants don't get the Workspace Events `transcript.fileGenerated` webhook
 * but Meet still lands the transcript Doc in their Drive — same name pattern
 * as the recording, just `- Transcript` and a Google Docs mimeType. Returns
 * true if a row update happened.
 */
async function syncFromDriveTranscript(
  client: OAuth2Client,
  meeting: SyncableMeeting,
  folderId: string | null,
): Promise<boolean> {
  // Already linked, or recruiter explicitly removed it — leave alone.
  if (meeting.transcriptState === 'ready') return false
  if (meeting.transcriptState === 'unavailable') return false
  if (!folderId) return false
  const session = await prisma.session.findUnique({
    where: { id: meeting.sessionId },
    select: { candidateName: true },
  })
  if (!session?.candidateName) return false

  const start = meeting.scheduledStart ?? new Date(0)
  const end = meeting.scheduledEnd ?? new Date(Date.now() + 24 * 60 * 60 * 1000)
  const docs = await searchMeetTranscripts(client, {
    folderId,
    candidateName: session.candidateName,
    createdAfter: new Date(start.getTime() - 60 * 60 * 1000),
    createdBefore: new Date(end.getTime() + 3 * 60 * 60 * 1000),
    limit: 10,
  }).catch((err) => {
    console.error('[meet-sync] searchMeetTranscripts failed:', (err as Error).message)
    return []
  })
  if (docs.length === 0) return false

  // Record every transcript found — multiple can exist when the host reopened
  // the link (each session generates its own transcript).
  await recordArtifacts(meeting.id, 'transcript', docs.map((f) => ({
    driveFileId: f.id,
    fileName: f.name,
    meetSpaceName: meeting.meetSpaceName,
    driveCreatedTime: f.createdTime ? new Date(f.createdTime) : new Date(),
  }))).catch((err) => console.warn('[meet-sync] recordArtifacts(transcript) failed:', (err as Error).message))

  if (meeting.driveTranscriptFileId) return false
  const chosen = docs[0]
  await prisma.interviewMeeting.update({
    where: { id: meeting.id },
    data: { driveTranscriptFileId: chosen.id, transcriptState: 'ready' },
  })
  return true
}

/**
 * Resolve the cached "Meet Recordings" folder id, looking it up + caching on
 * first use. Returns null if the user has never recorded a Meet call.
 */
async function ensureFolderId(
  client: OAuth2Client,
  workspaceId: string,
  cached: string | null,
): Promise<string | null> {
  if (cached) return cached
  const folderId = await findMeetRecordingsFolderId(client).catch((err) => {
    console.error('[meet-sync] findMeetRecordingsFolderId failed:', (err as Error).message)
    return null
  })
  if (folderId) {
    await prisma.googleIntegration.update({
      where: { workspaceId },
      data: { meetRecordingsFolderId: folderId },
    }).catch(() => {})
  }
  return folderId
}

/**
 * Apply a personal-Gmail attendance signal to the meeting. Both Gemini Notes
 * and the Drive recording prove *someone* met but can't disambiguate the
 * candidate from the host — emit meeting_started + meeting_ended so the
 * kanban card advances; the recruiter manually marks no-show if the candidate
 * didn't show up.
 *
 * Idempotency guard: each event type is only emitted if no SchedulingEvent
 * with the same `(sessionId, eventType, interviewMeetingId)` already exists.
 *
 * Returns true if any event was emitted (so the caller can record `updated`).
 */
export type ApplyAttendanceMeeting = Pick<InterviewMeeting,
  'id' | 'workspaceId' | 'sessionId' | 'meetSpaceName' |
  'scheduledStart' | 'scheduledEnd' | 'actualStart' | 'actualEnd' |
  'driveGeminiNotesFileId'
>
export async function applyAttendanceSignal(
  meeting: ApplyAttendanceMeeting,
  attendance: AttendanceSignal | null,
  driveOutcome: { recordingFileId: string | null; createdAt: Date | null },
): Promise<boolean> {
  // Persist every file we found into the artifact table (full history),
  // separately from the primary denormalized pointer below.
  if (attendance?.allFiles && attendance.allFiles.length > 0) {
    await recordArtifacts(meeting.id, 'gemini_notes', attendance.allFiles.map((f) => ({
      driveFileId: f.id,
      fileName: f.name,
      meetSpaceName: meeting.meetSpaceName,
      driveCreatedTime: f.createdAt,
    }))).catch((err) => console.warn('[meet-sync] recordArtifacts(gemini_notes) failed:', (err as Error).message))
  } else if (attendance) {
    await recordArtifact(meeting.id, 'gemini_notes', {
      driveFileId: attendance.driveFileId,
      fileName: attendance.fileName,
      meetSpaceName: meeting.meetSpaceName,
      driveCreatedTime: attendance.createdAt,
    }).catch((err) => console.warn('[meet-sync] recordArtifact (gemini_notes) failed:', (err as Error).message))
  }

  // Persist primary pointer so the UI can deep-link the Gemini Notes doc,
  // even if we don't end up emitting any lifecycle events from this run.
  // Write-once semantics — never overwrite a recruiter-relevant choice; the
  // artifact table above carries the full history.
  if (attendance && !meeting.driveGeminiNotesFileId) {
    await prisma.interviewMeeting.update({
      where: { id: meeting.id },
      data: { driveGeminiNotesFileId: attendance.driveFileId },
    }).catch(() => {})
  }

  // Decide what happened. Either signal proves the meeting *occurred*.
  //
  // Gemini Notes alone is the weakest signal — opening the link before the
  // meeting starts is enough to create a Notes doc, and a host testing the
  // link post-no-show will spuriously revive the card. Reject a Gemini-only
  // signal when either:
  //   (a) a meeting_no_show event already exists for this meeting, OR
  //   (b) the Notes doc was created BEFORE scheduledStart (it can only be a
  //       pre-meeting link test, not the meeting itself).
  const recordingPresent = !!driveOutcome.recordingFileId
  const geminiOnly = attendance?.source === 'gemini_notes' && !recordingPresent
  if (geminiOnly) {
    const createdBeforeStart =
      meeting.scheduledStart &&
      attendance!.createdAt.getTime() < meeting.scheduledStart.getTime()
    if (createdBeforeStart) {
      console.log('[Meet] geminiNotes signal rejected (created before scheduledStart)', {
        meetingId: meeting.id,
        notesCreatedAt: attendance!.createdAt.toISOString(),
        scheduledStart: meeting.scheduledStart?.toISOString(),
      })
      return false
    }
    const noShowExists = await prisma.schedulingEvent.findFirst({
      where: {
        sessionId: meeting.sessionId,
        eventType: 'meeting_no_show',
        metadata: { path: ['interviewMeetingId'], equals: meeting.id },
      },
      select: { id: true },
    })
    if (noShowExists) {
      console.log('[Meet] geminiNotes signal rejected (no_show already logged)', {
        meetingId: meeting.id,
      })
      return false
    }
  }

  const happened = !!attendance || recordingPresent
  if (!happened) return false

  // End time: prefer the artifact's createdTime (recording or Gemini Notes
  // both finalize a few minutes after the meeting ends), else scheduledEnd.
  const endAt = attendance?.createdAt ?? driveOutcome.createdAt ?? meeting.scheduledEnd ?? new Date()
  // Start time: prefer scheduledStart (we have no better signal in fallback
  // mode); only override if we already had an actualStart from a prior sync.
  const startAt = meeting.actualStart ?? meeting.scheduledStart ?? new Date(endAt.getTime() - 30 * 60 * 1000)

  // Persist actualStart/End so the UI shows real timing.
  const stateUpdate: Prisma.InterviewMeetingUpdateInput = {}
  if (!meeting.actualStart) stateUpdate.actualStart = startAt
  if (!meeting.actualEnd) stateUpdate.actualEnd = endAt
  if (Object.keys(stateUpdate).length > 0) {
    await prisma.interviewMeeting.update({ where: { id: meeting.id }, data: stateUpdate }).catch(() => {})
    // The candidate was actually in this meeting — make that count as
    // engagement on the recruiter's "last active" indicator. Without this,
    // a candidate who only interacts with HireFunnel via interviews looks
    // permanently idle.
    await bumpSessionActivity(meeting.sessionId)
  }

  const startedSource = attendance?.source ?? 'recording'
  let any = false
  any = (await emitLifecycleEventOnce(meeting, 'meeting_started', startAt, {
    source: 'meet_api_sync_fallback', signal: startedSource,
  })) || any
  any = (await emitLifecycleEventOnce(meeting, 'meeting_ended', endAt, {
    source: 'meet_api_sync_fallback', signal: startedSource,
  })) || any
  return any
}

/**
 * Insert a SchedulingEvent + fire its lifecycle automations exactly once per
 * (sessionId, eventType, interviewMeetingId) tuple. Returns true if a new
 * event was actually emitted (false on idempotent skip).
 */
async function emitLifecycleEventOnce(
  meeting: { id: string; sessionId: string },
  eventType: 'meeting_started' | 'meeting_ended',
  at: Date,
  extra: Record<string, unknown>,
): Promise<boolean> {
  const existing = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId: meeting.sessionId,
      eventType,
      metadata: { path: ['interviewMeetingId'], equals: meeting.id },
    },
    select: { id: true },
  })
  if (existing) return false

  await logSchedulingEvent({
    sessionId: meeting.sessionId,
    eventType,
    metadata: { interviewMeetingId: meeting.id, at: at.toISOString(), ...extra },
  })
  console.log('[Meet] lifecycle emitted from fallback', { meetingId: meeting.id, eventType, at: at.toISOString(), signal: extra.signal ?? null })
  await fireMeetingLifecycleAutomations(meeting.sessionId, eventType).catch((err) => {
    console.error(`[meet-sync] ${eventType} automations failed:`, err)
  })
  return true
}

/**
 * Backfill googleUserId + googleDisplayName on the workspace's integration
 * if either is missing. One userinfo call, idempotent — both downstream
 * paths (no-show evaluation, Drive filename matching) need these.
 */
export async function ensureHostIdentity(workspaceId: string): Promise<void> {
  const integ = await prisma.googleIntegration.findUnique({
    where: { workspaceId },
    select: { googleUserId: true, googleDisplayName: true },
  })
  if (integ?.googleUserId && integ?.googleDisplayName) return
  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) return
  const info = await fetchUserInfo(authed.client)
  const updates: Record<string, unknown> = {}
  if (info.id && !integ?.googleUserId) updates.googleUserId = info.id
  if (info.displayName && !integ?.googleDisplayName) updates.googleDisplayName = info.displayName
  if (Object.keys(updates).length > 0) {
    await prisma.googleIntegration.update({ where: { workspaceId }, data: updates }).catch(() => {})
  }
}

async function maybeFlagNoShow(
  meeting: { id: string; sessionId: string; workspaceId: string },
  participants: Array<{ email: string | null; displayName: string | null }>,
  context: { reason?: string } = {},
): Promise<void> {
  // Skip if we already logged it.
  const existing = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId: meeting.sessionId,
      eventType: 'meeting_no_show',
      metadata: { path: ['interviewMeetingId'], equals: meeting.id },
    },
    select: { id: true },
  })
  if (existing) return

  // ensureHostIdentity (called at the top of syncMeetingFromMeetApi) has
  // already populated googleUserId where possible. Read the latest value.
  const integ = await prisma.googleIntegration.findUnique({
    where: { workspaceId: meeting.workspaceId },
    select: { googleUserId: true },
  })
  const hostUserId = integ?.googleUserId ?? null

  // Decide.
  let noShow = false
  let nonHostCount = 0
  if (participants.length === 0) {
    noShow = true
  } else if (hostUserId) {
    const hostKey = `users/${hostUserId}`
    nonHostCount = participants.filter((p) => p.email !== hostKey).length
    noShow = nonHostCount === 0
  } else {
    // No host id and not zero participants — can't decide. Bail rather than
    // false-positive on a real attendance.
    return
  }
  if (!noShow) return

  await logSchedulingEvent({
    sessionId: meeting.sessionId,
    eventType: 'meeting_no_show',
    metadata: {
      interviewMeetingId: meeting.id,
      at: new Date().toISOString(),
      nonHostCount,
      source: 'meet_api_sync',
      ...(context.reason ? { reason: context.reason } : {}),
    },
  })
  await fireMeetingLifecycleAutomations(meeting.sessionId, 'meeting_no_show').catch((err) => {
    console.error('[meet-sync] no-show automations failed:', err)
  })
}
