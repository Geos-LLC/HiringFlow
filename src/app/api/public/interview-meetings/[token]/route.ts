import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { signArtifactToken } from '@/lib/meet/pubsub-jwt'

// Public, unauthenticated metadata + playback URL for a shared interview
// meeting recording. The share token is a bearer credential — anyone with
// the URL can play the recording until the recruiter revokes via
// DELETE /api/interview-meetings/[id]/share.
//
// Returns the candidate's display name and the meeting's scheduled date so
// the share page tells the viewer whose interview they're about to watch.
// Email, phone, and workspace identifiers are deliberately not disclosed.
//
// The playback URL is the existing per-meeting streaming route with a
// short-lived signed artifact token in `?t=`; the route handles Drive vs.
// Recall transparently.

const PLAYBACK_TTL_SECONDS = 30 * 60 // 30 minutes — viewers refresh the page if it expires mid-watch

export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  const token = params.token
  if (!token || token.length < 16) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const meeting = await prisma.interviewMeeting.findUnique({
    where: { shareToken: token },
    select: {
      id: true,
      scheduledStart: true,
      scheduledEnd: true,
      recordingState: true,
      driveRecordingFileId: true,
      recallRecordingId: true,
      session: {
        select: {
          candidateName: true,
          flow: { select: { name: true } },
        },
      },
    },
  })

  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (meeting.recordingState !== 'ready' || (!meeting.driveRecordingFileId && !meeting.recallRecordingId)) {
    return NextResponse.json({ error: 'Recording is not available' }, { status: 409 })
  }

  const exp = Math.floor(Date.now() / 1000) + PLAYBACK_TTL_SECONDS
  let playbackToken: string
  try {
    playbackToken = signArtifactToken({ meetingId: meeting.id, kind: 'recording', exp })
  } catch (err) {
    console.error('[public/interview-meetings] sign failed', err)
    return NextResponse.json({ error: 'Recording is not available' }, { status: 500 })
  }

  return NextResponse.json(
    {
      candidateName: meeting.session.candidateName,
      flowName: meeting.session.flow?.name ?? null,
      scheduledStart: meeting.scheduledStart.toISOString(),
      scheduledEnd: meeting.scheduledEnd.toISOString(),
      playbackUrl: `/api/interview-meetings/${meeting.id}/recording?t=${encodeURIComponent(playbackToken)}`,
      playbackExpiresAt: new Date(exp * 1000).toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' } },
  )
}
