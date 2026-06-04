/**
 * AI call candidates scoped to a specific HiringFlow candidate (Session).
 * Lets the candidate detail page render the candidate's AI training agent
 * records inline, create new ones pre-linked to this session, and list
 * conversation transcripts.
 *
 *   GET  → AICallCandidate[] (this session only)
 *   POST → create a new AICallCandidate already linked to this session
 *          body: { agentId: string, name?: string }
 */
import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!session) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })

  const candidates = await prisma.aICallCandidate.findMany({
    where: { workspaceId: ws.workspaceId, sessionId: params.id },
    orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json({ candidates })
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true, candidateName: true, candidateEmail: true },
  })
  if (!session) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })

  const { agentId, name } = await request.json()
  if (!agentId || typeof agentId !== 'string') {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 })
  }

  const displayName = (name?.trim()) || session.candidateName || session.candidateEmail || 'Candidate'

  const candidate = await prisma.aICallCandidate.create({
    data: {
      workspaceId: ws.workspaceId,
      sessionId: params.id,
      name: displayName,
      agentId,
    },
  })

  return NextResponse.json({ candidate })
}
