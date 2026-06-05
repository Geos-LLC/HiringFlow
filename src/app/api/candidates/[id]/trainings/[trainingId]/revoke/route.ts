import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// Revoke every TrainingAccessToken this candidate has for the given training.
// Flips status='revoked' on rows currently 'active' or 'used', so the public
// /api/public/trainings/[slug] route's validateAccessToken() will reject the
// token on next read (only 'active' | 'used' are accepted there).
//
// Caveats:
//   - We don't delete TrainingEnrollment — past progress and completion
//     events stay on the timeline.
//   - For Training.accessMode='public', tokens are not consulted at all, so
//     revoking has no effect. We return the row to surface that.
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
    select: { id: true, title: true, accessMode: true },
  })
  if (!training) return NextResponse.json({ error: 'Training not found' }, { status: 404 })

  const result = await prisma.trainingAccessToken.updateMany({
    where: {
      candidateId: session.id,
      trainingId: training.id,
      status: { in: ['active', 'used'] },
    },
    data: { status: 'revoked' },
  })

  return NextResponse.json({
    revokedCount: result.count,
    trainingTitle: training.title,
    accessMode: training.accessMode,
  })
}
