// Re-transcode existing R2-hosted videos that never got HLS. Different from
// migrate-vercel-blob-videos-to-r2.ts which handles legacy Vercel Blob /
// direct S3 sources — this one handles videos already on R2 (uploaded via
// the new pipeline) where the transcoder timed out or was never triggered,
// so `hlsManifestUrl` is still null and playback falls back to raw MOV.
//
// Root cause was the 3-rung LADDER exceeding Lambda's 15-min cap on
// >30 min sources (see commit 924410a — single-rung fix). After deploying
// that fix, run this to re-enqueue every stuck video.
//
// Usage:
//   DATABASE_URL=$prod R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
//   R2_VIDEOS_BUCKET=hirefunnel-videos R2_STAGING_BUCKET=hirefunnel-video-staging \
//   R2_PUBLIC_DOMAIN=videos.hirefunnel.app \
//   HF_SQS_PUBLISHER_ACCESS_KEY_ID=... HF_SQS_PUBLISHER_SECRET_ACCESS_KEY=... \
//   HF_TRANSCODE_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/094396338769/hirefunnel-transcode-jobs \
//   npx tsx scripts/backfill-r2-hls.ts
//
// Flags:
//   --dry-run   : list what would re-transcode, don't touch anything
//   --limit=N   : cap this run at N videos
//   --kind=training|interview  : restrict to one kind (default: all)

import { PrismaClient } from '@prisma/client'
import { S3Client, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'

const prisma = new PrismaClient()

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var ${name}`)
  return v
}

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='))
  if (!a) return Infinity
  const n = Number(a.split('=')[1])
  return Number.isFinite(n) && n > 0 ? n : Infinity
})()
const KIND = (() => {
  const a = args.find((x) => x.startsWith('--kind='))
  if (!a) return null as null | 'training' | 'interview'
  const k = a.split('=')[1]
  return k === 'interview' || k === 'training' ? k : null
})()

async function main() {
  const callbackBase = process.env.HF_CALLBACK_BASE_URL || 'https://hirefunnel.app'
  console.log(`[backfill-r2] dry-run=${DRY_RUN} limit=${LIMIT === Infinity ? 'all' : LIMIT} kind=${KIND ?? 'all'}`)

  const r2 = new S3Client({
    region: 'auto',
    endpoint: need('R2_ENDPOINT'),
    credentials: { accessKeyId: need('R2_ACCESS_KEY_ID'), secretAccessKey: need('R2_SECRET_ACCESS_KEY') },
    forcePathStyle: true,
  })
  const sqs = new SQSClient({
    region: 'us-east-1',
    credentials: { accessKeyId: need('HF_SQS_PUBLISHER_ACCESS_KEY_ID'), secretAccessKey: need('HF_SQS_PUBLISHER_SECRET_ACCESS_KEY') },
  })

  const videosBucket = need('R2_VIDEOS_BUCKET')
  const stagingBucket = need('R2_STAGING_BUCKET')

  // Candidates: on R2 (r2.dev or the custom videos.hirefunnel.app domain),
  // missing hlsManifestUrl. Includes status=ready (transcoder never ran /
  // failed silently), status=failed, status=transcoding (never got the
  // callback). Excludes status=uploading — those are still in-flight from
  // the browser and shouldn't be re-enqueued.
  const candidates = await prisma.video.findMany({
    where: {
      ...(KIND ? { kind: KIND } : {}),
      hlsManifestUrl: null,
      status: { in: ['ready', 'failed', 'transcoding'] },
      OR: [
        { storageKey: { contains: 'videos.hirefunnel.app' } },
        { storageKey: { contains: 'r2.dev' } },
        { storageKey: { contains: 'r2.cloudflarestorage.com' } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`[backfill-r2] found ${candidates.length} R2-hosted videos missing HLS`)
  if (candidates.length === 0) return

  let processed = 0
  let queued = 0
  let skipped = 0
  let failed = 0
  for (const v of candidates) {
    if (processed >= LIMIT) break
    processed++
    const ext = (v.filename.split('.').pop() || 'mp4').toLowerCase()
    const originalKey = `videos/${v.id}/original.${ext}`
    const stagingKey = `staging/${v.id}/${(v.filename || 'video').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)}`
    const label = `${v.id}  kind=${v.kind}  ${v.filename}  ${(v.sizeBytes / 1024 / 1024).toFixed(1)}MB`
    console.log(`[backfill-r2] ${label}`)

    // Confirm the original still exists in the videos bucket before touching
    // anything — skip cleanly if not (deleted, wrong ext, etc).
    try {
      await r2.send(new HeadObjectCommand({ Bucket: videosBucket, Key: originalKey }))
    } catch {
      console.warn(`[backfill-r2]   ✗ original not found at ${originalKey}, skipping`)
      skipped++
      continue
    }

    if (DRY_RUN) continue

    try {
      // Copy the R2 original into staging so the transcoder can pick it up
      // via its existing staging-bucket read path. Same-region R2 copy is
      // fast + free.
      await r2.send(new CopyObjectCommand({
        Bucket: stagingBucket,
        Key: stagingKey,
        CopySource: `/${videosBucket}/${originalKey}`,
        ContentType: v.mimeType || 'video/mp4',
      }))
      await prisma.video.update({
        where: { id: v.id },
        data: { status: 'transcoding', transcodeError: null },
      })
      await sqs.send(new SendMessageCommand({
        QueueUrl: need('HF_TRANSCODE_QUEUE_URL'),
        MessageBody: JSON.stringify({
          videoId: v.id,
          stagingKey,
          filename: v.filename,
          mimeType: v.mimeType || 'video/mp4',
          callbackUrl: `${callbackBase}/api/videos/${v.id}/transcode-complete`,
        }),
      }))
      queued++
      console.log(`[backfill-r2]   ✓ staged + queued`)
    } catch (err) {
      failed++
      console.error(`[backfill-r2]   ✗ ${err instanceof Error ? err.message : err}`)
    }
  }
  console.log(`[backfill-r2] done: ${processed} processed, ${queued} queued, ${skipped} skipped (no source), ${failed} failed`)
}

main().catch((err) => {
  console.error('[backfill-r2] fatal', err)
  process.exit(1)
}).finally(() => prisma.$disconnect())
