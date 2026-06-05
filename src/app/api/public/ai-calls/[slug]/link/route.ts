import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchWithEachKey } from '@/lib/elevenlabs'

interface ElevenLabsConvSummary {
  conversation_id: string
  status: string
  start_time_unix_secs: number
  call_duration_secs: number
  message_count: number
  call_successful: string | null
  transcript_summary: string | null
}

// Mirrors the call page's score parser so the cards/list can render the numeric
// score without re-fetching the full conversation detail.
function parseScore(rationale: string): { value: number; total: number; label: string } | null {
  if (!rationale) return null
  const m =
    rationale.match(/Score:\s*(\d+)\s*\/\s*(\d+)\s*\(\s*([^)]+?)\s*\)/) ||
    rationale.match(/(\d+)\s*\/\s*100\s*\(\s*([^)]+?)\s*\)/) ||
    rationale.match(/(\d+)\s*\/\s*100/)
  if (!m) return null
  const value = parseInt(m[1])
  if (m[3]) return { value, total: parseInt(m[2]), label: m[3].trim() }
  if (m[2] && isNaN(parseInt(m[2]))) return { value, total: 100, label: m[2].trim() }
  const label = value >= 90 ? 'Excellent' : value >= 80 ? 'Good' : value >= 70 ? 'Needs Improvement' : 'Requires Retraining'
  return { value, total: parseInt(m[2]) || 100, label }
}

// POST — candidate reports a conversation ID to link to their name
export async function POST(request: NextRequest, { params }: { params: { slug: string } }) {
  const { candidateName, conversationId } = await request.json()

  if (!candidateName || !conversationId) {
    return NextResponse.json({ error: 'candidateName and conversationId required' }, { status: 400 })
  }

  // Find candidate by name + agentId
  const candidate = await prisma.aICallCandidate.findFirst({
    where: { name: candidateName, agentId: params.slug },
    orderBy: { createdAt: 'desc' },
  })

  if (candidate && !candidate.conversationIds.includes(conversationId)) {
    await prisma.aICallCandidate.update({
      where: { id: candidate.id },
      data: { conversationIds: [...candidate.conversationIds, conversationId] },
    })
  }

  return NextResponse.json({ success: true })
}

// GET — get conversations for a specific candidate name. Auto-links any unassigned
// conversations that started after this candidate was created (mirrors the dashboard's
// `viewCandidateConvs` logic), so candidates see their results without admin intervention.
export async function GET(request: NextRequest, { params }: { params: { slug: string } }) {
  const name = request.nextUrl.searchParams.get('name')

  // No upfront key check — fetchWithEachKey returns a 400 response when no keys
  // are configured, and per-call try-each-key handles the rest.

  // If name provided, find candidate, auto-link new conversations, then return their list
  if (name) {
    const candidate = await prisma.aICallCandidate.findFirst({
      where: { name, agentId: params.slug },
      orderBy: { createdAt: 'desc' },
    })

    if (!candidate) return NextResponse.json({ conversations: [] })

    // Pull all agent conversations from ElevenLabs to look for unassigned ones
    const listRes = await fetchWithEachKey(
      `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${params.slug}&page_size=100`,
    )
    const allConvs: ElevenLabsConvSummary[] = listRes.ok
      ? ((await listRes.json()).conversations || [])
      : []

    // Find every conversation already assigned to any candidate in this workspace+agent
    const workspaceCandidates = await prisma.aICallCandidate.findMany({
      where: { workspaceId: candidate.workspaceId, agentId: params.slug },
    })
    const assignedIds = new Set(workspaceCandidates.flatMap(c => c.conversationIds))
    const candidateCreatedSec = Math.floor(new Date(candidate.createdAt).getTime() / 1000)

    // Auto-link unassigned conversations that started after this candidate was created.
    // Skip a conversation if another candidate was created between this candidate and the
    // conversation's start (the conversation is more likely the later candidate's).
    const newlyLinked: string[] = []
    for (const conv of allConvs) {
      if (assignedIds.has(conv.conversation_id)) continue
      if (conv.start_time_unix_secs < candidateCreatedSec - 60) continue
      const otherCreatedBetween = workspaceCandidates.some(c =>
        c.id !== candidate.id &&
        Math.floor(new Date(c.createdAt).getTime() / 1000) > candidateCreatedSec &&
        Math.floor(new Date(c.createdAt).getTime() / 1000) <= conv.start_time_unix_secs
      )
      if (otherCreatedBetween) continue
      newlyLinked.push(conv.conversation_id)
      assignedIds.add(conv.conversation_id)
    }

    let conversationIds = candidate.conversationIds
    if (newlyLinked.length > 0) {
      conversationIds = [...candidate.conversationIds, ...newlyLinked]
      await prisma.aICallCandidate.update({
        where: { id: candidate.id },
        data: { conversationIds },
      })
    }

    if (conversationIds.length === 0) return NextResponse.json({ conversations: [] })

    // Fetch detail for each linked conversation and normalize to list format
    const convDetails = await Promise.all(
      conversationIds.map(async (cid) => {
        const r = await fetchWithEachKey(`https://api.elevenlabs.io/v1/convai/conversations/${cid}`)
        if (!r.ok) return null
        const d = await r.json()
        const rationale = (Object.values(d.analysis?.evaluation_criteria_results || {})[0] as { rationale?: string } | undefined)?.rationale || ''
        const score = parseScore(rationale)
        return {
          conversation_id: d.conversation_id,
          status: d.status,
          start_time_unix_secs: d.metadata?.start_time_unix_secs || Math.floor(new Date(d.metadata?.created_at || 0).getTime() / 1000),
          call_duration_secs: d.metadata?.call_duration_secs || d.call_duration_secs || 0,
          message_count: d.transcript?.length || 0,
          call_successful: d.analysis?.call_successful || null,
          transcript_summary: d.analysis?.transcript_summary || null,
          evaluation_score: score?.value ?? null,
          evaluation_total: score?.total ?? null,
          evaluation_label: score?.label ?? null,
        }
      })
    )
    return NextResponse.json({ conversations: convDetails.filter(Boolean) })
  }

  // No name — return all conversations (for backward compat)
  const res = await fetchWithEachKey(
    `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${params.slug}&page_size=100`,
  )
  if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
  return NextResponse.json(await res.json())
}
