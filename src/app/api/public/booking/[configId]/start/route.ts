/**
 * POST /api/public/booking/[configId]/start
 *
 * Public — no auth, used for the global shareable booking URL.
 * Accepts {name, email, phone?}, creates a synthetic Session bound to the
 * config's workspace, returns a signed booking token. The frontend then
 * navigates to /book/<configId>?t=<token> and the normal booking flow runs.
 *
 * Spam control: simple per-IP token bucket. 5 starts per IP per 10 minutes
 * is enough for a single recruiter's testing without letting a bot create
 * thousands of orphan sessions.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { issueBookingToken } from '@/lib/scheduling/booking-links'

const ipBuckets = new Map<string, { count: number; resetAt: number }>()
function rateOk(ip: string): boolean {
  const now = Date.now()
  const cur = ipBuckets.get(ip)
  if (!cur || now >= cur.resetAt) {
    ipBuckets.set(ip, { count: 1, resetAt: now + 10 * 60_000 })
    return true
  }
  if (cur.count >= 5) return false
  cur.count++
  return true
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(request: NextRequest, { params }: { params: { configId: string } }) {
  const body = await request.json().catch(() => ({})) as {
    name?: string
    email?: string
    phone?: string
  }
  const name = (body.name || '').trim()
  const email = (body.email || '').trim()
  const phone = (body.phone || '').trim()
  if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 })
  if (!email || !EMAIL_RX.test(email)) return NextResponse.json({ error: 'invalid_email' }, { status: 400 })

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateOk(ip)) return NextResponse.json({ error: 'rate_limited' }, { status: 429 })

  const config = await prisma.schedulingConfig.findUnique({
    where: { id: params.configId },
    select: { id: true, workspaceId: true, isActive: true, useBuiltInScheduler: true },
  })
  if (!config || !config.isActive) {
    return NextResponse.json({ error: 'config_not_found' }, { status: 404 })
  }
  if (!config.useBuiltInScheduler) {
    return NextResponse.json({ error: 'not_built_in' }, { status: 400 })
  }

  // Need a flow to attach the session to. Pick the workspace's first
  // active flow — sessions in HireFunnel's data model can't exist
  // without one. Fall back to any flow if none are active.
  const flow = await prisma.flow.findFirst({
    where: { workspaceId: config.workspaceId },
    orderBy: [{ isPublished: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  })
  if (!flow) {
    return NextResponse.json({
      error: 'no_flow_available',
      message: 'Workspace must have at least one flow before public bookings are possible',
    }, { status: 409 })
  }

  // Reuse session if same email already started one in the last hour to
  // avoid creating a new session on every refresh of the booking page.
  let session = await prisma.session.findFirst({
    where: {
      workspaceId: config.workspaceId,
      candidateEmail: email,
      source: 'public_booking',
      startedAt: { gt: new Date(Date.now() - 60 * 60_000) },
    },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  })

  if (!session) {
    // V1: writes 'training_completed' as before. V2 (workspace/pipeline
    // opted in): writes the pipeline's first stage id. Fallback to the
    // legacy value if V2 pipeline resolution fails — public booking must
    // never 500 on session create.
    const { getInitialPipelineStatusForCreate } = await import('@/lib/pipeline-transitions')
    const initialStatus = await getInitialPipelineStatusForCreate({
      workspaceId: config.workspaceId,
      flowId: flow.id,
      legacyStatus: 'training_completed',
    })
    session = await prisma.session.create({
      data: {
        workspaceId: config.workspaceId,
        flowId: flow.id,
        candidateName: name,
        candidateEmail: email,
        candidatePhone: phone || null,
        source: 'public_booking',
        pipelineStatus: initialStatus,
      },
      select: { id: true },
    })
  } else {
    // Update name/phone on the reused session if they changed.
    await prisma.session.update({
      where: { id: session.id },
      data: { candidateName: name, candidatePhone: phone || null },
    })
  }

  const token = issueBookingToken({
    sessionId: session.id,
    configId: config.id,
    purpose: 'book',
    daysFromNow: 1, // public flow is "book within 24h" by design
  })

  return NextResponse.json({ token })
}
