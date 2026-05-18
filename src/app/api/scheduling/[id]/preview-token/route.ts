/**
 * POST /api/scheduling/[id]/preview-token
 *
 * Authenticated — issues a short-lived (5 min) booking token for the
 * recruiter to preview the candidate-facing slot picker. Uses any
 * existing workspace session as the "candidate" (so the picker has
 * something to bind to). If the workspace has no sessions yet, creates
 * a synthetic preview session.
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { issueBookingToken } from '@/lib/scheduling/booking-links'
import { getAppUrl } from '@/lib/google'

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const config = await prisma.schedulingConfig.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true, useBuiltInScheduler: true, isActive: true },
  })
  if (!config || !config.isActive) {
    return NextResponse.json({ error: 'config_not_found' }, { status: 404 })
  }
  if (!config.useBuiltInScheduler) {
    return NextResponse.json({ error: 'preview_only_for_built_in' }, { status: 400 })
  }

  // Find any session to bind the preview token to. Real-candidate session
  // first; otherwise create a synthetic one tagged with source='preview' so
  // it's filtered out of the candidate pipeline.
  let sessionId: string
  const real = await prisma.session.findFirst({
    where: { workspaceId: ws.workspaceId },
    orderBy: { lastActivityAt: 'desc' },
    select: { id: true },
  })
  if (real) {
    sessionId = real.id
  } else {
    // Need a flow to attach to; pick any.
    const flow = await prisma.flow.findFirst({
      where: { workspaceId: ws.workspaceId },
      select: { id: true },
    })
    if (!flow) {
      return NextResponse.json({
        error: 'no_session_available',
        message: 'Create at least one flow with a session before previewing the picker',
      }, { status: 409 })
    }
    // V1: writes 'training_completed' for the preview session. V2: writes
    // the pipeline's first stage id. Preview sessions are throwaway so the
    // fallback path doesn't matter much here, but we route through the same
    // helper for consistency.
    const { getInitialPipelineStatusForCreate } = await import('@/lib/pipeline-transitions')
    const initialStatus = await getInitialPipelineStatusForCreate({
      workspaceId: ws.workspaceId,
      flowId: flow.id,
      legacyStatus: 'training_completed',
    })
    const synthetic = await prisma.session.create({
      data: {
        workspaceId: ws.workspaceId,
        flowId: flow.id,
        candidateName: 'Preview',
        candidateEmail: 'preview@example.com',
        source: 'preview',
        pipelineStatus: initialStatus,
      },
    })
    sessionId = synthetic.id
  }

  const token = issueBookingToken({
    sessionId,
    configId: config.id,
    purpose: 'book',
    expiresAt: new Date(Date.now() + 5 * 60_000),
  })
  const url = `${getAppUrl()}/book/${config.id}?t=${encodeURIComponent(token)}`
  return NextResponse.json({ url, expiresInSeconds: 300 })
}
