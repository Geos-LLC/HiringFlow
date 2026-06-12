import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// Mint an anonymous shareable access token for a gated training so the
// recruiter can paste a direct link into Slack/DM/etc. Each click creates
// a fresh token (single-recipient — multiple viewers would collide on the
// trainingId_accessTokenId enrollment unique key). The viewer who opens
// the link gets an enrollment row with no Session/candidate attribution.
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const training = await prisma.training.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true, slug: true },
  })
  if (!training) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const token = randomBytes(32).toString('base64url')
  await prisma.trainingAccessToken.create({
    data: {
      token,
      trainingId: training.id,
      candidateId: null,
      sourceType: 'shareable',
      status: 'active',
    },
  })

  const origin = new URL(_request.url).origin
  return NextResponse.json({ url: `${origin}/t/${training.slug}?token=${token}` })
}
