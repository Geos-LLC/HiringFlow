import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { prisma } from '@/lib/prisma'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'

// Recruiter-facing share token management for an InterviewMeeting recording.
//
// POST   /api/interview-meetings/[id]/share  → mint a token if missing, return
//                                              existing token + URL otherwise.
// DELETE /api/interview-meetings/[id]/share  → revoke (clears the column).
//
// Public playback at /share/interview/[token] → /api/public/interview-meetings/[token].
// Mirrors the capture share-link contract.

function appBaseUrl(): string {
  return (
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    'https://www.hirefunnel.app'
  ).replace(/\/+$/, '')
}

function buildShareUrl(token: string): string {
  return `${appBaseUrl()}/share/interview/${token}`
}

function mintToken(): string {
  return randomBytes(24).toString('base64url')
}

async function loadMeeting(meetingId: string, workspaceId: string) {
  return prisma.interviewMeeting.findFirst({
    where: { id: meetingId, workspaceId },
    select: {
      id: true,
      recordingState: true,
      driveRecordingFileId: true,
      recallRecordingId: true,
      shareToken: true,
      shareCreatedAt: true,
    },
  })
}

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const meeting = await loadMeeting(params.id, ws.workspaceId)
  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (meeting.recordingState !== 'ready' || (!meeting.driveRecordingFileId && !meeting.recallRecordingId)) {
    return NextResponse.json({ error: 'Recording is not ready yet' }, { status: 409 })
  }

  if (meeting.shareToken) {
    return NextResponse.json({
      shareToken: meeting.shareToken,
      shareUrl: buildShareUrl(meeting.shareToken),
      shareCreatedAt: meeting.shareCreatedAt?.toISOString() ?? null,
    })
  }

  let token = mintToken()
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const updated = await prisma.interviewMeeting.update({
        where: { id: meeting.id },
        data: { shareToken: token, shareCreatedAt: new Date() },
        select: { shareToken: true, shareCreatedAt: true },
      })
      return NextResponse.json({
        shareToken: updated.shareToken!,
        shareUrl: buildShareUrl(updated.shareToken!),
        shareCreatedAt: updated.shareCreatedAt?.toISOString() ?? null,
      })
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'P2002' && attempt < 2) {
        token = mintToken()
        continue
      }
      throw err
    }
  }
  return NextResponse.json({ error: 'Could not mint share token' }, { status: 500 })
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const meeting = await loadMeeting(params.id, ws.workspaceId)
  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!meeting.shareToken) return NextResponse.json({ shareToken: null })

  await prisma.interviewMeeting.update({
    where: { id: meeting.id },
    data: { shareToken: null, shareCreatedAt: null },
  })
  return NextResponse.json({ shareToken: null })
}
