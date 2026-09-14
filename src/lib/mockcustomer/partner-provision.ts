/**
 * Server-to-server client for MC's partner-provisioning endpoint.
 * Called from the /api/mc-connection/connect route when a workspace
 * clicks "Connect MockCustomer" for the first time.
 *
 * The endpoint contract lives in the mockcustomer repo at
 * apps/api/src/platform-admin/partners-provision.controller.ts.
 * Idempotent by `slug = hf-<partnerWorkspaceId>` on MC's side — if we
 * ever double-call, second response has `alreadyProvisioned: true` and
 * omits plaintext creds (MC never persisted them past the first mint).
 * This client treats an idempotent hit without cached creds as an
 * error because HF-side we would have no way to decrypt an existing
 * mapping — the caller must either detect an existing mapping first
 * or accept the failure and rotate.
 */

const PARTNER_TOKEN_HEADER = 'x-mc-partner-token'
const DEFAULT_TIMEOUT_MS = 15_000

export interface ProvisionInput {
  partnerWorkspaceId: string
  partnerWorkspaceName: string
  partnerUserEmail?: string | null
  /** Defaults to 'live'. 'test' issues an mc_test_ key useful for staging. */
  environment?: 'test' | 'live'
}

export interface ProvisionSuccess {
  organizationId: string
  organizationSlug: string
  environment: 'test' | 'live'
  alreadyProvisioned: false
  apiKey: string
  webhookSecret: string
}

export interface ProvisionIdempotentMiss {
  organizationId: string
  organizationSlug: string
  environment: 'test' | 'live'
  alreadyProvisioned: true
  apiKey: null
  webhookSecret: null
}

export type ProvisionResult = ProvisionSuccess | ProvisionIdempotentMiss

export class McPartnerProvisionError extends Error {
  constructor(
    public readonly reason:
      | 'not_configured'
      | 'timeout'
      | 'http_error'
      | 'malformed_response'
      | 'network',
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message)
    this.name = 'McPartnerProvisionError'
  }
}

/**
 * Fires POST /v1/partners/provision against MC. Uses two env vars:
 *   - MC_API_URL              — base URL of MC's api-production service
 *   - MC_PARTNER_PROVISION_TOKEN — matches the token MC has configured
 *
 * Both throw `McPartnerProvisionError('not_configured')` if missing.
 */
export async function mcPartnerProvision(
  input: ProvisionInput,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProvisionResult> {
  const baseUrl = process.env.MC_API_URL
  const token = process.env.MC_PARTNER_PROVISION_TOKEN
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new McPartnerProvisionError(
      'not_configured',
      'MC_API_URL env var not set or not http(s)',
    )
  }
  if (!token || token.length < 32) {
    throw new McPartnerProvisionError(
      'not_configured',
      'MC_PARTNER_PROVISION_TOKEN env var missing or shorter than 32 chars',
    )
  }

  const url = baseUrl.replace(/\/$/, '') + '/v1/partners/provision'
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PARTNER_TOKEN_HEADER]: token,
      },
      body: JSON.stringify({
        partnerOrigin: 'hirefunnel',
        partnerWorkspaceId: input.partnerWorkspaceId,
        partnerWorkspaceName: input.partnerWorkspaceName,
        partnerUserEmail: input.partnerUserEmail ?? undefined,
        environment: input.environment ?? 'live',
      }),
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))) {
      throw new McPartnerProvisionError('timeout', `MC provision timed out after ${timeoutMs}ms`)
    }
    throw new McPartnerProvisionError(
      'network',
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    clearTimeout(timer)
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    throw new McPartnerProvisionError(
      'http_error',
      `MC provision returned ${res.status}`,
      res.status,
      body,
    )
  }

  // Response validation. We trust MC's shape but must still narrow to the
  // discriminated union safely — a malformed response is a config bug on
  // the MC side that we want to surface loudly.
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { organizationId?: unknown }).organizationId !== 'string' ||
    typeof (body as { organizationSlug?: unknown }).organizationSlug !== 'string'
  ) {
    throw new McPartnerProvisionError(
      'malformed_response',
      'MC provision response missing organizationId/organizationSlug',
      res.status,
      body,
    )
  }
  const b = body as {
    organizationId: string
    organizationSlug: string
    environment?: unknown
    alreadyProvisioned?: unknown
    apiKey?: unknown
    webhookSecret?: unknown
  }
  const environment: 'test' | 'live' = b.environment === 'test' ? 'test' : 'live'
  const alreadyProvisioned = b.alreadyProvisioned === true

  if (alreadyProvisioned) {
    return {
      organizationId: b.organizationId,
      organizationSlug: b.organizationSlug,
      environment,
      alreadyProvisioned: true,
      apiKey: null,
      webhookSecret: null,
    }
  }
  if (typeof b.apiKey !== 'string' || typeof b.webhookSecret !== 'string') {
    throw new McPartnerProvisionError(
      'malformed_response',
      'MC provision fresh-create response missing apiKey or webhookSecret',
      res.status,
      body,
    )
  }
  return {
    organizationId: b.organizationId,
    organizationSlug: b.organizationSlug,
    environment,
    alreadyProvisioned: false,
    apiKey: b.apiKey,
    webhookSecret: b.webhookSecret,
  }
}
