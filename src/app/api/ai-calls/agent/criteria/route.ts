import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getElevenLabsApiKeys, fetchWithEachKey } from '@/lib/elevenlabs'

// Resolve which configured key owns a given agent. Returns null if no key
// can fetch the agent (404/403 from all). PATCH needs this so the update
// goes to the right account.
async function findKeyForAgent(agentId: string): Promise<string | null> {
  const keys = await getElevenLabsApiKeys()
  for (const k of keys) {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      headers: { 'xi-api-key': k },
    })
    if (r.ok) return k
  }
  return null
}

// GET — fetch current agent evaluation criteria
export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const workspace = await prisma.workspace.findUnique({ where: { id: ws.workspaceId } })
  const agentId = (workspace?.settings as any)?.elevenlabs_agent_id
  if (!agentId) return NextResponse.json({ error: 'No agent configured' }, { status: 400 })

  const res = await fetchWithEachKey(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`)
  if (!res.ok) return NextResponse.json({ error: 'Failed to fetch agent' }, { status: res.status })

  const agent = await res.json()
  const criteria = agent.platform_settings?.evaluation?.criteria || []
  const firstCriteria = criteria[0] || {}

  return NextResponse.json({
    agentId,
    agentName: agent.name,
    criteriaId: firstCriteria.id || 'call_evaluation',
    criteriaName: firstCriteria.name || 'Call evaluation',
    prompt: firstCriteria.conversation_goal_prompt || '',
  })
}

// PATCH — update the evaluation criteria prompt on ElevenLabs
export async function PATCH(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const workspace = await prisma.workspace.findUnique({ where: { id: ws.workspaceId } })
  const agentId = (workspace?.settings as any)?.elevenlabs_agent_id
  if (!agentId) return NextResponse.json({ error: 'No agent configured' }, { status: 400 })

  const apiKey = await findKeyForAgent(agentId)
  if (!apiKey) return NextResponse.json({ error: 'No API key owns this agent' }, { status: 400 })

  const { criteriaId, criteriaName, prompt } = await request.json()

  const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    method: 'PATCH',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      platform_settings: {
        evaluation: {
          criteria: [{
            id: criteriaId || 'call_evaluation',
            name: criteriaName || 'Call evaluation',
            type: 'prompt',
            conversation_goal_prompt: prompt,
          }],
        },
      },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: `Failed to update: ${res.status}`, details: err }, { status: res.status })
  }

  return NextResponse.json({ success: true })
}
