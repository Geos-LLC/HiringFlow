import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// Register a blob-uploaded video and optionally trigger analysis
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const { url, filename, mimeType, sizeBytes, analyze, kind } = await request.json()

  if (!url) {
    return NextResponse.json({ error: 'Missing blob URL' }, { status: 400 })
  }

  const safeKind = kind === 'interview' ? 'interview' : 'training'

  const video = await prisma.video.create({
    data: {
      workspaceId: ws.workspaceId,
      createdById: ws.userId,
      filename: filename || 'video',
      storageKey: url,
      mimeType: mimeType || 'video/mp4',
      sizeBytes: BigInt(Math.max(0, Math.floor(Number(sizeBytes) || 0))),
      kind: safeKind,
    },
  })

  // Fire-and-forget: trigger analysis server-side without blocking the response
  if (analyze) {
    const baseUrl = request.nextUrl.origin
    fetch(`${baseUrl}/api/videos/${video.id}/analyze`, {
      method: 'POST',
      headers: { cookie: request.headers.get('cookie') || '' },
    }).catch(() => {})
  }

  return NextResponse.json({
    ...video,
    url: video.storageKey,
  })
}
