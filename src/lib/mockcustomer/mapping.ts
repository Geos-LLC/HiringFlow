/**
 * Resolve the per-workspace MockCustomer binding. Encapsulates the
 * canary gate + credential decrypt in one place so route handlers,
 * the runner, and the webhook receiver all use the same lookup.
 *
 * NOT self-serve in PR1B: operators mint an MC key + set
 * canaryEnabled=true out of band. The UI + launch route treat a
 * missing / non-canary mapping identically (403 "not enabled").
 */

import type { PrismaClient } from '@prisma/client'
import { decryptMcSecret } from './encryption'

export interface ResolvedMcMapping {
  workspaceId: string
  mcOrganizationId: string
  mcOrganizationSlug: string
  mcApiKey: string
  mcWebhookSecret: string
  mcEnvironment: 'test' | 'live'
}

export type ResolveMcMappingResult =
  | { ok: true; mapping: ResolvedMcMapping }
  | { ok: false; reason: 'not_configured' | 'canary_disabled' }

/**
 * Loads and decrypts the mapping for a workspace. Returns
 * `not_configured` if no row exists at all, or `canary_disabled` when
 * a row exists but its flag is off. Both cases should surface to the
 * caller as HTTP 403 — the recruiter shouldn't be able to tell the
 * difference between "MC never provisioned here" and "MC provisioned
 * but currently disabled."
 */
export async function resolveMcMapping(
  prisma: Pick<PrismaClient, 'mcWorkspaceMapping'>,
  workspaceId: string,
): Promise<ResolveMcMappingResult> {
  const row = await prisma.mcWorkspaceMapping.findUnique({
    where: { workspaceId },
  })
  if (!row) return { ok: false, reason: 'not_configured' }
  if (!row.canaryEnabled) return { ok: false, reason: 'canary_disabled' }
  return {
    ok: true,
    mapping: {
      workspaceId,
      mcOrganizationId: row.mcOrganizationId,
      mcOrganizationSlug: row.mcOrganizationSlug,
      mcApiKey: decryptMcSecret(row.mcApiKeyEncrypted),
      mcWebhookSecret: decryptMcSecret(row.mcWebhookSecretEncrypted),
      mcEnvironment: row.mcEnvironment === 'live' ? 'live' : 'test',
    },
  }
}
