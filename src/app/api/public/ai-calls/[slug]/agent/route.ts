import { NextRequest, NextResponse } from 'next/server'
import { fetchWithEachKey } from '@/lib/elevenlabs'

export async function GET(request: NextRequest, { params }: { params: { slug: string } }) {
  const agentId = params.slug

  const res = await fetchWithEachKey(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`)

  if (!res.ok) {
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: res.status })
  }

  const agent = await res.json()

  // Extract evaluation criteria from platform_settings.evaluation.criteria
  const criteria = agent.platform_settings?.evaluation?.criteria || []

  return NextResponse.json({
    name: agent.name,
    criteria: criteria.map((c: any) => ({
      id: c.id,
      name: c.name,
      prompt: c.conversation_goal_prompt || '',
    })),
  })
}
