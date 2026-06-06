/**
 * On-demand Deepgram transcription for capture audio/video that landed in
 * S3 but never got transcribed (e.g. flow steps where transcriptionEnabled
 * was false at submission time, or older captures that predate the
 * pipeline). Triggered at gather-time from the evaluation engine so the
 * scorer sees the candidate's words instead of an empty-transcript coverage
 * gap.
 *
 * Behaviour:
 *   - Presigns a short-lived S3 URL (5 min) and hands it to Deepgram.
 *   - Persists the resulting transcript back onto the CaptureResponse row,
 *     so future runs (re-runs, other evaluations) reuse the result without
 *     re-spending the Deepgram budget.
 *   - Returns the transcript text or null when the pipeline fails. Failures
 *     fall back to the existing "no transcript" path — the evaluation still
 *     proceeds, just without text content from that clip.
 *
 * Skipped when DEEPGRAM_API_KEY is not configured (e.g. dev), or when the
 * capture has no storageKey, or when the file exceeds a hard duration cap
 * (we don't want to burn Deepgram time on a stray 1-hour recording).
 */

import { prisma } from '@/lib/prisma'
import { transcribeFromUrl, transcribeFromBuffer } from '@/lib/deepgram'
import { presignCapturePlayback } from '@/lib/capture/capture-storage.service'
import { s3Download } from '@/lib/s3'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import ffmpegPath from 'ffmpeg-static'

// Per-clip cap. Captures longer than this are skipped — the eval already
// has AI-call transcripts + meeting transcripts as primary signal, and a
// 30-min audio capture is almost always either a meeting recording the
// recruiter mis-uploaded or noise.
const MAX_DURATION_FOR_AUTO_TRANSCRIBE_SEC = 600 // 10 min

export interface AutoTranscribeInput {
  id: string
  storageKey: string | null
  mimeType: string | null
  durationSec: number | null
}

/**
 * Best-effort: returns the transcript text if Deepgram succeeded, or null
 * if anything went wrong. Persists the transcript on CaptureResponse on
 * success so subsequent runs use the cached text.
 *
 * Two attempts:
 *   1. Deepgram fetches the presigned S3 URL directly — fastest path, works
 *      for mp3 / wav / standard m4a-opus.
 *   2. If attempt 1 returns empty (Deepgram couldn't decode the codec, e.g.
 *      Tetiana's AAC capture), download the file and transcode to wav via
 *      ffmpeg, then upload bytes directly. This catches container/codec
 *      quirks where Deepgram's URL fetcher gives up but ffmpeg can decode.
 */
export async function ensureCaptureTranscribed(
  capture: AutoTranscribeInput,
): Promise<string | null> {
  if (!process.env.DEEPGRAM_API_KEY) return null
  if (!capture.storageKey) return null
  if (capture.durationSec !== null && capture.durationSec > MAX_DURATION_FOR_AUTO_TRANSCRIBE_SEC) {
    return null
  }

  // Attempt 1 — Deepgram-fetched presigned URL.
  try {
    const { url } = await presignCapturePlayback({
      key: capture.storageKey,
      mimeType: capture.mimeType ?? undefined,
      expiresInSec: 300,
    })
    const { transcript } = await transcribeFromUrl(url)
    const trimmed = transcript.trim()
    if (trimmed) {
      await prisma.captureResponse.updateMany({
        where: { id: capture.id },
        data: { transcript: trimmed },
      })
      return trimmed
    }
  } catch (err) {
    console.error('[capture-transcription] attempt 1 (url) failed', {
      captureId: capture.id,
      err: (err as Error).message,
    })
    // Fall through to attempt 2.
  }

  // Attempt 2 — transcode to wav via ffmpeg and POST bytes directly.
  // Triggered when attempt 1 returned empty text (Deepgram couldn't decode
  // the source codec).
  try {
    const wav = await transcodeToWav(capture.storageKey)
    if (!wav) return null
    const { transcript } = await transcribeFromBuffer(wav, 'audio/wav')
    const trimmed = transcript.trim()
    if (!trimmed) return null
    await prisma.captureResponse.updateMany({
      where: { id: capture.id },
      data: { transcript: trimmed },
    })
    return trimmed
  } catch (err) {
    console.error('[capture-transcription] attempt 2 (transcode+buffer) failed', {
      captureId: capture.id,
      err: (err as Error).message,
    })
    return null
  }
}

/**
 * Download the S3 object and transcode to wav (mono 16kHz PCM) via
 * ffmpeg-static. wav-PCM is the codec Deepgram's nova-2 ingests most
 * reliably from an upload, so when the URL path returns empty this gives
 * us a second shot at decoding. Returns null when ffmpeg isn't available
 * or the source can't be decoded.
 */
async function transcodeToWav(storageKey: string): Promise<Buffer | null> {
  if (!ffmpegPath) return null
  const src = await s3Download(storageKey)
  if (!src) return null
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hftrans-'))
  const srcPath = path.join(tmpDir, 'src')
  const outPath = path.join(tmpDir, 'out.wav')
  try {
    await fs.writeFile(srcPath, Buffer.from(src))
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath as string, [
        '-y', '-i', srcPath,
        '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'pcm_s16le', '-f', 'wav', outPath,
      ])
      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`))
      })
    })
    return await fs.readFile(outPath)
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch { /* swallow */ }
  }
}
