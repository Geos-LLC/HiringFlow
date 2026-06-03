import { NextRequest, NextResponse } from 'next/server'
import {
  CaptureError,
  failCapture,
  finalizeCaptureUpload,
} from '@/lib/capture/capture-response.service'
import {
  inspectUploadedObject,
  validateUploadSizeForMode,
} from '@/lib/capture/capture-storage.service'
import { prisma } from '@/lib/prisma'
import { isMimeAllowed, type CaptureMode } from '@/lib/capture/capture-config'
import { captureLog } from '@/lib/capture/capture-log'
import { checkCaptureRateLimit, extractIp } from '@/lib/capture/capture-rate-limit'
// Public candidate-facing route. Confirms the presigned PUT actually landed
// in S3, then transitions the CaptureResponse forward.
//
// Body: { captureId, durationSec? }
// Returns: { capture: { id, status, fileSizeBytes, durationSec } }
export async function POST(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  // Per-IP + per-session rate limit. Finalize is called once per take in the
  // happy path; aggressive retries from a buggy client should be throttled.
  const ip = extractIp(request)
  const rl = checkCaptureRateLimit({ route: 'finalize', ip, sessionId: params.sessionId })
  if (!rl.ok) {
    captureLog('capture_finalize_failed', {
      sessionId: params.sessionId,
      reason: 'rate_limited',
      scope: rl.scope,
    })
    return NextResponse.json(
      { error: 'Too many requests. Please wait a moment and try again.', code: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    )
  }

  // Hoisted so the catch handler can include it in capture_finalize_failed
  // logs even when the failure happens after parse but before normal return.
  let captureId: string | undefined
  try {
    const body = await request.json().catch(() => null) as
      | { captureId?: string; durationSec?: number }
      | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { captureId: bodyCaptureId, durationSec } = body
    captureId = bodyCaptureId
    if (!captureId || typeof captureId !== 'string') {
      return NextResponse.json({ error: 'captureId is required' }, { status: 400 })
    }
    if (durationSec != null && (typeof durationSec !== 'number' || durationSec < 0)) {
      return NextResponse.json({ error: 'durationSec must be a non-negative number' }, { status: 400 })
    }

    // Pre-load the row so we know the storageKey and can scope ownership
    // before doing any S3 I/O. loadCaptureContext in the service is keyed by
    // (session, step) — for finalize we already have the captureId and only
    // need to check it belongs to the requested session.
    const capture = await prisma.captureResponse.findUnique({ where: { id: captureId } })
    if (!capture) {
      return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
    }
    if (capture.sessionId !== params.sessionId) {
      // 404 instead of 403 here so an attacker probing IDs can't distinguish
      // existence-but-wrong-session from non-existence.
      return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
    }

    // Idempotency: a candidate's flaky network may retry the finalize POST
    // after the first response was lost. The first call moved the row to
    // 'processed'; the retry sees a 200 with the existing row instead of a
    // 409 / 5xx. This is what makes the API safe to retry from the client.
    if (capture.status === 'processed') {
      captureLog('capture_finalize_completed', {
        sessionId: params.sessionId,
        captureId: capture.id,
        workspaceId: capture.workspaceId,
        mode: capture.mode,
        idempotent: true,
      })
      return NextResponse.json({
        capture: {
          id: capture.id,
          status: capture.status,
          fileSizeBytes: capture.fileSizeBytes,
          durationSec: capture.durationSec,
        },
      })
    }

    if (!capture.storageKey) {
      return NextResponse.json({ error: 'Capture has no storageKey (was not presigned)' }, { status: 409 })
    }

    const head = await inspectUploadedObject(capture.storageKey)
    if (!head) {
      // The PUT never landed (or S3 GC'd it). Don't fail the row yet — the
      // candidate may retry the upload using the same captureId before the
      // presigned URL expires. Return 409 so the client knows to retry.
      return NextResponse.json(
        { error: 'Upload not yet visible in S3 — retry the PUT or call presign again', code: 'upload_not_visible' },
        { status: 409 }
      )
    }

    // Integrity: enforce non-empty + size cap + MIME-vs-mode match before
    // we transition the row to 'processed'. validateUploadSizeForMode already
    // covers size; the MIME check below catches a misuse where the client
    // requested an audio presign and then PUT a different content-type.
    const sizeCheck = validateUploadSizeForMode(head.contentLength, capture.mode as CaptureMode)
    if (!sizeCheck.ok) {
      await failCapture({ captureId, reason: sizeCheck.reason })
      captureLog('capture_finalize_failed', {
        sessionId: params.sessionId,
        captureId,
        reason: sizeCheck.reason,
        statusCode: 413,
      })
      return NextResponse.json({ error: sizeCheck.reason, code: 'size_invalid' }, { status: 413 })
    }
    const observedMime = head.contentType?.toLowerCase()
    if (observedMime) {
      // S3 sometimes appends codec params (e.g. `audio/mp4;codecs=opus`).
      // Strip params for the allowlist check; the allowlist holds bare types.
      const bare = observedMime.split(';')[0]?.trim() || observedMime
      if (!isMimeAllowed(capture.mode as CaptureMode, bare)) {
        const reason = `Uploaded content type '${bare}' is not allowed for mode '${capture.mode}'`
        await failCapture({ captureId, reason })
        captureLog('capture_finalize_failed', {
          sessionId: params.sessionId,
          captureId,
          reason,
          statusCode: 415,
        })
        return NextResponse.json({ error: reason, code: 'mime_invalid' }, { status: 415 })
      }
    }

    const updated = await finalizeCaptureUpload({
      captureId,
      sessionId: params.sessionId,
      observed: head,
      durationSec: durationSec ?? null,
    })

    captureLog('capture_finalize_completed', {
      sessionId: params.sessionId,
      captureId: updated.id,
      workspaceId: updated.workspaceId,
      mode: updated.mode,
      mimeType: updated.mimeType ?? undefined,
      sizeBytes: updated.fileSizeBytes ?? undefined,
      durationSec: updated.durationSec ?? undefined,
    })

    // Bump both heartbeats — recruiter dashboards use lastActivityAt for
    // "active right now" vs. "gone quiet", and the stale-detection cron uses
    // lastProgressAt as the inactivity clock. A capture upload is real forward
    // progress (candidate produced a recording / submission), so both columns
    // get bumped.
    await prisma.session.update({
      where: { id: params.sessionId },
      data: { lastActivityAt: new Date(), lastProgressAt: new Date() },
    }).catch(() => {})

    // `recording_ready` is now fired by the Prisma `$use` lifecycle middleware
    // when `finalizeCaptureUpload` flips CaptureResponse.status='processed'.
    // Calling fireFlowRecordingReadyAutomations explicitly here raced the
    // middleware path through executeStep — two near-simultaneous pending rows
    // both passed the guard's idempotency check and both sent. AutomationEvent
    // (src/lib/automation-emit.ts) is the DB-enforced dedup, but removing the
    // call here keeps the explicit/implicit responsibility split clean.

    return NextResponse.json({
      capture: {
        id: updated.id,
        status: updated.status,
        fileSizeBytes: updated.fileSizeBytes,
        durationSec: updated.durationSec,
      },
    })
  } catch (err) {
    if (err instanceof CaptureError) {
      captureLog('capture_finalize_failed', {
        sessionId: params.sessionId,
        captureId,
        reason: err.message,
        errorCode: err.code,
        statusCode: err.status,
      })
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    console.error('[captures/finalize] unexpected error', err)
    captureLog('capture_finalize_failed', {
      sessionId: params.sessionId,
      captureId,
      reason: (err as any)?.message || 'unknown',
    })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
