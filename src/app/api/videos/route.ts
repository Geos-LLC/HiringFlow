import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { saveVideoFile, getVideoUrl } from '@/lib/storage'

export async function GET(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const kindParam = request.nextUrl.searchParams.get('kind')
  const kind = kindParam === 'interview' || kindParam === 'training' ? kindParam : null

  try {
    const videos = await prisma.video.findMany({
      where: { workspaceId: ws.workspaceId, ...(kind && { kind }) },
      orderBy: { createdAt: 'desc' },
    })

    const videosWithUrls = videos.map((video) => ({
      ...video,
      url: getVideoUrl(video.storageKey),
    }))

    return NextResponse.json(videosWithUrls)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    console.error('[api/videos GET] failed', { workspaceId: ws.workspaceId, kind, error: message, stack })
    return NextResponse.json({ error: 'Failed to load videos', detail: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  try {
    const formData = await request.formData()

    // Support both single 'video' and multiple 'videos' fields
    const singleFile = formData.get('video') as File | null
    const multipleFiles = formData.getAll('videos') as File[]
    const kindField = formData.get('kind')
    const kind = kindField === 'interview' ? 'interview' : 'training'

    const files = singleFile ? [singleFile] : multipleFiles

    if (files.length === 0) {
      return NextResponse.json({ error: 'No video files provided' }, { status: 400 })
    }

    const uploaded = []
    const errors = []

    for (const file of files) {
      if (!file.type.startsWith('video/')) {
        errors.push({ filename: file.name, error: 'Not a video file' })
        continue
      }

      try {
        const { storageKey, filename, mimeType, sizeBytes } = await saveVideoFile(file)

        const video = await prisma.video.create({
          data: {
            workspaceId: ws.workspaceId,
            createdById: ws.userId,
            filename,
            storageKey,
            mimeType,
            sizeBytes: BigInt(Math.max(0, Math.floor(Number(sizeBytes) || 0))),
            kind,
          },
        })

        uploaded.push({
          ...video,
          url: getVideoUrl(video.storageKey),
        })

        // Fire-and-forget: trigger analysis
        const baseUrl = request.nextUrl.origin
        fetch(`${baseUrl}/api/videos/${video.id}/analyze`, {
          method: 'POST',
          headers: { cookie: request.headers.get('cookie') || '' },
        }).catch(() => {})
      } catch (err) {
        errors.push({ filename: file.name, error: 'Upload failed' })
      }
    }

    // For backward compatibility: if single file was uploaded, return single object
    if (singleFile && uploaded.length === 1) {
      return NextResponse.json(uploaded[0])
    }

    // For multiple files, return detailed response
    return NextResponse.json({
      uploaded,
      errors,
      total: files.length,
      successful: uploaded.length,
    })
  } catch (error) {
    console.error('Video upload error:', error)
    return NextResponse.json({ error: 'Failed to upload video' }, { status: 500 })
  }
}
