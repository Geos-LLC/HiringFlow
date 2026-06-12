import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { openai } from '@/lib/openai'
import { transcribeFromUrl } from '@/lib/deepgram'
import { getVideoUrl } from '@/lib/storage'
import { logger } from '@/lib/logger'
import { createHmac, timingSafeEqual } from 'crypto'

export const maxDuration = 120

// Lets the transcode-complete webhook re-trigger analysis without a user
// session. Same HMAC secret as the inbound webhook itself; the signed string
// includes the video id so a leaked signature can't fire analysis on a
// different video.
function isInternalCallerAuthorized(request: NextRequest, videoId: string): boolean {
  if (request.headers.get('x-internal-source') !== 'transcode-complete') return false
  const sig = request.headers.get('x-internal-signature') || ''
  const secret = process.env.HF_TRANSCODE_WEBHOOK_SECRET
  if (!secret || !sig) return false
  const expected = createHmac('sha256', secret).update(`analyze:${videoId}`).digest('hex')
  if (sig.length !== expected.length) return false
  try { return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) } catch { return false }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { videoId: string } }
) {
  const internalAuthorized = isInternalCallerAuthorized(request, params.videoId)
  let workspaceId: string | null = null
  if (!internalAuthorized) {
    const ws = await getWorkspaceSession()
    if (!ws) return unauthorized()
    workspaceId = ws.workspaceId
  }

  const video = await prisma.video.findFirst({
    where: workspaceId ? { id: params.videoId, workspaceId } : { id: params.videoId },
  })

  if (!video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 })
  }

  try {
    // Step 1: Get the public URL for the video
    const videoUrl = video.storageKey.startsWith('http')
      ? video.storageKey
      : `${request.nextUrl.origin}${getVideoUrl(video.storageKey)}`

    console.log(`[analyze] Step 1: Transcribing via Deepgram URL: ${videoUrl.slice(0, 80)}...`)

    // Step 2: Transcribe with Deepgram (no file size limit — sends URL, not file)
    const { transcript, segments } = await transcribeFromUrl(videoUrl)
    console.log(`[analyze] Step 2 done: "${transcript.slice(0, 100)}..."`)

    // Step 3: Analyze with GPT to get name, summary, bullet points
    const analysis = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You analyze video transcripts for application flows. Given a transcript, generate:
1. A short descriptive name (3-6 words) for the video
2. A one-sentence summary
3. 3-5 bullet points of key topics covered

Respond in JSON format:
{
  "displayName": "...",
  "summary": "...",
  "bulletPoints": ["...", "..."]
}`,
        },
        {
          role: 'user',
          content: `Video filename: ${video.filename}\n\nTranscript:\n${transcript}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    })

    const analysisResult = JSON.parse(analysis.choices[0]?.message?.content || '{}')
    console.log(`[analyze] Step 3 done: "${analysisResult.displayName}"`)

    // Step 4: Save to database
    const updated = await prisma.video.update({
      where: { id: video.id },
      data: {
        transcript,
        segments: segments as any,
        displayName: analysisResult.displayName || null,
        summary: analysisResult.summary || null,
        bulletPoints: analysisResult.bulletPoints || [],
      },
    })

    return NextResponse.json({
      id: updated.id,
      transcript,
      segments,
      displayName: updated.displayName,
      summary: updated.summary,
      bulletPoints: updated.bulletPoints,
    })
  } catch (error: any) {
    const errMsg = error?.message || String(error)
    logger.error('video_analyze_failed', {
      videoId: params.videoId,
      storageKey: video.storageKey?.slice(0, 80),
      mimeType: video.mimeType,
      filename: video.filename,
      err: errMsg,
      stack: error?.stack?.split('\n').slice(0, 4).join(' | '),
    })
    return NextResponse.json(
      { error: errMsg },
      { status: 500 }
    )
  }
}
