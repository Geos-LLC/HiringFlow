import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { validateEmail, validatePhone } from '@/lib/contact-validation'
import { findActiveProcessForFlow } from '@/lib/hiring-processes'

// Public endpoint invoked from arbitrary external sites (careers pages,
// landing forms, etc.). The flowSlug acts as the routing key, so wildcard
// origin is intentional — the endpoint has no per-caller secret to protect.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
}

function jsonWithCors(data: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(data, init)
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v)
  return res
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

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
    const { flowSlug, candidateName, candidateEmail, candidatePhone, preview, adId, source, campaign, formData, completed } = body

    if (!flowSlug) {
      return jsonWithCors({ error: 'Flow slug is required' }, { status: 400 })
    }

    // Sanitize free-form form fields from external sites. The Form Data card
    // on the candidate profile renders each key/value verbatim, so we cap
    // shape + size to keep hostile callers from stuffing 5MB of HTML into a
    // row that then blows up the profile page. Non-string values are coerced
    // to string; reserved keys already covered by first-class columns
    // (name/email/phone) are dropped so the card doesn't render duplicates.
    let sanitizedFormData: Record<string, string> | null = null
    if (formData && typeof formData === 'object' && !Array.isArray(formData)) {
      const reserved = new Set(['name', 'email', 'phone'])
      const entries = Object.entries(formData as Record<string, unknown>)
        .filter(([k]) => typeof k === 'string' && k.length > 0 && k.length <= 80 && !reserved.has(k.toLowerCase()))
        .slice(0, 30)
        .map(([k, v]) => [k, String(v ?? '').slice(0, 500)] as const)
      if (entries.length > 0) sanitizedFormData = Object.fromEntries(entries)
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
      if (!r.ok) return jsonWithCors({ error: r.error }, { status: 400 })
      normalizedEmail = r.value
    }
    if (typeof candidatePhone === 'string' && candidatePhone.trim()) {
      const r = validatePhone(candidatePhone)
      if (!r.ok) return jsonWithCors({ error: r.error }, { status: 400 })
      normalizedPhone = r.value
    }

    let flow

    if (preview) {
      // Preview mode: allow unpublished flows for workspace members
      const ws = await getWorkspaceSession()
      if (!ws) {
        return jsonWithCors({ error: 'Unauthorized' }, { status: 401 })
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
      return jsonWithCors({ error: 'Flow not found' }, { status: 404 })
    }

    // Enforce start-screen required fields server-side. The client-side
    // Start button gate is trivially bypassable (autofill, DevTools, direct
    // POST), and without server enforcement we accumulate ghost sessions
    // with no contact info that can never be reached by automation.
    const startCfg = ((flow.branding as { startScreenConfig?: { nameRequired?: boolean; emailRequired?: boolean; showNameField?: boolean; showEmailField?: boolean } } | null)?.startScreenConfig) ?? {}
    const showName = startCfg.showNameField ?? true
    const showEmail = startCfg.showEmailField ?? false
    if (showName && startCfg.nameRequired && !(typeof candidateName === 'string' && candidateName.trim())) {
      return jsonWithCors({ error: 'Name is required' }, { status: 400 })
    }
    if (showEmail && startCfg.emailRequired && !normalizedEmail) {
      return jsonWithCors({ error: 'Email is required' }, { status: 400 })
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

    // HiringProcess attach. If this flow is the entry point of exactly one
    // active HiringProcess in the workspace, stamp it on the new Session so
    // the candidate's journey is tied to that process for analytics + UI.
    //
    // Ambiguous case (multiple active processes on the same flow) returns
    // null — the API layer rejects this configuration at create/activate,
    // but the candidate path is defensive so a race or hand-written DB
    // change can't silently misattribute. We log a warning so it's visible.
    let processId: string | null = null
    const active = await findActiveProcessForFlow(prisma, {
      workspaceId: flow.workspaceId,
      flowId: flow.id,
    })
    if (active) {
      processId = active.id
    } else {
      // Distinguish "no process" (the common case) from "ambiguous" (a real
      // configuration error). The lib returns null for both, so we do a
      // count here only when we want to log the warning, not on every call.
      const activeCount = await prisma.hiringProcess.count({
        where: { workspaceId: flow.workspaceId, flowId: flow.id, status: 'active' },
      })
      if (activeCount > 1) {
        logger.warn('Multiple active HiringProcesses on flow — leaving processId null', {
          flowId: flow.id,
          workspaceId: flow.workspaceId,
          activeCount,
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
        formData: sanitizedFormData ?? undefined,
        // Source attribution (from Ad link)
        adId: adId || null,
        source: effectiveSource,
        campaign: campaign || null,
        processId,
      },
    })

    // External-site submissions arrive complete — the full form has already
    // been filled out on the caller's careers page. Mirror the finish state
    // in a second write (matching /api/public/sessions/[id]/submit) so the
    // Prisma lifecycle middleware fires `flow_completed` and any wired
    // stage-advance / automation rules run. Skipping this leaves the
    // Application stage stuck as "in progress" forever on the kanban.
    if (completed === true) {
      const now = new Date()
      await prisma.session.update({
        where: { id: session.id },
        data: {
          finishedAt: now,
          outcome: 'completed',
          lastActivityAt: now,
          lastProgressAt: now,
        },
      })
    }

    // Close out older sessions of the same candidate so the kanban only
    // ever shows the latest attempt. Without this, the May session sits
    // forever in "Interview scheduled" while the June session lives
    // in Rejected — recruiters end up seeing the same person in two
    // contradictory stages across status tabs (the Katezack pattern).
    //
    // We mark old active/waiting/stalled sessions as `lost` with
    // dispositionReason='reapplied' so the candidate-status engine
    // treats them as a recognized terminal state. Don't touch
    // already-terminal sessions (lost/hired) so we don't rewrite
    // history. We also skip test sessions for the same reason — the
    // user's own self-tests shouldn't auto-close each other.
    if (normalizedEmail && effectiveSource !== 'test') {
      try {
        const updated = await prisma.session.updateMany({
          where: {
            workspaceId: flow.workspaceId,
            candidateEmail: { equals: normalizedEmail, mode: 'insensitive' },
            id: { not: session.id },
            status: { in: ['active', 'waiting', 'stalled', 'nurture'] },
          },
          data: {
            status: 'lost',
            dispositionReason: 'reapplied',
            lostAt: new Date(),
          },
        })
        if (updated.count > 0) {
          logger.info('Superseded older sessions on re-apply', {
            email: normalizedEmail,
            count: updated.count,
            newSessionId: session.id,
          })
        }
      } catch (err) {
        // Don't block the new session on cleanup failure.
        logger.warn('Failed to supersede older sessions', { email: normalizedEmail, err: err instanceof Error ? err.message : err })
      }
    }

    logger.info('Session started', { sessionId: session.id, flowSlug, flowId: flow.id, preview: !!preview, source: effectiveSource, processId })

    return jsonWithCors({
      id: session.id,
      startStepId,
    })
  } catch (error: any) {
    logger.error('Create session failed', { error: error.message })
    return jsonWithCors({ error: 'Failed to create session' }, { status: 500 })
  }
}
