/**
 * Server-side video frame extraction for AI media observation.
 *
 * Pipeline:
 *   1. Download the source video to /tmp (Vercel function tmpfs, ~512 MB).
 *   2. Run ffmpeg-static to extract N evenly-spaced frames at ~480px wide
 *      (small enough to fit in a vision-model context window without
 *      dropping detail the model cares about: face, posture, lighting).
 *   3. Read each frame back as base64 JPEG so it can be sent inline to the
 *      OpenAI vision API as `image_url: data:image/jpeg;base64,...`.
 *   4. Clean up — best-effort unlink of the temp files even on error.
 *
 * No external service. ffmpeg-static publishes a linux-x64 binary that
 * Vercel's Node serverless runtime can execute directly. The /api/evaluations
 * route's maxDuration is bumped in vercel.json to accommodate the encode pass.
 */

import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import ffmpegPath from 'ffmpeg-static'

const FRAMES_PER_CLIP = 6
const FRAME_WIDTH = 480
// Cap on source video size we'll attempt to extract from. Tuned to the
// typical self-intro recording (30-90s, ≤30 MB on mobile). Larger files
// almost certainly aren't candidate recordings and would risk Vercel
// function memory.
const MAX_VIDEO_BYTES = 80 * 1024 * 1024

export interface ExtractedFrame {
  base64: string
  mimeType: 'image/jpeg'
  // Seconds into the clip this frame was sampled from. Lets the prompt
  // reference timestamps so the vision model can stitch a narrative.
  atSec: number
}

/**
 * Extract N evenly-spaced frames from a video buffer. Returns null when the
 * pipeline can't proceed (ffmpeg missing, buffer too large, encode error).
 */
export async function extractFramesFromBuffer(
  videoBytes: Buffer,
  durationSec: number | null,
  count: number = FRAMES_PER_CLIP,
): Promise<ExtractedFrame[] | null> {
  if (!ffmpegPath) return null
  if (videoBytes.byteLength > MAX_VIDEO_BYTES) return null

  // Write the source to a unique tmp file. Using a random name so concurrent
  // invocations don't collide on the same Lambda warm container.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hfvid-'))
  const srcPath = path.join(tmpDir, 'src')
  const framePattern = path.join(tmpDir, 'f%02d.jpg')

  try {
    await fs.writeFile(srcPath, videoBytes)

    // If we don't know the duration, probe it via ffprobe. Without a duration
    // we can't space the frames; fall back to first-N-seconds sampling.
    const knownDuration = durationSec ?? (await probeDuration(srcPath))
    const targetCount = Math.max(2, Math.min(count, 8))

    // Compose the frame-extraction filter:
    //   - Sample N evenly-spaced frames using fps mode driven by duration.
    //   - Scale to FRAME_WIDTH wide, preserve aspect.
    //   - Output JPEG quality 5 (lower number = higher quality in ffmpeg's
    //     -q:v scale).
    const args = ['-y', '-i', srcPath]
    if (knownDuration && knownDuration > 0) {
      const interval = knownDuration / (targetCount + 1)
      // 'fps=1/interval' gives one frame per interval seconds. Limit to N
      // frames via -frames:v so we don't blow past the desired count when
      // the last interval is short.
      args.push(
        '-vf',
        `fps=1/${Math.max(0.5, interval)},scale=${FRAME_WIDTH}:-2`,
        '-frames:v',
        String(targetCount),
      )
    } else {
      // No duration: take one frame per second over the first N seconds.
      args.push(
        '-vf',
        `fps=1,scale=${FRAME_WIDTH}:-2`,
        '-frames:v',
        String(targetCount),
      )
    }
    args.push('-q:v', '5', framePattern)

    await runFfmpeg(args)

    const files = (await fs.readdir(tmpDir))
      .filter((f) => f.startsWith('f') && f.endsWith('.jpg'))
      .sort()

    const frames: ExtractedFrame[] = []
    const denom = (knownDuration ?? files.length) || 1
    const step = (knownDuration ?? files.length) / Math.max(1, files.length)
    for (let i = 0; i < files.length; i++) {
      const buf = await fs.readFile(path.join(tmpDir, files[i]))
      frames.push({
        base64: buf.toString('base64'),
        mimeType: 'image/jpeg',
        atSec: Math.round((i + 0.5) * step * 10) / 10,
      })
    }

    return frames.length > 0 ? frames : null
  } catch (err) {
    console.error('[video-frames] extraction failed', (err as Error).message)
    return null
  } finally {
    // Best-effort cleanup. Failures here are logged but don't surface — the
    // tmp dir will be reaped when the Vercel container recycles.
    try {
      await fs.rm(tmpDir, { recursive: true, force: true })
    } catch {
      /* swallow */
    }
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, args)
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))
    })
  })
}

async function probeDuration(srcPath: string): Promise<number | null> {
  if (!ffmpegPath) return null
  return new Promise((resolve) => {
    // ffmpeg-static doesn't ship ffprobe; parse duration off the ffmpeg
    // banner output instead. Reliable for every container format we ingest
    // (mp4, webm, mov).
    const proc = spawn(ffmpegPath as string, ['-i', srcPath])
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/)
      if (!m) return resolve(null)
      const h = parseInt(m[1], 10)
      const mi = parseInt(m[2], 10)
      const s = parseFloat(m[3])
      resolve(h * 3600 + mi * 60 + s)
    })
    proc.on('error', () => resolve(null))
  })
}
