/**
 * GET /api/mc-connection/status
 *
 * Returns whether the current workspace has an active MockCustomer
 * connection. Drives the 3-state render logic of the "AI Customer
 * Simulations" panel: `unknown → not_connected → connected`.
 *
 * "Connected" is defined as: a McWorkspaceMapping row exists AND its
 * canaryEnabled flag is true. Disconnect toggles the flag off instead
 * of deleting the row so a re-connect can reuse the same MC organization
 * (matches MC's idempotent-provision behavior — MC's Organization is
 * durable, so wiping HF's row would strand it).
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const row = await prisma.mcWorkspaceMapping.findUnique({
    where: { workspaceId: ws.workspaceId },
    select: {
      mcOrganizationSlug: true,
      mcEnvironment: true,
      canaryEnabled: true,
      provisionedAt: true,
    },
  })

  if (!row) {
    return NextResponse.json({
      connected: false,
      mcOrganizationSlug: null,
      mcEnvironment: null,
      connectedAt: null,
    })
  }
  return NextResponse.json({
    connected: row.canaryEnabled,
    mcOrganizationSlug: row.mcOrganizationSlug,
    mcEnvironment: row.mcEnvironment,
    connectedAt: row.provisionedAt.toISOString(),
  })
}
