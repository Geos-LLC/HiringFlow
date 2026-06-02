import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET — stream audio for a single conversation. Scoped by candidate name +
// agentId; the conversationId must be in the candidate's conversationIds[] so a
// link holder can't pull audio for other candidates on the same agent.
export async function GET(request: NextRequest, { params }: { params: { slug: string } }) {
  const convId = request.nextUrl.searchParams.get('id')
  const name = request.nextUrl.searchParams.get('name')
  if (!convId || !name) {
    return NextResponse.json({ error: 'id and name required' }, { status: 400 })
  }

  const candidate = await prisma.aICallCandidate.findFirst({
    where: { name, agentId: params.slug },
    orderBy: { createdAt: 'desc' },
  })
  if (!candidate || !candidate.conversationIds.includes(convId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const platformKey = await prisma.platformSetting.findUnique({ where: { key: 'elevenlabs_api_key' } })
  if (!platformKey?.value) {
    return NextResponse.json({ error: 'Not configured' }, { status: 400 })
  }

  const range = request.headers.get('range')
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${convId}/audio`, {
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
