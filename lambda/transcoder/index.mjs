import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createHmac } from 'node:crypto'
import path from 'node:path'

// Secrets are fetched once per cold start and reused across all SQS messages
// the container handles. Lambda containers can persist for many minutes between
// invocations, so this saves a Secrets Manager round-trip per transcode.
let cachedSecrets = null
async function loadSecrets() {
  if (cachedSecrets) return cachedSecrets
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' })
  const res = await sm.send(new GetSecretValueCommand({ SecretId: 'geos-dashboard-tokens' }))
  cachedSecrets = JSON.parse(res.SecretString)
  return cachedSecrets
}

function r2Client(secrets) {
  return new S3Client({
    region: 'auto',
    endpoint: secrets.R2_ENDPOINT,
    credentials: {
      accessKeyId: secrets.R2_ACCESS_KEY_ID,
      secretAccessKey: secrets.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  })
}

// HLS ladder. 6-second segments, GOP every 2 s so segment boundaries always
// land on a keyframe. Currently single-rung 720p because a 3-rung ladder on
// a 1440p source can't finish inside Lambda's 900 s cap even at ultrafast
// (~2.35× realtime with 3 rungs → ~35 min source barely fits and leaves no
// budget for uploading the 3.96 GB original + HLS outputs). 720p-only drops
// encode work ~3× so 40+ min sources finish comfortably. Trade-off: no
// per-tier adaptive bitrate — every viewer streams 720p regardless of
// connection. Revisit if we move off Lambda (Fargate/MediaConvert) so we can
// bring the multi-rung ladder back.
const LADDER = [
  { name: '720p',  width: 1280, height: 720,  videoBitrateK: 2000, maxrateK: 2400, bufsizeK: 4000, audioBitrateK: 128 },
]

function run(cmd, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => {
      const chunk = d.toString()
      stderr += chunk
      if (onStderr) onStderr(chunk)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-2000)}`))
    })
  })
}

async function downloadFromR2(s3, bucket, key, destPath) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  await pipeline(res.Body, createWriteStream(destPath))
}

// Recursively walk a directory and upload every file to R2 under the given
// destination prefix. Returns the list of keys uploaded so we can log them.
async function uploadDirToR2(s3, bucket, localDir, destPrefix) {
  const uploaded = []
  async function walk(dir, relBase) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(full, rel)
      } else {
        const body = createReadStream(full)
        const key = `${destPrefix}/${rel}`
        const contentType =
          entry.name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' :
          entry.name.endsWith('.ts')   ? 'video/mp2t' :
          entry.name.endsWith('.jpg')  ? 'image/jpeg' :
          entry.name.endsWith('.mp4')  ? 'video/mp4' :
          'application/octet-stream'
        // .m3u8 manifests should NOT be aggressively cached — they list segments
        // and we may republish; segments + jpg are immutable per videoId, fine
        // to cache for a year.
        const cacheControl = entry.name.endsWith('.m3u8') ? 'public, max-age=60' : 'public, max-age=31536000, immutable'
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
        }))
        uploaded.push(key)
      }
    }
  }
  await walk(localDir, '')
  return uploaded
}

async function transcodeOne(sourcePath, outputDir) {
  await mkdir(outputDir, { recursive: true })
  // One ffmpeg invocation produces all three renditions + the master.m3u8 in a
  // single pass. -filter_complex splits the input into N streams, then each
  // -map pair encodes one rendition to its own playlist, and var_stream_map
  // tells the HLS muxer how to group the streams into named variants.
  const filterParts = LADDER.map((r, i) => `[v${i}]scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease:force_divisible_by=2[v${i}out]`).join(';')
  const splitFilter = `[0:v]split=${LADDER.length}${LADDER.map((_, i) => `[v${i}]`).join('')};${filterParts}`
  const args = ['-hide_banner', '-y', '-i', sourcePath, '-filter_complex', splitFilter]
  for (let i = 0; i < LADDER.length; i++) {
    const r = LADDER[i]
    args.push(
      '-map', `[v${i}out]`,
      '-map', 'a:0?',
      '-c:v', 'libx264',
      // ultrafast (was medium → veryfast → ultrafast): x264's fastest preset,
      // needed because Lambda's 900s hard cap can't finish 30+ min HD sources
      // at any slower preset with a 3-rung ladder. Per-rung bitrate caps
      // below already bound file size, so the efficiency loss shows only as
      // marginally worse quality *within* the cap, not larger files.
      '-preset', 'ultrafast',
      '-profile:v', 'main',
      '-crf', '23',
      '-b:v', `${r.videoBitrateK}k`,
      '-maxrate', `${r.maxrateK}k`,
      '-bufsize', `${r.bufsizeK}k`,
      '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', `${r.audioBitrateK}k`, '-ac', '2',
    )
  }
  args.push(
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(outputDir, '%v', 'segment_%05d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', LADDER.map((r, i) => `v:${i},a:${i},name:${r.name}`).join(' '),
    path.join(outputDir, '%v', 'playlist.m3u8'),
  )
  let lastLog = 0
  await run('ffmpeg', args, {
    onStderr: (chunk) => {
      // ffmpeg's stderr is the primary signal channel and gets very chatty;
      // log a sample every 5 s so a stuck job is visible without flooding.
      const now = Date.now()
      if (now - lastLog > 5000 && chunk.includes('frame=')) {
        lastLog = now
        console.log('[ffmpeg]', chunk.trim().split('\n').pop())
      }
    },
  })
}

async function generatePoster(sourcePath, outputPath) {
  await run('ffmpeg', [
    '-hide_banner', '-y',
    '-i', sourcePath,
    '-ss', '00:00:01.000',
    '-vframes', '1',
    '-vf', 'scale=1280:-2',
    '-q:v', '4',
    outputPath,
  ])
}

async function probeDuration(sourcePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    sourcePath,
  ])
  const d = parseFloat(stdout.trim())
  return Number.isFinite(d) ? d : null
}

async function postWebhook(callbackUrl, secret, body) {
  const payload = JSON.stringify(body)
  const sig = createHmac('sha256', secret).update(payload).digest('hex')
  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Transcode-Signature': sig },
    body: payload,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`webhook ${res.status}: ${text.slice(0, 500)}`)
  }
}

// SQS event handler. Lambda's SQS integration delivers up to 10 messages per
// event but for video transcoding we want concurrency 1 per container (ffmpeg
// is CPU-bound, no point queueing two), so the event source mapping is
// configured with BatchSize=1. We still loop in case AWS changes the batch.
export const handler = async (event) => {
  const secrets = await loadSecrets()
  const s3 = r2Client(secrets)
  for (const record of event.Records || []) {
    let payload
    try {
      payload = JSON.parse(record.body)
    } catch (err) {
      console.error('[transcoder] malformed SQS body, dropping', err)
      continue
    }
    const { videoId, stagingKey, callbackUrl } = payload
    console.log('[transcoder] start', { videoId, stagingKey })
    const workDir = path.join('/tmp', videoId)
    const sourcePath = path.join(workDir, 'source')
    const hlsDir = path.join(workDir, 'hls')
    const posterPath = path.join(workDir, 'poster.jpg')
    try {
      await mkdir(workDir, { recursive: true })
      await downloadFromR2(s3, secrets.R2_STAGING_BUCKET, stagingKey, sourcePath)
      const sourceStat = await stat(sourcePath)
      const duration = await probeDuration(sourcePath)
      await transcodeOne(sourcePath, hlsDir)
      await generatePoster(sourcePath, posterPath)
      const destPrefix = `videos/${videoId}`
      await uploadDirToR2(s3, secrets.R2_VIDEOS_BUCKET, hlsDir, destPrefix)
      await s3.send(new PutObjectCommand({
        Bucket: secrets.R2_VIDEOS_BUCKET,
        Key: `${destPrefix}/poster.jpg`,
        Body: createReadStream(posterPath),
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable',
      }))
      // Copy the original source into the final videos bucket as well. We need
      // it for downstream Deepgram transcription + OpenAI analysis, which run
      // against an HTTPS URL and don't speak HLS. Cheap (~$0.05/yr storage per
      // GB) and keeps the analyze pipeline untouched.
      // Lowercase the extension — iPhone uploads come in as IMG_XXXX.MOV
      // (uppercase) and R2 keys are case-sensitive. Standardizing the case
      // lets HF (and any backfill) predict the URL from filename alone.
      const sourceExt = ((payload.filename || '').split('.').pop() || 'mp4').toLowerCase()
      const originalKey = `${destPrefix}/original.${sourceExt}`
      await s3.send(new PutObjectCommand({
        Bucket: secrets.R2_VIDEOS_BUCKET,
        Key: originalKey,
        Body: createReadStream(sourcePath),
        ContentType: payload.mimeType || 'video/mp4',
        CacheControl: 'public, max-age=31536000, immutable',
      }))
      // Source no longer needed once outputs are committed.
      await s3.send(new DeleteObjectCommand({ Bucket: secrets.R2_STAGING_BUCKET, Key: stagingKey })).catch((err) => {
        console.warn('[transcoder] staging cleanup failed (lifecycle will catch it)', err.message)
      })
      const publicBase = `https://${secrets.R2_PUBLIC_DOMAIN}/${destPrefix}`
      await postWebhook(callbackUrl, secrets.HF_TRANSCODE_WEBHOOK_SECRET, {
        videoId,
        status: 'ready',
        hlsManifestUrl: `${publicBase}/master.m3u8`,
        posterUrl: `${publicBase}/poster.jpg`,
        originalUrl: `${publicBase}/original.${sourceExt}`,
        sourceSizeBytes: sourceStat.size,
        durationSeconds: duration,
      })
      console.log('[transcoder] done', { videoId, durationSeconds: duration })
    } catch (err) {
      console.error('[transcoder] failed', { videoId, error: err.message, stack: err.stack })
      try {
        await postWebhook(callbackUrl, secrets.HF_TRANSCODE_WEBHOOK_SECRET, {
          videoId,
          status: 'failed',
          error: err.message?.slice(0, 1000) || 'unknown',
        })
      } catch (cbErr) {
        console.error('[transcoder] callback also failed', cbErr.message)
      }
      throw err
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
