/**
 * Thin HTTP client for MC's `/v1/external-simulations/*` surface.
 * Server-side only. Does NOT retry — the caller is responsible for
 * transient-error semantics (idempotency-key protects re-dial).
 *
 * MC's contract: bearer auth via `Authorization: Bearer mc_(live|test)_*`.
 * 4xx bodies are surfaced verbatim so a partner-facing error can be
 * shown to the recruiter without silent transformation (matches MC's
 * "no silent gaps" posture).
 */

export const MC_BASE_URL_ENV = 'MOCKCUSTOMER_API_URL'
export const DEFAULT_MC_BASE_URL_PROD = 'https://mockcustomer-api-production-production.up.railway.app'
export const DEFAULT_MC_BASE_URL_STAGING = 'https://mockcustomer-api-staging-production.up.railway.app'

export interface DialInput {
  destinationPhone: string
  clientReferenceId: string
  idempotencyKey: string
  callbackUrl: string
  personaContext: {
    businessName: string
    businessIndustry: string
    businessSummary: string
    leadRequestDetails: string
    priorConversation: Array<{ role: 'customer' | 'pro'; content: string }>
  }
}

export interface DialResponse {
  callId: string
  status: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'failed' | 'cancelled'
  estimatedRingSeconds: number
}

export interface McCallStatus {
  callId: string
  status: string
  durationSec: number | null
  queuedAt: string
  ringingAt: string | null
  answeredAt: string | null
  completedAt: string | null
  failedAt: string | null
  failureReason: string | null
  summary: string | null
  recordingUrl: string | null
}

export class McApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'McApiError'
    this.status = status
    this.body = body
  }
}

export interface McClientConfig {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}

function resolveBaseUrl(explicit?: string): string {
  if (explicit) return explicit.replace(/\/$/, '')
  const env = process.env[MC_BASE_URL_ENV]
  if (env) return env.replace(/\/$/, '')
  return process.env.NODE_ENV === 'production'
    ? DEFAULT_MC_BASE_URL_PROD
    : DEFAULT_MC_BASE_URL_STAGING
}

export function buildMcClientConfig(input: {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}): McClientConfig {
  return {
    baseUrl: resolveBaseUrl(input.baseUrl),
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl,
  }
}

async function mcFetch<T>(
  cfg: McClientConfig,
  init: {
    method: 'GET' | 'POST'
    path: string
    body?: unknown
    headers?: Record<string, string>
    timeoutMs?: number
  },
): Promise<T> {
  const url = `${cfg.baseUrl}${init.path}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000)
  try {
    const f = cfg.fetchImpl ?? fetch
    const res = await f(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    })
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null
    } catch {
      /* keep parsed=null; body isn't JSON */
    }
    if (!res.ok) {
      throw new McApiError(res.status, `MC ${init.method} ${init.path} → ${res.status}`, parsed ?? text)
    }
    return parsed as T
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * POST /v1/external-simulations/dial. HF wraps this behind
 * McSimulationRunner.launch which handles the row-first-then-dial
 * sequencing that fixes the webhook-before-response race.
 */
export function mcDial(cfg: McClientConfig, input: DialInput): Promise<DialResponse> {
  return mcFetch<DialResponse>(cfg, {
    method: 'POST',
    path: '/v1/external-simulations/dial',
    headers: { 'Idempotency-Key': input.idempotencyKey },
    body: {
      destinationPhone: input.destinationPhone,
      clientReferenceId: input.clientReferenceId,
      callbackUrl: input.callbackUrl,
      personaContext: input.personaContext,
    },
  })
}

/**
 * GET /v1/external-simulations/call/:callId. Used by the polling
 * reconciliation route to fetch authoritative state when webhooks lag
 * or drop.
 */
export function mcGetCallStatus(cfg: McClientConfig, callId: string): Promise<McCallStatus> {
  return mcFetch<McCallStatus>(cfg, {
    method: 'GET',
    path: `/v1/external-simulations/call/${encodeURIComponent(callId)}`,
  })
}
