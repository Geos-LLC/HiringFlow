/**
 * POST /api/candidates/[id]/mc-simulations/import
 *
 * Attach an EXISTING MockCustomer artifact to a HireFunnel candidate.
 * Two artifact types:
 *
 *   'call'    — MC ExternalCall (outbound Twilio dial with a recording).
 *               Body: { resourceType: 'call', mcCallId: string }
 *               HF verifies + fetches state via mcGetCallStatus.
 *
 *   'session' — MC SimulationSession (browser-widget INVITE run with an
 *               ElevenLabs audio recording). Body: { resourceType:
 *               'session', mcSessionId: string }. HF verifies ownership
 *               by scanning the org's /sessions list for this id (no
 *               single-item GET yet on MC). Once found, we store the
 *               session's metadata + elevenLabsConversationId in the
 *               McSimulation row so the audio player can construct the
 *               MC voice-public audio URL.
 *
 * Legacy body { mcCallId: string } without resourceType is accepted as
 * resourceType='call' for backwards-compat.
 */

import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { decryptMcSecret } from '@/lib/mockcustomer/encryption'
import {
  buildMcClientConfig,
  mcGetCallStatus,
  McApiError,
} from '@/lib/mockcustomer/client'
import { normalizeWireStatus } from '@/lib/mockcustomer/status-ladder'
import { listMcSessions, McPartnerApiError, type McSessionRow } from '@/lib/mockcustomer/partner-ai-customers'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const candidate = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!candidate) {
    return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })
  }

  let body: {
    resourceType?: unknown
    mcCallId?: unknown
    mcSessionId?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const resourceType =
    typeof body.resourceType === 'string' && body.resourceType.trim() === 'session'
      ? 'session'
      : 'call'
  const resourceId =
    resourceType === 'session'
      ? typeof body.mcSessionId === 'string'
        ? body.mcSessionId.trim()
        : ''
      : typeof body.mcCallId === 'string'
        ? body.mcCallId.trim()
        : ''

  if (!UUID_RE.test(resourceId)) {
    return NextResponse.json(
      {
        error: `${resourceType === 'session' ? 'mcSessionId' : 'mcCallId'} must be a UUID`,
        reason: 'invalid_resource_id',
      },
      { status: 400 },
    )
  }

  const mapping = await prisma.mcWorkspaceMapping.findUnique({
    where: { workspaceId: ws.workspaceId },
    select: {
      mcOrganizationId: true,
      mcOrganizationSlug: true,
      mcApiKeyEncrypted: true,
      canaryEnabled: true,
    },
  })
  if (!mapping || !mapping.canaryEnabled) {
    return NextResponse.json(
      { error: 'MockCustomer not connected', reason: 'not_connected' },
      { status: 409 },
    )
  }

  // Fast-path: was this id already imported? The McSimulation.mcCallId
  // column is @unique — we store the id there regardless of resource type
  // (both are UUIDs, no collision risk).
  const existing = await prisma.mcSimulation.findUnique({
    where: { mcCallId: resourceId },
    select: { id: true, candidateId: true },
  })
  if (existing) {
    return NextResponse.json(
      {
        error: 'This recording is already attached to a candidate in this workspace.',
        reason: 'already_imported',
        simulationId: existing.id,
        candidateId: existing.candidateId,
        isSameCandidate: existing.candidateId === candidate.id,
      },
      { status: 409 },
    )
  }

  if (resourceType === 'call') {
    return await importCall({
      ws,
      candidateId: candidate.id,
      mcCallId: resourceId,
      mapping,
    })
  }
  return await importSession({
    ws,
    candidateId: candidate.id,
    mcSessionId: resourceId,
    mapping,
  })
}

async function importCall(input: {
  ws: { userId: string; workspaceId: string }
  candidateId: string
  mcCallId: string
  mapping: {
    mcOrganizationId: string
    mcApiKeyEncrypted: string
  }
}): Promise<NextResponse> {
  let cfg
  try {
    cfg = buildMcClientConfig({ apiKey: decryptMcSecret(input.mapping.mcApiKeyEncrypted) })
  } catch (err) {
    console.error('[import call] decrypt failed', err)
    return NextResponse.json(
      { error: 'Could not decrypt MockCustomer credentials.', reason: 'decrypt_failed' },
      { status: 500 },
    )
  }

  let mcCall
  try {
    mcCall = await mcGetCallStatus(cfg, input.mcCallId)
  } catch (err) {
    if (err instanceof McApiError) {
      if (err.status === 404) {
        return NextResponse.json(
          {
            error: 'MockCustomer call not found in your organization.',
            reason: 'mc_call_not_found',
          },
          { status: 404 },
        )
      }
      return NextResponse.json(
        { error: `MockCustomer returned ${err.status}`, reason: 'mc_error', detail: err.message },
        { status: 502 },
      )
    }
    console.error('[import call] mcGetCallStatus failed', err)
    return NextResponse.json(
      { error: 'Could not reach MockCustomer', reason: 'mc_unreachable' },
      { status: 502 },
    )
  }

  const normalizedStatus = normalizeWireStatus(mcCall.status) ?? 'completed'

  try {
    const inserted = await prisma.mcSimulation.create({
      data: {
        workspaceId: input.ws.workspaceId,
        candidateId: input.candidateId,
        launchedByUserId: input.ws.userId,
        mcOrganizationId: input.mapping.mcOrganizationId,
        mcCallId: mcCall.callId,
        status: normalizedStatus,
        queuedAt: mcCall.queuedAt ? new Date(mcCall.queuedAt) : new Date(),
        ringingAt: mcCall.ringingAt ? new Date(mcCall.ringingAt) : null,
        answeredAt: mcCall.answeredAt ? new Date(mcCall.answeredAt) : null,
        completedAt: mcCall.completedAt ? new Date(mcCall.completedAt) : null,
        failedAt: mcCall.failedAt ? new Date(mcCall.failedAt) : null,
        failureReason: mcCall.failureReason ?? null,
        resultProjection: {
          resourceType: 'call',
          overallScore: null,
          passed: null,
          summary: mcCall.summary ?? null,
          sessionId: null,
          deepLinkUrl: `https://mockcustomer.vercel.app/dashboard/results/${mcCall.callId}`,
        },
        launchRequestId: null,
      },
      select: { id: true, mcCallId: true, status: true },
    })
    return NextResponse.json({
      simulationId: inserted.id,
      mcCallId: inserted.mcCallId,
      status: inserted.status,
      imported: true,
    })
  } catch (err) {
    return handleInsertRace(err, input.mcCallId, input.candidateId)
  }
}

