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

  const range = request.headers.get('range')
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${params.id}/audio`, {
    headers: {
      'xi-api-key': platformKey.value,
      ...(range ? { range } : {}),
    },
  })

  if (!res.ok || !res.body) {
    return NextResponse.json({ error: `ElevenLabs audio fetch failed: ${res.status}` }, { status: res.status })
  }

  const headers = new Headers()
  headers.set('Content-Type', res.headers.get('content-type') || 'audio/mpeg')
  const cl = res.headers.get('content-length'); if (cl) headers.set('Content-Length', cl)
  const cr = res.headers.get('content-range'); if (cr) headers.set('Content-Range', cr)
  const ar = res.headers.get('accept-ranges'); if (ar) headers.set('Accept-Ranges', ar)

  return new Response(res.body, { status: res.status, headers })
}
