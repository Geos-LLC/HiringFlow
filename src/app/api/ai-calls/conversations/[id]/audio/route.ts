import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const platformKey = await prisma.platformSetting.findUnique({ where: { key: 'elevenlabs_api_key' } })
  if (!platformKey?.value) {
    return NextResponse.json({ error: 'ElevenLabs API key not configured' }, { status: 400 })
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${params.id}/audio`, {
    headers: { 'xi-api-key': platformKey.value },
  })
  if (!res.ok) {
    return NextResponse.json({ error: `ElevenLabs audio fetch failed: ${res.status}` }, { status: res.status })
  }

  // ElevenLabs streams without Accept-Ranges, so the browser would disable
  // seek. Buffer the full body and serve Range slices ourselves so the audio
  // element gets a working scrub bar.
  const buf = await res.arrayBuffer()
  const contentType = res.headers.get('content-type') || 'audio/mpeg'
  return rangeResponse(buf, contentType, request.headers.get('range'))
}

function rangeResponse(buf: ArrayBuffer, contentType: string, range: string | null) {
  const total = buf.byteLength
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/)
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0
      const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start >= 0) {
        const chunk = buf.slice(start, end + 1)
        return new Response(chunk, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Length': chunk.byteLength.toString(),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=3600',
          },
        })
      }
    }
  }
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': total.toString(),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