async function importSession(input: {
  ws: { userId: string; workspaceId: string }
  candidateId: string
  mcSessionId: string
  mapping: {
    mcOrganizationId: string
    mcOrganizationSlug: string
  }
}): Promise<NextResponse> {
  // Verify ownership by scanning MC's sessions list for this id. MC has
  // no single-item GET on partner-scoped sessions today; the list is
  // paginated (25/page). We scan up to 8 pages (200 sessions) which
  // covers any realistic partner-linked org today. If not found, either
  // the id is foreign OR the session is very old and paginated past;
  // both surface as "not found" to the caller.
  let match: McSessionRow | null = null
  let cursor: string | null | undefined = undefined
  const MAX_PAGES = 8
  const PAGE_LIMIT = 25
  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await listMcSessions(input.mapping.mcOrganizationSlug, {
        cursor,
        limit: PAGE_LIMIT,
      })
      const hit = page.sessions.find((s) => s.id === input.mcSessionId)
      if (hit) {
        match = hit
        break
      }
      if (!page.pagination.hasMore) break
      cursor = page.pagination.nextCursor
    }
  } catch (err) {
    if (err instanceof McPartnerApiError) {
      return NextResponse.json(
        {
          error: 'Could not verify MockCustomer session',
          reason: `mc_${err.reason}`,
          detail: err.message,
        },
        { status: 502 },
      )
    }
    console.error('[import session] verify failed', err)
    return NextResponse.json(
      { error: 'Could not reach MockCustomer', reason: 'mc_unreachable' },
      { status: 502 },
    )
  }

  if (!match) {
    return NextResponse.json(
      {
        error:
          'MockCustomer session not found in your organization (or too old to appear in the recent list).',
        reason: 'mc_session_not_found',
      },
      { status: 404 },
    )
  }

  // Session status is uppercase (COMPLETED, RUNNING, etc.) — normalize to
  // HF's lowercase status ladder. INVITE sessions land as 'completed' when
  // the participant finishes; anything else stays 'in_progress' or 'failed'.
  const statusLower = match.status.toLowerCase()
  const normalized =
    statusLower === 'completed'
      ? 'completed'
      : statusLower === 'failed' || statusLower === 'errored'
        ? 'failed'
        : statusLower === 'cancelled' || statusLower === 'canceled'
          ? 'cancelled'
          : 'in_progress'

  try {
    const inserted = await prisma.mcSimulation.create({
      data: {
        workspaceId: input.ws.workspaceId,
        candidateId: input.candidateId,
        launchedByUserId: input.ws.userId,
        mcOrganizationId: input.mapping.mcOrganizationId,
        mcCallId: match.id, // reusing the unique field to store the session id
        status: normalized,
        queuedAt: new Date(match.createdAt),
        answeredAt: match.startedAt ? new Date(match.startedAt) : null,
        completedAt: match.finishedAt ? new Date(match.finishedAt) : null,
        failedAt: match.status.toLowerCase() === 'failed' && match.finishedAt ? new Date(match.finishedAt) : null,
        failureReason: match.errorReason ?? null,
        resultProjection: {
          // Discriminator so the audio player picks the right MC URL.
          resourceType: 'session',
          // ElevenLabs conversation id used to construct the audio URL:
          //   ${MC_URL}/voice/public/sessions/${mcCallId}/audio?id=${elevenLabsConversationId}
          elevenLabsConversationId: match.elevenLabsConversationId,
          mode: match.mode,
          participantName: match.participantName,
          overallScore: null,
          passed: null,
          summary: null,
          sessionId: match.id,
          deepLinkUrl: `https://mockcustomer.vercel.app/dashboard/results/${match.id}`,
        },
        launchRequestId: null,
      },
      select: { id: true, mcCallId: true, status: true },
    })
    return NextResponse.json({
      simulationId: inserted.id,
      mcSessionId: inserted.mcCallId,
      status: inserted.status,
      imported: true,
    })
  } catch (err) {
    return handleInsertRace(err, input.mcSessionId, input.candidateId)
  }
}

function handleInsertRace(err: unknown, resourceId: string, candidateId: string): NextResponse {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    // Fire a follow-up query to surface the winning row without awaiting
    // (fire-and-forget wouldn't be safe here) — actually just re-check
    // synchronously since it's fast.
    return NextResponse.json(
      {
        error: 'This recording is already attached.',
        reason: 'already_imported',
        // Client can hit GET /api/candidates/[id]/mc-simulations to see the
        // full state — we don't need to look up the specific id inline.
        candidateHint: candidateId,
      },
      { status: 409 },
    )
  }
  console.error('[import] insert failed', err, 'resourceId=', resourceId)
  return NextResponse.json({ error: 'Import failed', reason: 'internal' }, { status: 500 })
}
