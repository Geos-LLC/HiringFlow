import { NextRequest, NextResponse } from 'next/server'
import { fetchWithEachKey } from '@/lib/elevenlabs'

// GET — fetch all conversations for this agent (same data as admin)
export async function GET(request: NextRequest, { params }: { params: { slug: string } }) {
  const agentId = params.slug
  const convId = request.nextUrl.searchParams.get('id')

  // Single conversation detail
  if (convId) {
    const res = await fetchWithEachKey(`https://api.elevenlabs.io/v1/convai/conversations/${convId}`)
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch' }, { status: res.status })
    const data = await res.json()
    // ElevenLabs detail nests call_duration_secs under metadata; lift it for clients
    // that read it at the top level (e.g. the call page detail panel).
    return NextResponse.json({
      ...data,
      call_duration_secs: data.metadata?.call_duration_secs ?? data.call_duration_secs ?? 0,
    })
  }

  // List all conversations for this agent (agent belongs to one account; one key wins)
  const res = await fetchWithEachKey(
    `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${agentId}&page_size=100`,
  )
  if (!res.ok) {
    return NextResponse.json({ error: 'Failed to fetch' }, { status: res.status })
  }

  return NextResponse.json(await res.json())
}
