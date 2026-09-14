/**
 * Server-to-server client for MC's partner AI Customer endpoints. Both
 * routes are auth'd by the same X-MC-Partner-Token as /provision — they
 * live under /v1/partners/* on MC.
 *
 * Kept separate from partner-provision.ts because these two operate on
 * an already-provisioned org (identified by slug) while partner-provision
 * bootstraps a fresh org — different lifecycle, different failure modes.
 */

const PARTNER_TOKEN_HEADER = 'x-mc-partner-token'
const DEFAULT_TIMEOUT_MS = 10_000

export interface AiCustomerRow {
  id: string
  name: string
  createdAt: string
}

export interface ListAiCustomersResult {
  organizationId: string
  organizationSlug: string
  activeAiCustomerId: string | null
  aiCustomers: AiCustomerRow[]
}

export class McPartnerApiError extends Error {
  constructor(
    public readonly reason:
      | 'not_configured'
      | 'timeout'
      | 'http_error'
      | 'network'
      | 'malformed_response',
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message)
    this.name = 'McPartnerApiError'
  }
}

async function partnerFetch(
  path: string,
  init: { method: 'GET' | 'PATCH'; body?: unknown; timeoutMs?: number } = { method: 'GET' },
): Promise<unknown> {
  const baseUrl = process.env.MC_API_URL
  const token = process.env.MC_PARTNER_PROVISION_TOKEN
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new McPartnerApiError('not_configured', 'MC_API_URL missing')
  }
  if (!token || token.length < 32) {
    throw new McPartnerApiError('not_configured', 'MC_PARTNER_PROVISION_TOKEN missing')
  }
  const url = baseUrl.replace(/\/$/, '') + path
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        [PARTNER_TOKEN_HEADER]: token,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    if (!res.ok) {
      throw new McPartnerApiError(
        'http_error',
        `MC ${init.method} ${path} → ${res.status}`,
        res.status,
        parsed,
      )
    }
    return parsed
  } catch (err) {
    if (err instanceof McPartnerApiError) throw err
    if (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))) {
      throw new McPartnerApiError('timeout', `MC ${path} timed out`)
    }
    throw new McPartnerApiError(
      'network',
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    clearTimeout(timer)
  }
}

/** List AiCustomers for a MC organization identified by slug. */
export async function listMcAiCustomers(orgSlug: string): Promise<ListAiCustomersResult> {
  const body = await partnerFetch(`/v1/partners/organizations/${encodeURIComponent(orgSlug)}/ai-customers`)
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { organizationId?: unknown }).organizationId !== 'string' ||
    !Array.isArray((body as { aiCustomers?: unknown }).aiCustomers)
  ) {
    throw new McPartnerApiError('malformed_response', 'MC list-ai-customers response missing fields')
  }
  return body as ListAiCustomersResult
}

/**
 * Set the active AiCustomer for an org. MC's behavioral-snapshot-resolver
 * reads Organization.activeAiCustomerId when resolving persona/rubric/
 * scenario for each dial, so this is the whole wiring — no dial-time
 * parameter needed.
 *
 * Pass `null` to clear (MC falls back to the first AiCustomer).
 */
export async function setActiveMcAiCustomer(
  orgSlug: string,
  aiCustomerId: string | null,
): Promise<{ organizationId: string; organizationSlug: string; activeAiCustomerId: string | null }> {
  const body = await partnerFetch(
    `/v1/partners/organizations/${encodeURIComponent(orgSlug)}/active-ai-customer`,
    { method: 'PATCH', body: { aiCustomerId } },
  )
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { organizationId?: unknown }).organizationId !== 'string'
  ) {
    throw new McPartnerApiError('malformed_response', 'MC set-active-ai-customer response missing fields')
  }
  return body as { organizationId: string; organizationSlug: string; activeAiCustomerId: string | null }
}
