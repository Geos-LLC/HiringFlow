/**
 * POST /api/candidates/[id]/mc-simulations/import
 *
 * Attach an EXISTING MockCustomer call to a HireFunnel candidate — for
 * recruiters who ran calls in MC before connecting HF and want the
 * results + recordings to appear on the candidate page.
 *
 * Body: { mcCallId: string }
 *
 * Flow:
 *   1. Auth as workspace; verify candidate belongs to workspace.
 *   2. Load McWorkspaceMapping; decrypt api key.
 *   3. Fetch the call from MC via mcGetCallStatus(cfg, mcCallId). This
 *      both validates ownership (MC returns 404 if the call isn't in
 *      the caller's org) AND gives us the current status + timestamps
 *      + recordingUrl to populate the McSimulation row.
 *   4. Insert McSimulation with the fetched data. The @@unique on
 *      mcCallId prevents duplicate imports (same call twice) — returns
 *      409 with the existing row's id so the client can navigate to it.
 *
 * Uses launchRequestId=null (this isn't a launch, it's an import).
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

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  // Candidate must belong to this workspace.
  const candidate = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!candidate) {
    return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })
  }

  let body: { mcCallId?: unknown }
  try {
    body = (await request.json()) as { mcCallId?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const mcCallId = typeof body.mcCallId === 'string' ? body.mcCallId.trim() : ''
  if (!UUID_RE.test(mcCallId)) {
    return NextResponse.json(
      { error: 'mcCallId must be a UUID', reason: 'invalid_mc_call_id' },
      { status: 400 },
    )
  }

  const mapping = await prisma.mcWorkspaceMapping.findUnique({
    where: { workspaceId: ws.workspaceId },
    select: {
      mcOrganizationId: true,
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

  // Fast-path: does this call already have a McSimulation row for this
  // workspace? (Either launched originally from HF, or previously
  // imported.) Return 409 with the existing id so the client can jump
  // to the existing row rather than surface a raw unique-violation.
  const existing = await prisma.mcSimulation.findUnique({
    where: { mcCallId },
    select: { id: true, workspaceId: true, candidateId: true },
  })
  if (existing) {
    return NextResponse.json(
      {
        error: 'This call is already attached to a candidate in this workspace.',
        reason: 'already_imported',
        simulationId: existing.id,
        candidateId: existing.candidateId,
        isSameCandidate: existing.candidateId === candidate.id,
      },
      { status: 409 },
    )
  }

  // Verify ownership + fetch current state from MC using the workspace's
  // api key. A key for the wrong org would 404 — which we surface as
  // "call not found in your MC org".
  let cfg
  try {
    cfg = buildMcClientConfig({
      apiKey: decryptMcSecret(mapping.mcApiKeyEncrypted),
    })
  } catch (err) {
    console.error('[import] decrypt failed', err)
    return NextResponse.json(
      { error: 'Could not decrypt MockCustomer credentials.', reason: 'decrypt_failed' },
      { status: 500 },
    )
  }

  let mcCall
  try {
    mcCall = await mcGetCallStatus(cfg, mcCallId)
  } catch (err) {
    if (err instanceof McApiError) {
      if (err.status === 404) {
        return NextResponse.json(
          {
            error: 'MockCustomer call not found in your organization. Double-check the ID.',
            reason: 'mc_call_not_found',
          },
          { status: 404 },
        )
      }
      return NextResponse.json(
        {
          error: `MockCustomer returned ${err.status}`,
          reason: 'mc_error',
          detail: err.message,
        },
        { status: 502 },
      )
    }
    console.error('[import] mcGetCallStatus failed', err)
    return NextResponse.json(
      { error: 'Could not reach MockCustomer', reason: 'mc_unreachable' },
      { status: 502 },
    )
  }

  // Normalize wire status to our local ladder representation. If MC
  // reports an unknown status (future MC lifecycle expansion) we
  // fall back to 'completed' — the call is fetchable so it must have
  // reached some state MC considers final for lookup purposes.
  const normalizedStatus = normalizeWireStatus(mcCall.status) ?? 'completed'

  try {
    const inserted = await prisma.mcSimulation.create({
      data: {
        workspaceId: ws.workspaceId,
        candidateId: candidate.id,
        launchedByUserId: ws.userId,
        mcOrganizationId: mapping.mcOrganizationId,
        mcCallId: mcCall.callId,
        status: normalizedStatus,
        queuedAt: mcCall.queuedAt ? new Date(mcCall.queuedAt) : new Date(),
        ringingAt: mcCall.ringingAt ? new Date(mcCall.ringingAt) : null,
        answeredAt: mcCall.answeredAt ? new Date(mcCall.answeredAt) : null,
        completedAt: mcCall.completedAt ? new Date(mcCall.completedAt) : null,
        failedAt: mcCall.failedAt ? new Date(mcCall.failedAt) : null,
        failureReason: mcCall.failureReason ?? null,
        // Even if MC has no full resultProjection yet, seeding the
        // summary field alone is useful for the panel display.
        resultProjection: mcCall.summary
          ? {
              overallScore: null,
              passed: null,
              summary: mcCall.summary,
              sessionId: null,
              deepLinkUrl: `https://mockcustomer.vercel.app/dashboard/results/${mcCall.callId}`,
            }
          : Prisma.JsonNull,
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
    // Race: another concurrent import created the row between our
    // fast-path check and the insert. Re-query and return 409.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const race = await prisma.mcSimulation.findUnique({
        where: { mcCallId },
        select: { id: true, candidateId: true },
      })
      if (race) {
        return NextResponse.json(
          {
            error: 'This call is already attached.',
            reason: 'already_imported',
            simulationId: race.id,
            candidateId: race.candidateId,
            isSameCandidate: race.candidateId === candidate.id,
          },
          { status: 409 },
        )
      }
    }
    console.error('[import] insert failed', err)
    return NextResponse.json({ error: 'Import failed', reason: 'internal' }, { status: 500 })
  }
}
