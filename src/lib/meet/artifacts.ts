/**
 * Helpers for recording every Drive artifact ever associated with an
 * InterviewMeeting (recordings, transcripts, Gemini Notes docs).
 *
 * Why this exists:
 *
 *   1. A single InterviewMeeting row can rack up multiple recordings over its
 *      lifetime. Two known sources:
 *        - Calendar regenerates the Meet link on reschedule, leaving the old
 *          space's recording orphaned when reconcileExternalMeetReschedule
 *          rebinds the row to the new space.
 *        - The host (or anyone with the link) reopens the same space hours
 *          after the scheduled window, producing a second mp4 in Drive.
 *
 *   2. The legacy denormalized columns on InterviewMeeting (driveRecordingFileId,
 *      driveGeminiNotesFileId, driveTranscriptFileId) can only point at one of
 *      them. The child table is the canonical history; the columns remain as
 *      "primary" pointers for backward compat with existing UI/queries — they
 *      get updated to the newest artifact.
 *
 * Upserts are idempotent on (interviewMeetingId, driveFileId), so calling
 * recordArtifact for the same file twice is safe.
 */

import { prisma } from '../prisma'

export type ArtifactKind = 'recording' | 'transcript' | 'gemini_notes'

export interface ArtifactInput {
  driveFileId: string
  fileName?: string | null
  /**
   * Meet space at the moment of capture. Survives later reschedule URL swaps
   * so we can attribute each recording to the link it actually came from.
   */
  meetSpaceName?: string | null
  driveCreatedTime: Date
}

/**
 * Idempotently insert one artifact. Returns true if the row was new.
 */
export async function recordArtifact(
  interviewMeetingId: string,
  kind: ArtifactKind,
  input: ArtifactInput,
): Promise<boolean> {
  const existing = await prisma.interviewMeetingArtifact.findUnique({
    where: { interviewMeetingId_driveFileId: { interviewMeetingId, driveFileId: input.driveFileId } },
    select: { id: true },
  })
  if (existing) return false
  try {
    await prisma.interviewMeetingArtifact.create({
      data: {
        interviewMeetingId,
        kind,
        driveFileId: input.driveFileId,
        fileName: input.fileName ?? null,
        meetSpaceName: input.meetSpaceName ?? null,
        driveCreatedTime: input.driveCreatedTime,
      },
    })
    return true
  } catch (err) {
    // Lost race against another concurrent insert — uniqueness handled it.
    if ((err as { code?: string }).code === 'P2002') return false
    throw err
  }
}

/**
 * Bulk-insert artifacts that aren't yet recorded for the meeting. Returns
 * the count of rows newly inserted.
 */
export async function recordArtifacts(
  interviewMeetingId: string,
  kind: ArtifactKind,
  inputs: ArtifactInput[],
): Promise<number> {
  let inserted = 0
  for (const input of inputs) {
    if (await recordArtifact(interviewMeetingId, kind, input)) inserted++
  }
  return inserted
}

/**
 * Archive the current denormalized pointer columns into the child table
 * before they're overwritten (e.g. reschedule URL swap). The space tag
 * preserves which Meet space produced each artifact even after the row's
 * primary `meetSpaceName` moves to a new space.
 */
export async function archivePrimaryArtifacts(
  interviewMeetingId: string,
  pointers: {
    driveRecordingFileId: string | null
    driveTranscriptFileId: string | null
    driveGeminiNotesFileId: string | null
    meetSpaceName: string | null
  },
): Promise<void> {
  const now = new Date()
  const pairs: Array<[ArtifactKind, string | null]> = [
    ['recording', pointers.driveRecordingFileId],
    ['transcript', pointers.driveTranscriptFileId],
    ['gemini_notes', pointers.driveGeminiNotesFileId],
  ]
  for (const [kind, fileId] of pairs) {
    if (!fileId) continue
    await recordArtifact(interviewMeetingId, kind, {
      driveFileId: fileId,
      meetSpaceName: pointers.meetSpaceName,
      // We don't know the file's real createdTime here — use `now` as a
      // best-effort sentinel. The backfill script will overwrite this with
      // the real Drive createdTime when it re-scans the meeting window.
      driveCreatedTime: now,
    })
  }
}
