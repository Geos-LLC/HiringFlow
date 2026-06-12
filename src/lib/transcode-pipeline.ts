import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'

// All R2/SQS/webhook secrets are read once at module load. Vercel injects them
// via env vars (set by `vercel env add` in the deploy script).
// Throwing here would crash the entire Next.js app at boot for any workspace
// that doesn't have these set yet — instead we surface missing config at the
// callsite when an upload is actually attempted, so unrelated routes stay up.
function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var: ${name}`)
  // `vercel env add` has a known footgun where a copy-pasted value carrying
  // a UTF-8 BOM (U+FEFF) and/or trailing CR/LF gets stored verbatim. The
  // characters then ride into interpolated URLs like
  // `https://<domain>/path` and downstream fetches 404. Strip BOM + ASCII
  // control whitespace at the read site so a single bad paste can't poison
  // dozens of callsites.
  return v.replace(/﻿/g, '').replace(/[\r\n\t]/g, '').trim()
}

function r2Client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: need('R2_ENDPOINT'),
    credentials: {
      accessKeyId: need('R2_ACCESS_KEY_ID'),
      secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: true,
  })
}

function sqsClient(): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: need('HF_SQS_PUBLISHER_ACCESS_KEY_ID'),
      secretAccessKey: need('HF_SQS_PUBLISHER_SECRET_ACCESS_KEY'),
    },
  })
}

export function r2PublicBase(): string {
  return `https://${need('R2_PUBLIC_DOMAIN')}`
}

export function stagingKeyForVideo(videoId: string, filename: string): string {
  // Sanitize: keep ASCII + dot + dash, replace everything else with '_'. The
  // staging bucket has a 1-day lifecycle so collisions don't matter much, but
  // keeping the filename readable helps when debugging stuck transcodes.
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'video'
  return `staging/${videoId}/${safe}`
}

// Presigned PUT URL the browser uses to upload directly to R2. The PUT MUST
// echo the same Content-Type back to R2 or the signature will fail — the
// caller is responsible for passing the right contentType here AND on the PUT.
export async function generateStagingPresignedPutUrl(opts: {
  stagingKey: string
  contentType: string
  expiresInSec?: number
}): Promise<string> {
  const s3 = r2Client()
  const cmd = new PutObjectCommand({
    Bucket: need('R2_STAGING_BUCKET'),
    Key: opts.stagingKey,
    ContentType: opts.contentType,
  })
  return getSignedUrl(s3, cmd, { expiresIn: opts.expiresInSec ?? 3600 })
}

// Publish a transcode job to SQS. The Lambda's event source mapping fans this
// out to the transcoder container with BatchSize=1 so ffmpeg gets the whole
// container's CPU budget.
export async function publishTranscodeJob(opts: {
  videoId: string
  stagingKey: string
  filename: string
  mimeType: string
  callbackUrl: string
}): Promise<string> {
  const sqs = sqsClient()
  const res = await sqs.send(new SendMessageCommand({
    QueueUrl: need('HF_TRANSCODE_QUEUE_URL'),
    MessageBody: JSON.stringify(opts),
  }))
  return res.MessageId ?? ''
}
