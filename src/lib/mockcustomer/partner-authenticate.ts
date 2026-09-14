/**
 * HF-side client for MC's partner authenticate flow. Server-to-server
 * only — no partner-token header on these endpoints because the user's
 * email + password IS the auth.
 *
 * Two-step: authenticate → complete. HF's login modal collects
 * credentials, calls authenticate, presents the returned orgs list to
 * the user (or auto-picks if only one), then calls complete with the
 * chosen orgId. Complete returns the freshly-minted api key + webhook
 * secret which HF encrypts + stores.
 */

const DEFAULT_TIMEOUT_MS = 15_000

export interface PartnerAuthOrg {
  id: string
  slug: string
  name: string
}

export interface PartnerAuthenticateResult {
  userId: string
  orgs: PartnerAuthOrg[]
  grantToken: string | null // null when orgs is empty
}

export interface PartnerCompleteInput {
  grantToken: string
  organizationId: string
  partnerWorkspaceId: string
  partnerWorkspaceName: string
}

export interface PartnerCompleteResult {
  organizationId: string
  organizationSlug: string
  environment: 'test' | 'live'
  apiKey: string
  webhookSecret: string
}

export class McPartnerAuthError extends Error {
  constructor(
    public readonly reason:
      | 'not_configured'
      | 'timeout'
      | 'network'
      | 'invalid_credentials'
      | 'no_orgs'
      | 'grant_invalid'
      | 'org_not_permitted'
      | 'http_error'
      | 'malformed_response',
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message)
    this.name = 'McPartnerAuthError'
  }
}

async function partnerAuthFetch(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const baseUrl = process.env.MC_API_URL
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new McPartnerAuthError('not_configured', 'MC_API_URL missing')
  }
  const url = baseUrl.replace(/\/$/, '') + path
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    if (!res.ok) {
      // 401 = invalid credentials or bad grant. Distinguish via response
      // body when possible; both surface as clear reason codes so the UI
      // can show the right message.
      const reason: McPartnerAuthError['reason'] =
        res.status === 401
          ? path.endsWith('/complete')
            ? 'grant_invalid'
            : 'invalid_credentials'
          : 'http_error'
      throw new McPartnerAuthError(
        reason,
        `MC ${path} → ${res.status}`,
        res.status,
        parsed,
      )
    }
    return parsed
  } catch (err) {
    if (err instanceof McPartnerAuthError) throw err
    if (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))) {
      throw new McPartnerAuthError('timeout', `MC ${path} timed out`)
    }
    throw new McPartnerAuthError(
      'network',
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    clearTimeout(timer)
  }
}

export async function mcPartnerAuthenticate(
  email: string,
  password: string,
): Promise<PartnerAuthenticateResult> {
  const body = await partnerAuthFetch('/v1/partners/authenticate', { email, password })
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { userId?: unknown }).userId !== 'string' ||
    !Array.isArray((body as { orgs?: unknown }).orgs)
  ) {
    throw new McPartnerAuthError('malformed_response', 'authenticate response missing fields')
  }
  const r = body as PartnerAuthenticateResult
  if (r.orgs.length === 0) {
    throw new McPartnerAuthError(
      'no_orgs',
      'This MockCustomer account has no active organizations.',
    )
  }
  return r
}

export async function mcPartnerComplete(
  input: PartnerCompleteInput,
): Promise<PartnerCompleteResult> {
  const body = await partnerAuthFetch('/v1/partners/authenticate/complete', {
    grantToken: input.grantToken,
    organizationId: input.organizationId,
    partnerOrigin: 'hirefunnel',
    partnerWorkspaceId: input.partnerWorkspaceId,
    partnerWorkspaceName: input.partnerWorkspaceName,
  })
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { apiKey?: unknown }).apiKey !== 'string' ||
    typeof (body as { webhookSecret?: unknown }).webhookSecret !== 'string'
  ) {
    throw new McPartnerAuthError('malformed_response', 'complete response missing fields')
  }
  return body as PartnerCompleteResult
}
