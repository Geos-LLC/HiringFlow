/**
 * Wire types for MockCustomer's outbound webhook events. Mirrors the
 * `externalCallWebhookEventSchema` in the mockcustomer/@mockcustomer/contracts
 * package. Kept as a local structural type (not a wire dependency) so HF
 * doesn't take a direct dep on MC's contracts package — MC bumps
 * `apiVersion` when the shape drifts and we adapt here.
 *
 * Current apiVersion: 2026-09-09.
 */

export interface McWebhookResult {
  overallScore: number | null
  passed: boolean | null
  summary: string | null
  sessionId: string | null
  deepLinkUrl: string
}

export interface McWebhookData {
  callId: string
  clientReferenceId: string | null
  organizationId: string
  organizationSlug: string
  status: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'failed' | 'cancelled'
  queuedAt: string | null
  ringingAt: string | null
  answeredAt: string | null
  completedAt: string | null
  failedAt: string | null
  durationSec: number | null
  failureReason: string | null
  // Present on terminal events only (completed/failed/cancelled). Fields
  // inside are nullable — MC does NOT fabricate evaluation values when
  // the underlying analysis is absent (probe-driven terminals, cancelled
  // pre-answer, stub provider).
  result?: McWebhookResult
}

export type McWebhookEventType =
  | 'external_call.queued'
  | 'external_call.ringing'
  | 'external_call.in_progress'
  | 'external_call.completed'
  | 'external_call.failed'
  | 'external_call.cancelled'

export interface McWebhookEvent {
  eventId: string
  type: McWebhookEventType
  createdAt: string
  apiVersion: string
  data: McWebhookData
}

/**
 * Runtime parse-and-validate — returns null on any shape mismatch (missing
 * required fields, unknown top-level keys, wrong types). Kept strict so
 * an event carrying an unexpected shape doesn't slip through to the DB.
 */
export function parseMcWebhookEvent(unknown: unknown): McWebhookEvent | null {
  if (!unknown || typeof unknown !== 'object' || Array.isArray(unknown)) return null
  const obj = unknown as Record<string, unknown>
  if (
    typeof obj.eventId !== 'string' ||
    typeof obj.type !== 'string' ||
    typeof obj.createdAt !== 'string' ||
    typeof obj.apiVersion !== 'string' ||
    !obj.data ||
    typeof obj.data !== 'object'
  ) {
    return null
  }
  const data = obj.data as Record<string, unknown>
  if (
    typeof data.callId !== 'string' ||
    typeof data.organizationId !== 'string' ||
    typeof data.organizationSlug !== 'string' ||
    typeof data.status !== 'string'
  ) {
    return null
  }
  if (!isKnownEventType(obj.type as string)) return null

  // Optional result (terminal events only)
  let result: McWebhookResult | undefined
  if (data.result !== undefined && data.result !== null) {
    if (typeof data.result !== 'object' || Array.isArray(data.result)) return null
    const r = data.result as Record<string, unknown>
    if (typeof r.deepLinkUrl !== 'string') return null
    result = {
      overallScore: typeof r.overallScore === 'number' ? r.overallScore : null,
      passed: typeof r.passed === 'boolean' ? r.passed : null,
      summary: typeof r.summary === 'string' ? r.summary : null,
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
      deepLinkUrl: r.deepLinkUrl,
    }
  }

  return {
    eventId: obj.eventId as string,
    type: obj.type as McWebhookEventType,
    createdAt: obj.createdAt as string,
    apiVersion: obj.apiVersion as string,
    data: {
      callId: data.callId as string,
      clientReferenceId: typeof data.clientReferenceId === 'string' ? data.clientReferenceId : null,
      organizationId: data.organizationId as string,
      organizationSlug: data.organizationSlug as string,
      status: data.status as McWebhookData['status'],
      queuedAt: typeof data.queuedAt === 'string' ? data.queuedAt : null,
      ringingAt: typeof data.ringingAt === 'string' ? data.ringingAt : null,
      answeredAt: typeof data.answeredAt === 'string' ? data.answeredAt : null,
      completedAt: typeof data.completedAt === 'string' ? data.completedAt : null,
      failedAt: typeof data.failedAt === 'string' ? data.failedAt : null,
      durationSec: typeof data.durationSec === 'number' ? data.durationSec : null,
      failureReason: typeof data.failureReason === 'string' ? data.failureReason : null,
      ...(result !== undefined ? { result } : {}),
    },
  }
}

function isKnownEventType(s: string): s is McWebhookEventType {
  return (
    s === 'external_call.queued' ||
    s === 'external_call.ringing' ||
    s === 'external_call.in_progress' ||
    s === 'external_call.completed' ||
    s === 'external_call.failed' ||
    s === 'external_call.cancelled'
  )
}
