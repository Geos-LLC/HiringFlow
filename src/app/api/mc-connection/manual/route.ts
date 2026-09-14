/**
 * POST /api/mc-connection/manual
 *
 * "I already have a MockCustomer account" path. Recruiter pastes in a
 * plaintext api key + webhook secret they got from MC directly (or from
 * another partner integration). We validate the key against MC before
 * accepting to catch typos / stale creds — the validation is a
 * negative-space call (fake UUID → expected 404) that only succeeds
 * when the key auths successfully.
 *
 * Body:
 *   { apiKey: string, webhookSecret: string, mcOrganizationId?: string,
 *     mcOrganizationSlug?: string }
 *
 * If organizationId/slug not provided, we derive from the /v1/... auth
 * response — but MC doesn't currently return org identity on a bare
 * key ping, so for MVP the user must supply the slug at minimum. We
 * store the id + slug as user-supplied strings; downstream code only
 * uses slug for display and id for correlation on webhooks (which
 * carry both in the payload anyway, so a stale id here is
 * self-healing on first webhook arrival).
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { encryptMcSecret } from '@/lib/mockcustomer/encryption'
import { buildMcClientConfig, mcGetCallStatus, McApiError } from '@/lib/mockcustomer/client'

export const dynamic = 'force-dynamic'

const API_KEY_RE = /^mc_(test|live)_[A-Za-z0-9_-]{20,}$/
const WEBHOOK_SECRET_RE = /^whsec_[A-Za-z0-9_-]{20,}$/
const SLUG_RE = /^[a-z0-9-]{2,64}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  let body: {
    apiKey?: unknown
    webhookSecret?: unknown
    mcOrganizationId?: unknown
    mcOrganizationSlug?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  const webhookSecret = typeof body.webhookSecret === 'string' ? body.webhookSecret.trim() : ''
  const mcOrganizationSlug =
    typeof body.mcOrganizationSlug === 'string' ? body.mcOrganizationSlug.trim() : ''
  const mcOrganizationId =
    typeof body.mcOrganizationId === 'string' ? body.mcOrganizationId.trim() : ''

  if (!API_KEY_RE.test(apiKey)) {
    return NextResponse.json(
      { error: 'apiKey must look like mc_test_… or mc_live_…', reason: 'invalid_api_key' },
      { status: 400 },
    )
  }
  if (!WEBHOOK_SECRET_RE.test(webhookSecret)) {
    return NextResponse.json(
      { error: 'webhookSecret must look like whsec_…', reason: 'invalid_webhook_secret' },
      { status: 400 },
    )
  }
  if (!SLUG_RE.test(mcOrganizationSlug)) {
    return NextResponse.json(
      { error: 'mcOrganizationSlug required (letters/numbers/dashes only)', reason: 'invalid_slug' },
      { status: 400 },
    )
  }
  if (mcOrganizationId && !UUID_RE.test(mcOrganizationId)) {
    return NextResponse.json(
      { error: 'mcOrganizationId must be a UUID if provided', reason: 'invalid_org_id' },
      { status: 400 },
    )
  }

  // Validate the api key against MC — call a cheap read endpoint with
  // a random UUID. A working key returns 404 (call not found). A bad
  // key returns 401. Anything else is inconclusive; we treat it as a
  // validation failure to keep the "I typed a wrong key" UX honest.
  const baseUrl =
    process.env.MC_API_URL ?? 'https://mockcustomer-api-production-production.up.railway.app'
  const cfg = buildMcClientConfig({ apiKey, baseUrl })
  const probeUuid = '00000000-0000-0000-0000-000000000001'
  try {
    await mcGetCallStatus(cfg, probeUuid)
    // If MC actually returned 200 for a random UUID something is very
    // wrong; treat as ambiguous and store anyway (unlikely).
  } catch (err) {
    if (err instanceof McApiError) {
      if (err.status === 401 || err.status === 403) {
        return NextResponse.json(
          {
            error: 'MockCustomer rejected this API key. Check the value and try again.',
            reason: 'mc_auth_failed',
          },
          { status: 400 },
        )
      }
      if (err.status !== 404) {
        return NextResponse.json(
          {
            error: `MockCustomer returned an unexpected error while validating (${err.status}).`,
            reason: 'mc_validation_error',
          },
          { status: 502 },
        )
      }
      // 404 = key authenticated OK, no such call. Expected.
    } else {
      return NextResponse.json(
        {
          error: 'Could not reach MockCustomer to validate the API key.',
          reason: 'mc_unreachable',
        },
        { status: 502 },
      )
    }
  }

  // Persist. If mcOrganizationId not supplied, use a sentinel UUID —
  // the webhook receiver will backfill the real id on first arrival.
  const orgIdToStore =
    mcOrganizationId || '00000000-0000-0000-0000-000000000000'

  await prisma.mcWorkspaceMapping.upsert({
    where: { workspaceId: ws.workspaceId },
    create: {
      workspaceId: ws.workspaceId,
      mcOrganizationId: orgIdToStore,
      mcOrganizationSlug,
      mcApiKeyEncrypted: encryptMcSecret(apiKey),
      mcWebhookSecretEncrypted: encryptMcSecret(webhookSecret),
      mcEnvironment: apiKey.startsWith('mc_live_') ? 'live' : 'test',
      canaryEnabled: true,
    },
    update: {
      mcOrganizationId: orgIdToStore,
      mcOrganizationSlug,
      mcApiKeyEncrypted: encryptMcSecret(apiKey),
      mcWebhookSecretEncrypted: encryptMcSecret(webhookSecret),
      mcEnvironment: apiKey.startsWith('mc_live_') ? 'live' : 'test',
      canaryEnabled: true,
    },
  })

  return NextResponse.json({
    connected: true,
    mcOrganizationSlug,
    mcEnvironment: apiKey.startsWith('mc_live_') ? 'live' : 'test',
  })
}
