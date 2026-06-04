/**
 * GET /api/evaluations/preview-position-description?sessionId=...
 *
 * Returns the JD text the engine would feed to the model for this candidate,
 * so the recruiter can review/edit before running the actual evaluation.
 * Mirror of buildPositionDescription() — same resolution order.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { buildPositionDescription } from '@/lib/evaluation/position-description'

export async function GET(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const sessionId = new URL(request.url).searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const session = await prisma.session.findFirst({
    where: { id: sessionId, workspaceId: ws.workspaceId },
    include: { flow: true, ad: true, workspace: true },
  })
  if (!session) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })

  const { text, source } = await buildPositionDescription(session)
  return NextResponse.json({
    positionDescription: text,
    source,
    flowId: session.flowId,
    flowName: session.flow?.name ?? null,
  })
}
