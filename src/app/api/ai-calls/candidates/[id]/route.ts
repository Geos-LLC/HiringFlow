import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// PATCH — add a conversation ID to a candidate AND/OR link the agent record
// to a HiringFlow Session. Body: { conversationId?: string, sessionId?: string | null }.
// sessionId=null detaches.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const candidate = await prisma.aICallCandidate.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!candidate) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json()
  const { conversationId, sessionId } = body as { conversationId?: string; sessionId?: string | null }

  const data: { conversationIds?: string[]; sessionId?: string | null } = {}

  if (conversationId && !candidate.conversationIds.includes(conversationId)) {
    data.conversationIds = [...candidate.conversationIds, conversationId]
  }

  if (sessionId !== undefined) {
    if (sessionId === null) {
      data.sessionId = null
    } else {
      const session = await prisma.session.findFirst({
        where: { id: sessionId, workspaceId: ws.workspaceId },
        select: { id: true },
      })
      if (!session) return NextResponse.json({ error: 'Candidate (session) not found in this workspace' }, { status: 404 })
      data.sessionId = sessionId
    }
  }

  if (Object.keys(data).length > 0) {
    await prisma.aICallCandidate.update({ where: { id: params.id }, data })
  }

  return NextResponse.json({ success: true })
}

// DELETE
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  await prisma.aICallCandidate.deleteMany({ where: { id: params.id, workspaceId: ws.workspaceId } })
  return NextResponse.json({ success: true })
}
