import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const BUCKET = process.env.S3_BUCKET || 'hiringflow-uploads'
const REGION = process.env.S3_REGION || 'us-east-1'

function getS3Client() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`S3 credentials not configured. AWS_ACCESS_KEY_ID: ${accessKeyId ? 'SET' : 'MISSING'}, AWS_SECRET_ACCESS_KEY: ${secretAccessKey ? 'SET' : 'MISSING'}`)
  }

  return new S3Client({
    region: REGION,
    credentials: { accessKeyId, secretAccessKey },
  })
}

export async function getUploadPresignedUrl(key: string, contentType: string): Promise<string> {
  const s3 = getS3Client()
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  })
  return getSignedUrl(s3, command, { expiresIn: 3600 })
}

// Short-lived signed GET for private playback. Use for capture-response media
// where the recruiter dashboard needs to stream audio/video without making the
// object public. Default TTL of 5 minutes — long enough for the recruiter to
// click play, short enough that a leaked URL doesn't sit indefinitely.
export async function getDownloadPresignedUrl(
  key: string,
  opts: { expiresInSec?: number; responseContentType?: string } = {}
): Promise<string> {
  const s3 = getS3Client()
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentType: opts.responseContentType,
  })
  return getSignedUrl(s3, command, { expiresIn: opts.expiresInSec ?? 300 })
}

// HEAD an object — returns null if missing/forbidden, otherwise the object
// metadata (size, content-type, etag). Used by the capture finalize route to
// confirm that the presigned PUT actually landed before we transition the row
// to status='uploaded'.
export async function headObject(
  key: string
): Promise<{ contentType?: string; contentLength?: number; etag?: string } | null> {
  const s3 = getS3Client()
  try {
    const out = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return {
      contentType: out.ContentType,
      contentLength: out.ContentLength,
      etag: out.ETag,
    }
  } catch (err: any) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
      return null
    }
    throw err
  }
}

// Server-side download of an object. Returns the raw bytes or null when the
// object is missing/forbidden. Used by the media observation engine to feed
// audio/video data straight into the OpenAI multimodal API without proxying
// through a presigned URL.
export async function s3Download(key: string): Promise<ArrayBuffer | null> {
  const s3 = getS3Client()
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    if (!out.Body) return null
    const chunks: Buffer[] = []
    for await (const chunk of out.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).buffer.slice(0) as ArrayBuffer
  } catch (err: any) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') {
      return null
    }
    throw err
  }
}

export function getPublicUrl(key: string): string {
  if (process.env.CLOUDFRONT_DOMAIN) {
    return `https://${process.env.CLOUDFRONT_DOMAIN}/${key}`
  }
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`
}

export { BUCKET, REGION }
