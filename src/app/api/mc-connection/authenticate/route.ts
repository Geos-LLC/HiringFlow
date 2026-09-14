/**
 * POST /api/mc-connection/authenticate  { email, password }
 * POST /api/mc-connection/authenticate  ?complete=1  { grantToken, organizationId }
 *
 * Thin HF-side proxy for the MC partner-authenticate flow. The browser
 * never talks to MC directly — HF's server forwards.
 *
 * On successful /complete, the returned api key + webhook secret get
 * encrypted and upserted into McWorkspaceMapping. Same shape of result
 * as the auto-provision path (canaryEnabled=true, ready to run).
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { encryptMcSecret } from '@/lib/mockcustomer/encryption'
import {
  mcPartnerAuthenticate,
  mcPartnerComplete,
  McPartnerAuthError,
} from '@/lib/mockcustomer/partner-authenticate'

export const dynamic = 'force-dynamic'

function mapErr(err: unknown): NextResponse {
  if (err instanceof McPartnerAuthError) {
    const status =
      err.reason === 'not_configured'
        ? 500
        : err.reason === 'timeout'
          ? 504
          : err.reason === 'network'
            ? 502
            : err.reason === 'invalid_credentials'
              ? 401
              : err.reason === 'grant_invalid' || err.reason === 'org_not_permitted'
                ? 401
                : err.reason === 'no_orgs'
                  ? 409
                  : err.reason === 'http_error'
                    ? err.status ?? 502
                    : 502
    return NextResponse.json(
      {
        error:
          err.reason === 'invalid_credentials'
            ? 'Invalid MockCustomer email or password.'
            : err.reason === 'no_orgs'
              ? 'This account has no active MockCustomer organizations.'
              : err.reason === 'grant_invalid'
                ? 'Your login session expired — please re-enter your password.'
                : 'MockCustomer request failed',
        reason: err.reason,
      },
      { status },
    )
  }
  console.error('[mc-connection/authenticate] unexpected', err)
  return NextResponse.json({ error: 'Internal error', reason: 'internal' }, { status: 500 })
}

export async function POST(request: Request) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  let body: {
    email?: unknown
    password?: unknown
    grantToken?: unknown
    organizationId?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const isComplete = typeof body.grantToken === 'string' && body.grantToken.length > 0

  if (!isComplete) {
    // Step 1: authenticate with email + password
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!email || !password) {
      return NextResponse.json(
        { error: 'email and password required', reason: 'missing_credentials' },
        { status: 400 },
      )
    }
    try {
      const result = await mcPartnerAuthenticate(email, password)
      return NextResponse.json({
        userId: result.userId,
        orgs: result.orgs,
        grantToken: result.grantToken,
      })
    } catch (err) {
      return mapErr(err)
    }
  }

  // Step 2: complete — mint key on chosen org + persist mapping.
  const grantToken = String(body.grantToken)
  const organizationId = typeof body.organizationId === 'string' ? body.organizationId.trim() : ''
  if (!organizationId) {
    return NextResponse.json(
      { error: 'organizationId required to complete', reason: 'missing_org_id' },
      { status: 400 },
    )
  }

  // Fetch workspace name for the MC-side label so audit is readable.
  const wsRow = await prisma.workspace.findUnique({
    where: { id: ws.workspaceId },
    select: { name: true },
  })

  try {
    const result = await mcPartnerComplete({
      grantToken,
      organizationId,
      partnerWorkspaceId: ws.workspaceId,
      partnerWorkspaceName: wsRow?.name ?? 'HireFunnel Workspace',
    })
    // Persist encrypted, upsert on workspaceId so this cleanly replaces
    // a prior connection (whether auto-provisioned or a prior link).
    await prisma.mcWorkspaceMapping.upsert({
      where: { workspaceId: ws.workspaceId },
      create: {
        workspaceId: ws.workspaceId,
        mcOrganizationId: result.organizationId,
        mcOrganizationSlug: result.organizationSlug,
        mcApiKeyEncrypted: encryptMcSecret(result.apiKey),
        mcWebhookSecretEncrypted: encryptMcSecret(result.webhookSecret),
        mcEnvironment: result.environment,
        canaryEnabled: true,
      },
      update: {
        mcOrganizationId: result.organizationId,
        mcOrganizationSlug: result.organizationSlug,
        mcApiKeyEncrypted: encryptMcSecret(result.apiKey),
        mcWebhookSecretEncrypted: encryptMcSecret(result.webhookSecret),
        mcEnvironment: result.environment,
        canaryEnabled: true,
      },
    })
    return NextResponse.json({
      connected: true,
      mcOrganizationSlug: result.organizationSlug,
      mcEnvironment: result.environment,
    })
  } catch (err) {
    return mapErr(err)
  }
}
