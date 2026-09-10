/**
 * MockCustomer simulations for a HireFunnel candidate (Session).
 *
 *   GET  → McSimulation[] for this session, most recent first.
 *   POST → launch a new MockCustomer simulation for this session.
 *
 * PR1B semantics: manual-launch only. The candidate detail page is the
 * only surface that calls this endpoint; Flow/stage automation is a
 * PR2 responsibility and will invoke `SimulationRunner.launch` through
 * a second caller, not through a second execution path.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { McSimulationRunner } from '@/lib/simulation/mc-runner'
import { SimulationLaunchError } from '@/lib/simulation/runner'

export const dynamic = 'force-dynamic'

function resolveWebhookCallbackUrl(request: NextRequest): string {
  const configured = process.env.MC_WEBHOOK_CALLBACK_URL
  if (configured && /^https?:\/\//i.test(configured)) {
    return configured.replace(/\/$/, '') + '/api/webhooks/mockcustomer'
  }
  const proto = request.headers.get('x-forwarded-proto') ?? 'https'
  const host = request.headers.get('host') ?? request.nextUrl.host
  return `${proto}://${host}/api/webhooks/mockcustomer`
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const candidate = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!candidate) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })

  const rows = await prisma.mcSimulation.findMany({
    where: { workspaceId: ws.workspaceId, candidateId: params.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      mcCallId: true,
      mcOrganizationId: true,
      status: true,
      resultProjection: true,
      queuedAt: true,
      ringingAt: true,
      answeredAt: true,
      completedAt: true,
      failedAt: true,
      failureReason: true,
      createdAt: true,
    },
  })
  return NextResponse.json({ simulations: rows })
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  // Candidate scoping first — matches ai-call-candidates route idiom. A
  // cross-workspace candidate id (or a random id) must 404 before we
  // reach the runner, so the auth boundary is unambiguous.
  const candidate = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!candidate) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })

  const runner = new McSimulationRunner({
    prisma,
    webhookCallbackUrl: resolveWebhookCallbackUrl(request),
  })

  try {
    const result = await runner.launch({
      workspaceId: ws.workspaceId,
      candidateId: params.id,
      launchedByUserId: ws.userId,
    })
    return NextResponse.json(
      {
        simulationId: result.simulationId,
        mcCallId: result.mcCallId,
        status: result.status,
      },
      { status: 202 },
    )
  } catch (err) {
    if (err instanceof SimulationLaunchError) {
      const status =
        err.reason === 'candidate_not_found'
          ? 404
          : err.reason === 'candidate_missing_phone'
            ? 422
            : err.reason === 'mc_not_configured' || err.reason === 'canary_disabled'
              ? 403
              : err.reason === 'mc_timeout'
                ? 504
                : err.reason === 'mc_dial_rejected'
                  ? 502
                  : 500
      return NextResponse.json(
        { error: err.message, reason: err.reason, detail: err.detail },
        { status },
      )
    }
    console.error('[mc-simulations] launch failed', err)
    return NextResponse.json({ error: 'Internal error launching simulation' }, { status: 500 })
  }
}
