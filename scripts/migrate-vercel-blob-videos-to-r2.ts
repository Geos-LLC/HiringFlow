// One-shot migration: download every Vercel Blob-hosted training video,
// stage it on R2, and enqueue an SQS transcode job. Run AFTER the R2/HLS
// pipeline is deployed and Lambda is healthy. Idempotent — videos already
// migrated (status='ready' AND hlsManifestUrl set) are skipped.
//
// Usage:
//   AWS_PROFILE=default DATABASE_URL=$prod_db npx tsx scripts/migrate-vercel-blob-videos-to-r2.ts
//
// Flags:
//   --dry-run    : list videos that would migrate but do not actually move bytes
//   --limit=N    : only process N videos this run (default: all)
//   --kind=training|interview : restrict to one kind (default: training only)
//
// Each video is processed serially so we don't blow R2 PUT rate limits, but
// the actual transcode happens in parallel on Lambda once messages land in SQS.

import { PrismaClient } from '@prisma/client'
import { S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { Readable } from 'node:stream'

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
  if (!a) return 'training'
  const k = a.split('=')[1]
  return k === 'interview' || k === 'training' ? k : 'training'
})()

async function main() {
  const callbackBase = process.env.HF_CALLBACK_BASE_URL || 'https://hirefunnel.app'
  console.log(`[migrate] dry-run=${DRY_RUN} limit=${LIMIT === Infinity ? 'all' : LIMIT} kind=${KIND} callbackBase=${callbackBase}`)

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

  // Anything missing an `hlsManifestUrl` is pre-pipeline. Production has
  // historically used a mix of Vercel Blob (`*.blob.vercel-storage.com`) and
  // direct S3 (`hiringflow-uploads.s3.us-east-1.amazonaws.com`); both flow
  // through this same migration path. Rows already pointing at R2
  // (`*.r2.dev` / `*.r2.cloudflarestorage.com`) are skipped — they're the
  // new-pipeline rows that just haven't finished transcoding yet, and
  // re-enqueuing them would race the live Lambda job.
  const candidates = await prisma.video.findMany({
    where: {
      kind: KIND,
      hlsManifestUrl: null,
      storageKey: { startsWith: 'http' },
      NOT: [
        { storageKey: { contains: 'r2.dev' } },
        { storageKey: { contains: 'r2.cloudflarestorage.com' } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`[migrate] found ${candidates.length} videos to migrate`)
  if (candidates.length === 0) return

  let processed = 0
  for (const v of candidates) {
    if (processed >= LIMIT) break
    const url = v.storageKey
    const ext = (v.filename.split('.').pop() || 'mp4').toLowerCase()
    const stagingKey = `staging/${v.id}/${(v.filename || 'video').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)}`
    console.log(`[migrate] ${v.id}  (${v.filename})  ${(Number(v.sizeBytes) / 1024 / 1024).toFixed(1)} MB`)

    if (DRY_RUN) { processed++; continue }

    try {
      const res = await fetch(url)
      if (!res.ok || !res.body) throw new Error(`fetch ${res.status}`)
      // Stream the source straight from S3 (or wherever) into R2's multipart
      // upload — without this, the 887MB videos blow Node's heap. lib-storage
      // chunks it into 5 MB parts and runs 4 in parallel.
      const upload = new Upload({
        client: r2,
        params: {
          Bucket: need('R2_STAGING_BUCKET'),
          Key: stagingKey,
          Body: Readable.fromWeb(res.body as unknown as ReadableStream<Uint8Array>),
          ContentType: v.mimeType || 'video/mp4',
        },
        queueSize: 4,
        partSize: 5 * 1024 * 1024,
      })
      await upload.done()
      await prisma.video.update({
        where: { id: v.id },
        data: {
          status: 'transcoding',
          transcodeError: null,
          // Pre-set storageKey to the eventual R2 original URL — matches what
          // upload-init does for new uploads, so transcode-complete can write
          // back consistently. Lambda will overwrite this on success anyway.
          storageKey: `https://${need('R2_PUBLIC_DOMAIN')}/videos/${v.id}/original.${ext}`,
        },
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
      console.log(`[migrate] ${v.id} ✓ staged + queued`)
    } catch (err) {
      console.error(`[migrate] ${v.id} ✗`, err instanceof Error ? err.message : err)
    }
    processed++
  }
  console.log(`[migrate] done: ${processed} processed`)
}

main().catch((err) => {
  console.error('[migrate] fatal', err)
  process.exit(1)
}).finally(() => prisma.$disconnect())
