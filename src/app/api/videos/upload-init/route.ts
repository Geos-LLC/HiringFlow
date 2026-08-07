import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { generateStagingPresignedPutUrl, stagingKeyForVideo, r2PublicBase } from '@/lib/transcode-pipeline'
import { logger } from '@/lib/logger'
import { randomUUID } from 'crypto'

// Step 1 of the new R2/HLS upload flow. Creates a Video row in status='uploading'
// and hands the browser a presigned PUT URL pointing at the R2 staging bucket
// (auto-purged after 24h by bucket lifecycle). The browser PUTs the source
// file directly to R2 — no bytes through Vercel — then calls /finalize to
// trigger transcoding.
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  let body: { filename?: string; mimeType?: string; sizeBytes?: number; kind?: string } = {}
  try { body = await request.json() } catch { /* allow empty */ }
  const filename = (body.filename || 'video.mp4').toString()
  const mimeType = (body.mimeType || 'video/mp4').toString()
  const sizeBytes = Number.isFinite(body.sizeBytes) ? Number(body.sizeBytes) : 0
  const kind = body.kind === 'interview' ? 'interview' : 'training'
  console.log('[upload-init]', { workspaceId: ws.workspaceId, filename, mimeType, sizeBytes, kind })

  const videoId = randomUUID()
  const stagingKey = stagingKeyForVideo(videoId, filename)
  // storageKey starts pointing at the eventual `original.<ext>` location the
  // transcoder will write to. It returns 404 until transcode-complete fires —
  // by then Video.status='ready' so the dashboard won't try to load it before.
  const sourceExt = (filename.split('.').pop() || 'mp4').toLowerCase()
  const finalOriginalUrl = `${r2PublicBase()}/videos/${videoId}/original.${sourceExt}`

  // Wrap everything after auth in try/catch. Previously an unhandled throw
  // (Prisma constraint, R2 credential rot, etc) returned a 500 with a
  // non-JSON body, so the client showed the generic "Failed to initiate
  // upload" toast with no way to diagnose. Log the actual failure to LogHub
  // and return a structured `detail` so we can trace it end-to-end.
  try {
    await prisma.video.create({
      data: {
        id: videoId,
        workspaceId: ws.workspaceId,
        createdById: ws.userId,
        filename,
        mimeType,
        sizeBytes,
        kind,
        status: 'uploading',
        storageKey: finalOriginalUrl,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('upload_init_video_create_failed', {
      workspaceId: ws.workspaceId, videoId, filename, mimeType, sizeBytes, kind, error: message,
    })
    return NextResponse.json({ error: 'Upload record create failed', detail: message }, { status: 500 })
  }

  let presignedPutUrl: string
  try {
    presignedPutUrl = await generateStagingPresignedPutUrl({ stagingKey, contentType: mimeType })
  } catch (err) {
    // Roll back the placeholder row so the dashboard list doesn't end up with
    // a permanent 'uploading' ghost when R2 isn't configured yet.
    await prisma.video.delete({ where: { id: videoId } }).catch(() => {})
    const message = err instanceof Error ? err.message : 'r2_unavailable'
    logger.error('upload_init_r2_presign_failed', {
      workspaceId: ws.workspaceId, videoId, filename, mimeType, sizeBytes, kind, error: message,
    })
    return NextResponse.json({ error: 'Upload service unavailable', detail: message }, { status: 503 })
  }

  return NextResponse.json({
    videoId,
    stagingKey,
    presignedPutUrl,
    expectedContentType: mimeType,
  })
}
