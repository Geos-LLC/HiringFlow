/**
 * POST /api/mc-connection/connect
 *
 * Self-serve MC provisioning path — the primary "Connect MockCustomer"
 * button. Flow:
 *
 *   1. Workspace-scoped auth.
 *   2. If a mapping already exists AND is `canaryEnabled=true` → 200
 *      idempotent no-op (someone else in the workspace already
 *      connected). Prevents multi-user race from provisioning twice.
 *   3. If a mapping exists AND is disconnected (`canaryEnabled=false`)
 *      → flip it back on and return without re-calling MC. Reuses
 *      whatever creds the workspace originally provisioned. Matches
 *      MC's idempotent Org.slug semantics.
 *   4. Otherwise → call MC's POST /v1/partners/provision, encrypt the
 *      returned api key + webhook secret, upsert the mapping row,
 *      return status.
 *
 * Errors:
 *   - `mc_not_configured` — MC_API_URL or MC_PARTNER_PROVISION_TOKEN
 *     missing on this HF deploy. Ops error, surface as 500.
 *   - `mc_timeout` — MC didn't respond within 15s. Transient, 504.
 *   - `mc_http_error` — MC returned non-2xx. Surface status verbatim.
 *   - `mc_already_provisioned_no_creds` — extremely rare edge: MC has
 *     the org (idempotent hit) but HF has no cached creds AND the
 *     mapping was somehow lost. Requires ops rotation, 409.
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { encryptMcSecret } from '@/lib/mockcustomer/encryption'
import {
  McPartnerProvisionError,
  mcPartnerProvision,
} from '@/lib/mockcustomer/partner-provision'

export const dynamic = 'force-dynamic'

export async function POST() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  // Fast path: already connected.
  const existing = await prisma.mcWorkspaceMapping.findUnique({
    where: { workspaceId: ws.workspaceId },
    select: {
      id: true,
      mcOrganizationSlug: true,
      mcEnvironment: true,
      canaryEnabled: true,
    },
  })
  if (existing?.canaryEnabled) {
    return NextResponse.json({
      connected: true,
      mcOrganizationSlug: existing.mcOrganizationSlug,
      mcEnvironment: existing.mcEnvironment,
      reused: true,
    })
  }
  if (existing && !existing.canaryEnabled) {
    // Disconnected → reconnect: flip flag on, reuse stored creds.
    const flipped = await prisma.mcWorkspaceMapping.update({
      where: { id: existing.id },
      data: { canaryEnabled: true },
      select: { mcOrganizationSlug: true, mcEnvironment: true },
    })
    return NextResponse.json({
      connected: true,
      mcOrganizationSlug: flipped.mcOrganizationSlug,
      mcEnvironment: flipped.mcEnvironment,
      reused: true,
    })
  }

  // Look up workspace name + user email for MC's audit trail.
  const [wsRow, userRow] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: ws.workspaceId },
      select: { name: true },
    }),
    prisma.user.findUnique({
      where: { id: ws.userId },
      select: { email: true },
    }),
  ])

  try {
    const provisioned = await mcPartnerProvision({
      partnerWorkspaceId: ws.workspaceId,
      partnerWorkspaceName: wsRow?.name ?? 'HireFunnel Workspace',
      partnerUserEmail: userRow?.email ?? null,
      environment: 'live',
    })

    if (provisioned.alreadyProvisioned) {
      // MC has the org but we have no cached plaintext creds AND no row
      // locally (we'd have hit the fast path if the row existed). Only
      // happens if HF DB row was deleted out-of-band. Requires ops
      // rotation on MC side.
      return NextResponse.json(
        {
          error:
            'MockCustomer already provisioned this workspace but credentials are missing locally. Please contact support to rotate.',
          reason: 'mc_already_provisioned_no_creds',
        },
        { status: 409 },
      )
    }

    // Persist encrypted. Upsert instead of create so a concurrent
    // connect (two tabs) merges cleanly on the workspaceId unique.
    await prisma.mcWorkspaceMapping.upsert({
      where: { workspaceId: ws.workspaceId },
      create: {
        workspaceId: ws.workspaceId,
        mcOrganizationId: provisioned.organizationId,
        mcOrganizationSlug: provisioned.organizationSlug,
        mcApiKeyEncrypted: encryptMcSecret(provisioned.apiKey),
        mcWebhookSecretEncrypted: encryptMcSecret(provisioned.webhookSecret),
        mcEnvironment: provisioned.environment,
        canaryEnabled: true,
      },
      update: {
        mcOrganizationId: provisioned.organizationId,
        mcOrganizationSlug: provisioned.organizationSlug,
        mcApiKeyEncrypted: encryptMcSecret(provisioned.apiKey),
        mcWebhookSecretEncrypted: encryptMcSecret(provisioned.webhookSecret),
        mcEnvironment: provisioned.environment,
        canaryEnabled: true,
      },
    })

    return NextResponse.json({
      connected: true,
      mcOrganizationSlug: provisioned.organizationSlug,
      mcEnvironment: provisioned.environment,
      reused: false,
    })
  } catch (err) {
    if (err instanceof McPartnerProvisionError) {
      const status =
        err.reason === 'not_configured'
          ? 500
          : err.reason === 'timeout'
            ? 504
            : err.reason === 'http_error'
              ? err.status ?? 502
              : 502
      return NextResponse.json(
        {
          error: 'Failed to connect MockCustomer',
          reason: `mc_${err.reason}`,
          detail: typeof err.body === 'string' ? err.body : JSON.stringify(err.body ?? {}).slice(0, 500),
        },
        { status },
      )
    }
    console.error('[mc-connection/connect] unexpected', err)
    return NextResponse.json(
      { error: 'Unexpected error connecting MockCustomer', reason: 'internal' },
      { status: 500 },
    )
  }
}
