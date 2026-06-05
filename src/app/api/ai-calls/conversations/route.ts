import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { fetchWithEachKey } from '@/lib/elevenlabs'

export async function GET(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  // Get agent ID from workspace settings
  const workspace = await prisma.workspace.findUnique({ where: { id: ws.workspaceId } })
  const wsSettings = (workspace?.settings || {}) as Record<string, string>
  const agentId = wsSettings.elevenlabs_agent_id

  if (!agentId) {
    return NextResponse.json({ error: 'ElevenLabs Agent ID not configured. Set it in AI Calls settings.' }, { status: 400 })
  }

  // Agent belongs to exactly one of the configured ElevenLabs accounts — try
  // each key, use the one that successfully owns the agent.
  const res = await fetchWithEachKey(
    `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${agentId}&page_size=100`,
  )

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: `ElevenLabs API error: ${res.status}`, details: err }, { status: res.status })
  }

  return NextResponse.json(await res.json())
}
