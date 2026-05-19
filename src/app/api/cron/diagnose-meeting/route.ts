/**
 * GET /api/cron/diagnose-meeting?meetingId=<id>
 *
 * One-off diagnostic: dumps every Meet API conference record + recording
 * artifact for a single InterviewMeeting, plus every mp4 Drive file in the
 * meeting's window. Used to root-cause "recording exists but is the wrong
 * one" reports (e.g. Kateryna 2026-05-18).
 *
 * Auth: CRON_SECRET (Bearer header). Lives under /api/cron/* so the
 * middleware allowlist already exempts it; the handler does the actual
 * authorization check.
 *
 * Returns everything pertinent in one JSON blob — no DB writes, safe to
 * call repeatedly. Delete this route after the root cause is settled.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getAuthedClientForWorkspace } from '@/lib/google'
import {
  listConferenceRecords,
  listRecordings,
  listParticipants,
  getSpace,
} from '@/lib/meet/google-meet'
import {
  findMeetRecordingsFolderId,
  searchMeetRecordings,
  getFileMeta,
} from '@/lib/meet/google-drive'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const meetingId = request.nextUrl.searchParams.get('meetingId')
  if (!meetingId) return NextResponse.json({ error: 'meetingId required' }, { status: 400 })

  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true,
      workspaceId: true,
      sessionId: true,
      meetSpaceName: true,
      meetingCode: true,
      meetingUri: true,
      googleCalendarEventId: true,
      scheduledStart: true,
      scheduledEnd: true,
      actualStart: true,
      actualEnd: true,
      recordingEnabled: true,
      recordingState: true,
      driveRecordingFileId: true,
      driveTranscriptFileId: true,
      driveGeminiNotesFileId: true,
      participants: true,
      meetApiSyncedAt: true,
      artifacts: {
        select: {
          id: true, kind: true, driveFileId: true, fileName: true,
          meetSpaceName: true, driveCreatedTime: true, discoveredAt: true,
        },
        orderBy: { discoveredAt: 'asc' },
      },
    },
  })
  if (!meeting) return NextResponse.json({ error: 'meeting_not_found' }, { status: 404 })

  const authed = await getAuthedClientForWorkspace(meeting.workspaceId)
  if (!authed) return NextResponse.json({ error: 'no_google_integration' }, { status: 409 })

  const out: Record<string, unknown> = { meeting }

  // 1. Space configuration — was autoRecordingGeneration actually ON?
  try {
    const space = await getSpace(authed.client, meeting.meetSpaceName)
    out.space = space
  } catch (err) {
    out.spaceError = (err as Error).message
  }

  // 2. Every conference record on this space (Google may have created more
  //    than one if the host's first session ended before the candidate
  //    joined — auto-recording is per conference, not per space).
  let conferences: Array<{ name?: string; startTime?: string; endTime?: string }> = []
  try {
    conferences = await listConferenceRecords(authed.client, meeting.meetSpaceName)
  } catch (err) {
    out.conferencesError = (err as Error).message
  }
  out.conferences = []
  for (const conf of conferences) {
    const entry: Record<string, unknown> = {
      name: conf.name,
      startTime: conf.startTime,
      endTime: conf.endTime,
    }
    if (conf.name) {
      try {
        const recordings = await listRecordings(authed.client, conf.name)
        entry.recordings = await Promise.all(recordings.map(async (r) => {
          const driveFileId = r.driveDestination?.file
          let driveMeta: Record<string, unknown> | null = null
          if (driveFileId) {
            try {
              const meta = await getFileMeta(authed.client, driveFileId)
              driveMeta = {
                name: meta.name,
                size: meta.size,
                sizeMB: meta.size ? Number(meta.size) / 1024 / 1024 : null,
                createdTime: meta.createdTime,
                mimeType: meta.mimeType,
              }
            } catch (e) {
              driveMeta = { error: (e as Error).message }
            }
          }
          return {
            name: r.name,
            state: r.state,
            startTime: r.startTime,
            endTime: r.endTime,
            driveFileId,
            driveMeta,
          }
        }))
      } catch (err) {
        entry.recordingsError = (err as Error).message
      }
      try {
        const participants = await listParticipants(authed.client, conf.name)
        entry.participants = participants.map((p) => ({
          startTime: p.earliestStartTime,
          endTime: p.latestEndTime,
          signedinUser: p.signedinUser,
          anonymous: p.anonymousUser,
          phone: p.phoneUser,
        }))
      } catch (err) {
        entry.participantsError = (err as Error).message
      }
    }
    ;(out.conferences as unknown[]).push(entry)
  }

  // 3. Drive folder scan — every file in Meet Recordings within the window.
  try {
    const folderId = await findMeetRecordingsFolderId(authed.client)
    out.meetRecordingsFolderId = folderId
    if (folderId) {
      const start = meeting.scheduledStart
      const endBound = meeting.actualEnd ?? meeting.scheduledEnd
      const files = await searchMeetRecordings(authed.client, {
        folderId,
        createdAfter: new Date(start.getTime() - 30 * 60 * 1000),
        createdBefore: new Date(endBound.getTime() + 60 * 60 * 1000),
        limit: 30,
      })
      out.driveFilesInWindow = files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        sizeMB: f.size ? Number(f.size) / 1024 / 1024 : null,
        createdTime: f.createdTime,
        mimeType: f.mimeType,
      }))
    }
  } catch (err) {
    out.driveScanError = (err as Error).message
  }

  return NextResponse.json(out, { status: 200 })
}
