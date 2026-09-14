/**
 * DELETE /api/mc-connection
 *
 * Soft-disconnects a workspace from MockCustomer: flips
 * canaryEnabled=false on the mapping row. Does NOT delete the row —
 * keeping the encrypted creds around lets a subsequent re-connect
 * reuse the same MC organization without needing MC-side rotation.
 *
 * MC-side impact: none. MC's Organization + ApiKey stay active. The
 * only consequence is that HF's launch route + panel treat this
 * workspace as "not connected" until re-connected.
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function DELETE() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const existing = await prisma.mcWorkspaceMapping.findUnique({
    where: { workspaceId: ws.workspaceId },
    select: { id: true, canaryEnabled: true },
  })
  if (!existing) {
    // Idempotent no-op: nothing to disconnect.
    return NextResponse.json({ connected: false, wasConnected: false })
  }
  if (!existing.canaryEnabled) {
    return NextResponse.json({ connected: false, wasConnected: false })
  }
  await prisma.mcWorkspaceMapping.update({
    where: { id: existing.id },
    data: { canaryEnabled: false },
  })
  return NextResponse.json({ connected: false, wasConnected: true })
}
