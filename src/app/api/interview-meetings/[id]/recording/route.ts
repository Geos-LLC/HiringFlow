/**
 * GET /api/interview-meetings/[id]/recording
 *
 * Stream the Meet recording through the server so the candidate/recruiter
 * does not need Drive ACLs on the file. Two auth paths:
 *   1. Session-authenticated user in the same workspace (for dashboard playback).
 *   2. Signed artifact token in the ?t= query string (for email links).
 *
 * Range requests are forwarded to Drive so HTML5 <video> scrubbing works.
 */

import { NextRequest } from 'next/server'
import { getWorkspaceSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getAuthedClientForWorkspace } from '@/lib/google'
import { streamFile } from '@/lib/meet/google-drive'
import { verifyArtifactToken } from '@/lib/meet/pubsub-jwt'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: params.id },
    select: {
      id: true, workspaceId: true,
      driveRecordingFileId: true, recordingState: true,
      recallRecordingId: true,
    },
  })
  if (!meeting) return new Response('Not found', { status: 404 })
  const hasRecall = !!meeting.recallRecordingId
  if (meeting.recordingState !== 'ready' || (!meeting.driveRecordingFileId && !hasRecall)) {
    return new Response('Recording not available', { status: 404 })
  }

  let authorized = false
  const tokenParam = request.nextUrl.searchParams.get('t')
  if (tokenParam) {
    const payload = verifyArtifactToken(tokenParam)
    if (payload && payload.meetingId === meeting.id && payload.kind === 'recording') {
      authorized = true
    }
  }
  if (!authorized) {
    const ws = await getWorkspaceSession()
    if (ws && ws.workspaceId === meeting.workspaceId) authorized = true
  }
  if (!authorized) return new Response('Unauthorized', { status: 401 })

  // Recall path: fetch a fresh presigned download URL from the Recall API
  // (their URLs have a 15-min TTL so we can't cache them) and 302-redirect
  // the browser to it. <video src> follows the redirect and streams the
  // file directly from Recall's CDN — no bandwidth on our function.
  if (hasRecall) {
    try {
      const { getBot } = await import('@/lib/recall/client')
      // Look up the bot to get the recording's media_shortcuts. We don't
      // have a "get recording by id" endpoint, so we go through the bot.
      const meta = await prisma.interviewMeeting.findUnique({
        where: { id: meeting.id },
        select: { recallBotId: true },
      })
      if (!meta?.recallBotId) return new Response('Recording unlinked', { status: 404 })
      const bot = await getBot(meta.recallBotId)
      const url = bot.recordings?.[0]?.media_shortcuts?.video_mixed?.data?.download_url
        ?? bot.recordings?.[0]?.media_shortcuts?.audio_mixed?.data?.download_url
      if (!url) return new Response('Recording not yet finalized', { status: 404 })
      return Response.redirect(url, 302)
    } catch (err) {
      console.error('[Artifact] recall recording fetch failed:', err)
      return new Response('Recording fetch failed', { status: 502 })
    }
  }

  // Legacy Drive path (Meet native recording).
  const authed = await getAuthedClientForWorkspace(meeting.workspaceId)
  if (!authed) return new Response('Google account not connected', { status: 409 })

  const range = request.headers.get('range')
  try {
    return await streamFile(authed.client, meeting.driveRecordingFileId!, range)
  } catch (err) {
    console.error('[Artifact] recording stream failed:', err)
    return new Response('Recording fetch failed', { status: 502 })
  }
}
