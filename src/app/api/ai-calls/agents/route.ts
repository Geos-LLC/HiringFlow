import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { getElevenLabsApiKeys } from '@/lib/elevenlabs'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const keys = await getElevenLabsApiKeys()
  if (keys.length === 0) {
    return NextResponse.json({ error: 'ElevenLabs not configured by platform admin' }, { status: 400 })
  }

  const results = await Promise.all(
    keys.map((k) =>
      fetch('https://api.elevenlabs.io/v1/convai/agents?page_size=100', {
        headers: { 'xi-api-key': k },
      }).then((r) => (r.ok ? r.json() : { agents: [] })),
    ),
  )
  const seen = new Set<string>()
  const merged: any[] = []
  for (const r of results) {
    for (const a of r.agents || []) {
      if (a.agent_id && !seen.has(a.agent_id)) {
        seen.add(a.agent_id)
        merged.push(a)
      }
    }
  }
  return NextResponse.json(merged)
}
