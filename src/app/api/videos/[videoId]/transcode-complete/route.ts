import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createHmac, timingSafeEqual } from 'crypto'
import { logger } from '@/lib/logger'
import { sendEmail } from '@/lib/email'

// Webhook called by the Lambda transcoder when the HLS ladder + poster + the
// preserved original.mp4 have all been uploaded to R2. HMAC-SHA256 signed with
// HF_TRANSCODE_WEBHOOK_SECRET (matches the Lambda env). Constant-time compare
// so an attacker can't time-brute the signature.
export async function POST(
  request: NextRequest,
  { params }: { params: { videoId: string } }
) {
  const secret = process.env.HF_TRANSCODE_WEBHOOK_SECRET
  if (!secret) {
    logger.error('transcode_complete_no_secret_configured', { videoId: params.videoId })
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 503 })
  }
  const signature = request.headers.get('x-transcode-signature') || ''
  const rawBody = await request.text()
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    logger.warn('transcode_complete_bad_signature', { videoId: params.videoId })
    return NextResponse.json({ error: 'Bad signature' }, { status: 401 })
  }

  let payload: {
    videoId?: string
    status?: 'ready' | 'failed'
    hlsManifestUrl?: string | null
    posterUrl?: string | null
    originalUrl?: string | null
    durationSeconds?: number | null
    sourceSizeBytes?: number | null
    error?: string | null
  }
  try { payload = JSON.parse(rawBody) } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }
  if (payload.videoId && payload.videoId !== params.videoId) {
    // Body and URL must agree — defense in depth so a stale Lambda retry can't
    // hit the wrong video row.
    return NextResponse.json({ error: 'videoId mismatch' }, { status: 400 })
  }

  const video = await prisma.video.findUnique({ where: { id: params.videoId } })
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 })

  if (payload.status === 'failed') {
    await prisma.video.update({
      where: { id: video.id },
      data: { status: 'failed', transcodeError: payload.error?.slice(0, 1000) || 'unknown' },
    })
    logger.error('transcode_failed', { videoId: video.id, error: payload.error })
    // Notify the recruiter who uploaded so they don't sit waiting for the
    // notification that's never coming. Fire-and-forget — never block the
    // webhook ack on email delivery.
    notifyTranscodeOutcome(video.id, 'failed', request.nextUrl.origin, payload.error).catch(() => {})
    return NextResponse.json({ ok: true })
  }

  if (payload.status !== 'ready') {
    return NextResponse.json({ error: 'Unknown status' }, { status: 400 })
  }

  await prisma.video.update({
    where: { id: video.id },
    data: {
      status: 'ready',
      hlsManifestUrl: payload.hlsManifestUrl || null,
      posterUrl: payload.posterUrl || null,
      // storageKey was pre-set at upload-init to the eventual original URL — if
      // Lambda's computed URL differs (e.g. extension mismatch) we trust the
      // Lambda payload as the source of truth.
      ...(payload.originalUrl ? { storageKey: payload.originalUrl } : {}),
      ...(payload.durationSeconds && Number.isFinite(payload.durationSeconds) ? { durationSeconds: payload.durationSeconds } : {}),
      ...(payload.sourceSizeBytes && Number.isFinite(payload.sourceSizeBytes) ? { sizeBytes: BigInt(Math.max(0, Math.floor(payload.sourceSizeBytes))) } : {}),
      transcodeError: null,
    },
  })

  // Fire-and-forget downstream analysis (Deepgram transcribe → OpenAI summary).
  // Same pattern the legacy /api/videos/register route used. We pass an
  // internal-service token via cookie isn't possible here; instead the analyze
  // route accepts an HMAC-signed bypass header when called from the webhook —
  // simplest is to invoke it after a 0ms timeout so this handler returns fast.
  const baseUrl = request.nextUrl.origin
  fetch(`${baseUrl}/api/videos/${video.id}/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-source': 'transcode-complete',
      'x-internal-signature': createHmac('sha256', secret).update(`analyze:${video.id}`).digest('hex'),
    },
  }).catch(() => {})

  // Email the uploader that their video is ready. Fire-and-forget — never
  // block the webhook ack on SendGrid latency or transient failures.
  notifyTranscodeOutcome(video.id, 'ready', request.nextUrl.origin).catch(() => {})

  logger.info('transcode_ready', { videoId: video.id, durationSeconds: payload.durationSeconds })
  return NextResponse.json({ ok: true })
}

// Email the User who uploaded the video. The Video → User relationship is
// `createdById`, populated at upload-init time from the session.
async function notifyTranscodeOutcome(
  videoId: string,
  outcome: 'ready' | 'failed',
  origin: string,
  errorMsg?: string | null
) {
  const video = await prisma.video.findUnique({ where: { id: videoId } })
  if (!video) return
  const user = await prisma.user.findUnique({ where: { id: video.createdById } })
  if (!user?.email) return

  const label = video.displayName || video.filename
  const dashboardUrl = `${origin}/dashboard/videos`
  if (outcome === 'ready') {
    await sendEmail({
      to: user.email,
      subject: `Your training video is ready — ${label}`,
      html: `
        <p>Hi${user.name ? ` ${user.name}` : ''},</p>
        <p>Your training video <strong>${escapeHtml(label)}</strong> finished transcoding and is now playable for candidates on any connection (adaptive 360p/480p/720p).</p>
        <p><a href="${dashboardUrl}" style="display:inline-block;padding:10px 18px;background:#FF9500;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Open in HireFunnel</a></p>
        <p style="color:#59595A;font-size:13px;">You can attach this video to any training section or flow step now.</p>
      `,
      text: `Your training video "${label}" is ready. Open the dashboard: ${dashboardUrl}`,
    })
    return
  }
  await sendEmail({
    to: user.email,
    subject: `Transcode failed — ${label}`,
    html: `
      <p>Hi${user.name ? ` ${user.name}` : ''},</p>
      <p>Your training video <strong>${escapeHtml(label)}</strong> didn't finish transcoding.</p>
      <p style="background:#FEF3F2;border-left:3px solid #F04438;padding:10px 14px;color:#7a2718;font-family:monospace;font-size:12px;">${escapeHtml(errorMsg || 'unknown error')}</p>
      <p>Try re-uploading it from the dashboard. If it keeps failing, the source file may be in a format ffmpeg can't read.</p>
      <p><a href="${dashboardUrl}">Open dashboard</a></p>
    `,
    text: `Transcode failed for "${label}". Error: ${errorMsg || 'unknown'}. Open: ${dashboardUrl}`,
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
