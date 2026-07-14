/**
 * GET /api/candidates/[id]/interview-meetings
 *
 * Returns all Meet-v2 InterviewMeeting rows for a candidate, for use by the
 * candidate detail UI (InterviewPanel). Ordered newest first.
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { syncMeetingFromMeetApi } from '@/lib/meet/sync-on-read'

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Pull current Meet API state for each meeting before returning — covers
  // tenants where the Workspace Events webhook never fires (personal Gmail).
  const stale = await prisma.interviewMeeting.findMany({
    where: { sessionId: session.id },
    select: {
      id: true, workspaceId: true, sessionId: true, meetSpaceName: true, meetingCode: true,
      scheduledStart: true, scheduledEnd: true, actualStart: true, actualEnd: true,
      recordingState: true, transcriptState: true,
      meetApiSyncedAt: true,
      driveRecordingFileId: true, driveGeminiNotesFileId: true, driveTranscriptFileId: true,
    },
  })
  await Promise.all(stale.map((m) => syncMeetingFromMeetApi(m).catch((err) =>
    console.error('[candidates.interview-meetings] sync failed for', m.id, ':', err),
  )))

  const meetings = await prisma.interviewMeeting.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      meetingUri: true,
      meetingCode: true,
      meetSpaceName: true,
      scheduledStart: true,
      scheduledEnd: true,
      actualStart: true,
      actualEnd: true,
      recordingEnabled: true,
      recordingState: true,
      recordingProvider: true,
      recallRecordingId: true,
      transcriptState: true,
      driveRecordingFileId: true,
      driveTranscriptFileId: true,
      driveGeminiNotesFileId: true,
      participants: true,
      confirmedAt: true,
      createdAt: true,
      // Full artifact history (recordings made on prior reschedule URLs,
      // multiple recordings when the host reopened the link, etc.). The
      // single drive*FileId fields above only point at the "primary" pick —
      // the UI uses this list to surface every recording/transcript/notes
      // file we know about for the meeting.
      artifacts: {
        select: {
          id: true,
          kind: true,
          driveFileId: true,
          fileName: true,
          meetSpaceName: true,
          driveCreatedTime: true,
        },
        orderBy: { driveCreatedTime: 'asc' },
      },
      hosts: {
        select: {
          workspaceMember: {
            select: {
              id: true,
              user: { select: { id: true, email: true, name: true } },
            },
          },
        },
      },
    },
  })

  // InterviewMeeting has no `cancelledAt` column — derive it from the latest
  // `meeting_cancelled` SchedulingEvent that references the meeting id, so the
  // UI can show a "Cancelled" pill and hide actions.
  const cancelEvents = await prisma.schedulingEvent.findMany({
    where: { sessionId: session.id, eventType: 'meeting_cancelled' },
    orderBy: { eventAt: 'desc' },
    select: { eventAt: true, metadata: true },
  })
  const cancelledAtByMeetingId = new Map<string, string>()
  for (const ev of cancelEvents) {
    const meta = (ev.metadata as Record<string, unknown> | null) || {}
    const mid = typeof meta.interviewMeetingId === 'string' ? meta.interviewMeetingId : null
    if (mid && !cancelledAtByMeetingId.has(mid)) {
      cancelledAtByMeetingId.set(mid, ev.eventAt.toISOString())
    }
  }

  const enriched = meetings.map((m) => ({
    ...m,
    cancelledAt: cancelledAtByMeetingId.get(m.id) ?? null,
    hosts: m.hosts.map((h) => ({
      memberId: h.workspaceMember.id,
      userId: h.workspaceMember.user?.id ?? null,
      email: h.workspaceMember.user?.email ?? null,
      name: h.workspaceMember.user?.name ?? null,
    })),
  }))

  return NextResponse.json({ meetings: enriched })
}
