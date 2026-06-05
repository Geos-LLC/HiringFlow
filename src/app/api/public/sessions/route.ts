import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { validateEmail, validatePhone } from '@/lib/contact-validation'

/**
 * True if the email matches anyone "internal" to the workspace: a workspace
 * member, OR the email of the connected Google integration account. Owners
 * testing the candidate flow with their own email used to silently poison
 * Calendly attribution (see project_calendly_organizer_match_bug.md) — the
 * matcher fix in google-event-processor handles that root cause, but we also
 * mark these submissions as `source='test'` so they're segregated from the
 * real candidate funnel (analytics, kanban, stalled-detection all already
 * filter source='test').
 */
async function isInternalEmail(workspaceId: string, email: string): Promise<boolean> {
  const lower = email.toLowerCase()
  const [memberHit, integ] = await Promise.all([
    prisma.workspaceMember.findFirst({
      where: { workspaceId, user: { email: { equals: lower, mode: 'insensitive' } } },
      select: { id: true },
    }),
    prisma.googleIntegration.findUnique({
      where: { workspaceId },
      select: { googleEmail: true },
    }),
  ])
  if (memberHit) return true
  if (integ?.googleEmail && integ.googleEmail.toLowerCase() === lower) return true
  return false
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { flowSlug, candidateName, candidateEmail, candidatePhone, preview, adId, source, campaign } = body

    if (!flowSlug) {
      return NextResponse.json({ error: 'Flow slug is required' }, { status: 400 })
    }

    // Validate + normalize candidate email/phone server-side. The client
    // already does this for inline UX, but a hostile or buggy client
    // could still post a malformed value (e.g. "@gmail.comd") — and once
    // it's persisted, every email/SMS sent to that candidate bounces and
    // strands them. Empty/null is allowed here; required-field gating
    // is owned by the start screen config.
    let normalizedEmail: string | null = null
    let normalizedPhone: string | null = null
    if (typeof candidateEmail === 'string' && candidateEmail.trim()) {
      const r = validateEmail(candidateEmail)
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
      normalizedEmail = r.value
    }
    if (typeof candidatePhone === 'string' && candidatePhone.trim()) {
      const r = validatePhone(candidatePhone)
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
      normalizedPhone = r.value
    }

    let flow

    if (preview) {
      // Preview mode: allow unpublished flows for workspace members
      const ws = await getWorkspaceSession()
      if (!ws) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      flow = await prisma.flow.findFirst({
        where: {
          slug: flowSlug,
          workspaceId: ws.workspaceId,
        },
        include: {
          steps: {
            orderBy: { stepOrder: 'asc' },
            take: 1,
          },
        },
      })
    } else {
      flow = await prisma.flow.findFirst({
        where: {
          slug: flowSlug,
          isPublished: true,
        },
        include: {
          steps: {
            orderBy: { stepOrder: 'asc' },
            take: 1,
          },
        },
      })
    }

    if (!flow) {
      return NextResponse.json({ error: 'Flow not found' }, { status: 404 })
    }

    const startStepId = flow.steps[0]?.id || null

    // Auto-tag owner self-tests so they can't poison the real candidate
    // funnel. Triggered when the candidate email matches a workspace
    // member or the connected Google account. Overrides whatever ad/source
    // attribution would otherwise apply — `source='test'` is the consistent
    // marker the rest of the codebase reads.
    let effectiveSource: string | null = source || null
    if (normalizedEmail) {
      const internal = await isInternalEmail(flow.workspaceId, normalizedEmail)
      if (internal) {
        effectiveSource = 'test'
        logger.info('Session auto-tagged as test (internal email)', {
          flowSlug,
          workspaceId: flow.workspaceId,
          candidateEmail: normalizedEmail,
        })
      }
    }

    const session = await prisma.session.create({
      data: {
        flowId: flow.id,
        workspaceId: flow.workspaceId,
        candidateName: candidateName || null,
        candidateEmail: normalizedEmail,
        candidatePhone: normalizedPhone,
        lastStepId: startStepId,
        lastActivityAt: new Date(),
        lastProgressAt: new Date(),
        // Source attribution (from Ad link)
        adId: adId || null,
        source: effectiveSource,
        campaign: campaign || null,
      },
    })

    logger.info('Session started', { sessionId: session.id, flowSlug, flowId: flow.id, preview: !!preview, source: effectiveSource })

    return NextResponse.json({
      id: session.id,
      startStepId,
    })
  } catch (error: any) {
    logger.error('Create session failed', { error: error.message })
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 })
  }
}
