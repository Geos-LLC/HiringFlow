/**
 * POST /api/webhooks/mockcustomer
 *
 * Inbound MC webhook receiver. Every advance in an MC ExternalCall's
 * lifecycle POSTs one signed event here (see the mockcustomer repo's
 * webhook-delivery.worker for the retry semantics — we may see the
 * same event id multiple times across MC's retry queue, and events
 * for the same call may arrive out of order).
 *
 * Auth: HMAC over `t.rawBody` with the per-workspace whsec. Signature
 * timestamp is checked against `MC_MAX_SKEW_SEC` before signature
 * verification runs.
 *
 * Correlation: primarily `data.clientReferenceId` = `McSimulation.id`.
 * `data.callId` is secondary metadata — the first event of a run
 * (`.queued`) may race the dial's HTTP response, so we cannot require
 * `mcCallId` to be populated on the row yet.
 *
 * Exactly-once processing: `McWebhookEvent.mcEventId` is `@unique`.
 * Insert-then-apply in the same transaction; a unique-conflict on
 * insert means the event was already processed and we 200-no-op.
 *
 * Zero candidate side effects: this route touches ONLY McSimulation
 * and McWebhookEvent. No Session, no Interview, no AICallCandidate,
 * no pipeline-stage move.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  MC_SIGNATURE_HEADER,
  verifyMcSignature,
} from '@/lib/mockcustomer/signature'
import { parseMcWebhookEvent } from '@/lib/mockcustomer/webhook-types'
import { normalizeWireStatus } from '@/lib/mockcustomer/status-ladder'
import { applyMcSimulationState } from '@/lib/mockcustomer/apply-simulation-state'
import { decryptMcSecret } from '@/lib/mockcustomer/encryption'
import { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  // Raw body — required for HMAC. Do NOT use request.json() first; that
  // path reserializes and the signature check will spuriously fail.
  const rawBody = await request.text()
  const sigHeader = request.headers.get(MC_SIGNATURE_HEADER)

  // Parse the event body first so we can locate the McSimulation and
  // load the per-workspace webhook secret. We CANNOT verify the
  // signature without knowing which workspace the event is for.
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const event = parseMcWebhookEvent(parsed)
  if (!event) {
    return NextResponse.json({ error: 'malformed_event' }, { status: 400 })
  }

  const clientRef = event.data.clientReferenceId
  if (!clientRef) {
    // MC always echoes clientReferenceId when partners set it — HF sets
    // it on every launch. An event missing it is either from another
    // partner tenant sharing our callback (misconfiguration) or a
    // corrupted payload. Reject before touching the DB.
    return NextResponse.json({ error: 'missing_client_reference_id' }, { status: 400 })
  }

  const sim = await prisma.mcSimulation.findUnique({
    where: { id: clientRef },
    select: { id: true, workspaceId: true },
  })
  if (!sim) {
    // Unknown McSimulation. Either an event for a row that never
    // existed (unlikely — dial always creates the row first) or an
    // event for a row from a different HF environment sharing this
    // callback. Log and return 404 so MC's retry policy treats it as
    // permanent (after its 404 bootstrapping window).
    console.warn('[mc-webhook] no McSimulation for clientReferenceId', {
      clientReferenceId: clientRef,
      eventId: event.eventId,
      type: event.type,
    })
    return NextResponse.json({ error: 'unknown_simulation' }, { status: 404 })
  }

  const mapping = await prisma.mcWorkspaceMapping.findUnique({
    where: { workspaceId: sim.workspaceId },
    select: { mcWebhookSecretEncrypted: true },
  })
  if (!mapping) {
    console.error('[mc-webhook] no mapping for workspace of McSimulation', {
      workspaceId: sim.workspaceId,
      simulationId: sim.id,
    })
    return NextResponse.json({ error: 'no_mapping' }, { status: 500 })
  }
  let secret: string
  try {
    secret = decryptMcSecret(mapping.mcWebhookSecretEncrypted)
  } catch (err) {
    console.error('[mc-webhook] failed to decrypt webhook secret', {
      workspaceId: sim.workspaceId,
      err: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'decrypt_failed' }, { status: 500 })
  }

  const verify = verifyMcSignature(rawBody, sigHeader, secret)
  if (!verify.valid) {
    const status =
      verify.reason === 'missing_header' || verify.reason === 'malformed_header'
        ? 400
        : verify.reason === 'timestamp_skew'
          ? 400
          : 401
    return NextResponse.json({ error: 'signature_invalid', reason: verify.reason }, { status })
  }

  // Normalize wire status → local ladder representation.
  const toStatus = normalizeWireStatus(event.data.status)
  if (!toStatus) {
    return NextResponse.json({ error: 'unknown_status', status: event.data.status }, { status: 400 })
  }

  // Insert-then-apply in a single transaction. Unique conflict on
  // mcEventId ⇒ duplicate delivery ⇒ 200 no-op. Otherwise apply the
  // forward transition (idempotent — a regressive/no-change event is
  // absorbed by the ladder inside applyMcSimulationState).
  try {
    await prisma.$transaction(async (tx) => {
      await tx.mcWebhookEvent.create({
        data: {
          mcEventId: event.eventId,
          mcSimulationId: sim.id,
          mcCallId: event.data.callId ?? null,
          eventType: event.type,
          payload: parsed as Prisma.InputJsonValue,
        },
      })
      await applyMcSimulationState(tx, {
        simulationId: sim.id,
        toStatus,
        mcCallId: event.data.callId ?? null,
        ringingAt: event.data.ringingAt ? new Date(event.data.ringingAt) : undefined,
        answeredAt: event.data.answeredAt ? new Date(event.data.answeredAt) : undefined,
        completedAt: event.data.completedAt ? new Date(event.data.completedAt) : undefined,
        failedAt: event.data.failedAt ? new Date(event.data.failedAt) : undefined,
        failureReason: event.data.failureReason ?? undefined,
        result: event.data.result,
      })
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    // Prisma unique-constraint error on mcEventId → duplicate delivery.
    // Treat as 200 no-op so MC's retry queue stops on it.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      Array.isArray(err.meta?.target) &&
      (err.meta.target as string[]).includes('mcEventId')
    ) {
      return NextResponse.json({ ok: true, duplicate: true })
    }
    // Even generic P2002 without meta.target — assume mcEventId conflict.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json({ ok: true, duplicate: true })
    }
    console.error('[mc-webhook] apply failed', {
      simulationId: sim.id,
      eventId: event.eventId,
      err: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'apply_failed' }, { status: 500 })
  }
}
