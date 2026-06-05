import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// Restore previously-revoked training access. Inverse of /revoke. Tokens
// that were used by the candidate (usedAt set) go back to 'used'; tokens
// that were never clicked go back to 'active'. validateAccessToken accepts
// both, so the candidate's original link works again either way.
//
// We keep the used/active split (instead of flipping everything to 'active')
// so the source-of-truth for "did they ever click this link" survives a
// revoke→restore round-trip.
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string; trainingId: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!session) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })

  const training = await prisma.training.findFirst({
    where: { id: params.trainingId, workspaceId: ws.workspaceId },
    select: { id: true, title: true },
  })
  if (!training) return NextResponse.json({ error: 'Training not found' }, { status: 404 })

  const [usedBack, activeBack] = await Promise.all([
    prisma.trainingAccessToken.updateMany({
      where: {
        candidateId: session.id,
        trainingId: training.id,
        status: 'revoked',
        usedAt: { not: null },
      },
      data: { status: 'used' },
    }),
    prisma.trainingAccessToken.updateMany({
      where: {
        candidateId: session.id,
        trainingId: training.id,
        status: 'revoked',
        usedAt: null,
      },
      data: { status: 'active' },
    }),
  ])

  return NextResponse.json({
    restoredCount: usedBack.count + activeBack.count,
    trainingTitle: training.title,
  })
}
