import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { validateAccessToken, getOrCreateEnrollment } from '@/lib/training-access'
import { bumpSessionProgress } from '@/lib/session-activity'
import { logger } from '@/lib/logger'

// Called by the public training viewer when the candidate presses the Start
// button. This is the ONLY entry point that creates a TrainingEnrollment
// and fires the `training_started` automation event — opening the
// invitation link no longer counts as "started" (previously the GET
// handler eagerly created the enrollment, which meant Gmail link-scanners
// and casual previews falsely advanced the funnel).
export async function POST(request: NextRequest, { params }: { params: { slug: string } }) {
  const body = await request.json().catch(() => ({}))
  const token: string | undefined = body?.token

  const training = await prisma.training.findUnique({
    where: { slug: params.slug },
    select: { id: true, accessMode: true, isPublished: true },
  })

  if (!training || !training.isPublished) {
    return NextResponse.json({ error: 'Training not found' }, { status: 404 })
  }

  if (training.accessMode !== 'invitation_only') {
    return NextResponse.json({ enrollmentId: null, status: null }, { status: 200 })
  }

  if (!token) {
    return NextResponse.json({ error: 'Access token required', code: 'TOKEN_REQUIRED' }, { status: 403 })
  }

  const accessToken = await validateAccessToken(token, training.id)
  if (!accessToken) {
    return NextResponse.json({ error: 'Access unavailable or expired', code: 'TOKEN_INVALID' }, { status: 403 })
  }

  const enrollment = await getOrCreateEnrollment({
    trainingId: training.id,
    accessTokenId: accessToken.id,
    sessionId: accessToken.candidateId,
    userName: accessToken.candidate?.candidateName || null,
    userEmail: accessToken.candidate?.candidateEmail || null,
  })

  // Real forward-progress signal — pressing Start is a deliberate action,
  // unlike passively opening the landing page.
  if (accessToken.candidateId) {
    void bumpSessionProgress(accessToken.candidateId)
  }

  logger.info('public_training_start', {
    slug: params.slug,
    trainingId: training.id,
    enrollmentId: enrollment.id,
    sessionId: accessToken.candidateId,
  })

  return NextResponse.json({
    enrollmentId: enrollment.id,
    status: enrollment.status,
    progress: enrollment.progress,
  })
}
