import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { publishTranscodeJob, stagingKeyForVideo } from '@/lib/transcode-pipeline'
import { logger } from '@/lib/logger'

// Step 2 of the new R2/HLS upload flow. Called by the browser AFTER its PUT
// to the presigned R2 staging URL succeeds. Flips status to 'transcoding' and
// enqueues a Lambda job. Idempotent: if status is already 'transcoding' or
// 'ready' we skip enqueue but still return 200 so a retry doesn't error.
export async function POST(
  request: NextRequest,
  { params }: { params: { videoId: string } }
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const video = await prisma.video.findFirst({
    where: { id: params.videoId, workspaceId: ws.workspaceId },
  })
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 })

  if (video.status === 'ready' || video.status === 'transcoding') {
    return NextResponse.json({ ok: true, status: video.status, noop: true })
  }

  const stagingKey = stagingKeyForVideo(video.id, video.filename)
  const baseUrl = request.nextUrl.origin
  const callbackUrl = `${baseUrl}/api/videos/${video.id}/transcode-complete`

  let messageId: string
  try {
    messageId = await publishTranscodeJob({
      videoId: video.id,
      stagingKey,
      filename: video.filename,
      mimeType: video.mimeType,
      callbackUrl,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'sqs_unavailable'
    // Preserve AWS SDK metadata so credential/permission problems are
    // observable as machine-parseable fields rather than only in the
    // human-readable message. `Code` + `$metadata` are set by
    // @aws-sdk/client-sqs on service exceptions; for non-AWS errors they
    // stay undefined and the log gracefully degrades to what we had.
    const anyErr = err as any
    logger.error('finalize_publish_failed', {
      videoId: video.id,
      error: message,
      error_name: anyErr?.name,
      aws_error_code: anyErr?.Code,
      aws_http_status: anyErr?.$metadata?.httpStatusCode,
      aws_request_id: anyErr?.$metadata?.requestId,
    })
    return NextResponse.json({ error: 'Transcode dispatch failed', detail: message }, { status: 503 })
  }

  const updated = await prisma.video.update({
    where: { id: video.id },
    data: { status: 'transcoding', transcodeError: null },
  })

  logger.info('finalize_published', { videoId: video.id, messageId })

  return NextResponse.json({ ok: true, status: updated.status, messageId })
}
