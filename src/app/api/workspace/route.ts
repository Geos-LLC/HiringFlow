/**
 * DELETE /api/workspace
 *
 * Owner-only. Deletes the current workspace and every row scoped to it via
 * Prisma's onDelete: Cascade (candidates, flows, meetings, automations,
 * scheduling configs, integrations, memberships, etc.). Irreversible.
 *
 * Body: { confirmName: string } — must equal the workspace's `name`
 * exactly (case-insensitive, trimmed). Guard against clicking through the
 * confirm dialog by accident; the client also renders a type-to-confirm
 * input, but the server is the authoritative gate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized, forbidden, isOwner } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function DELETE(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  if (!isOwner(ws.role, ws.isSuperAdmin)) {
    return forbidden('Only the workspace owner can delete the workspace')
  }

  const { confirmName } = await request.json().catch(() => ({ confirmName: null }))
  if (!confirmName || typeof confirmName !== 'string') {
    return NextResponse.json({ error: 'confirmName required' }, { status: 400 })
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: ws.workspaceId },
    select: { id: true, name: true },
  })
  if (!workspace) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (confirmName.trim().toLowerCase() !== workspace.name.toLowerCase()) {
    return NextResponse.json({ error: 'confirmName_mismatch', message: 'Confirmation text does not match the workspace name' }, { status: 400 })
  }

  // Cascade delete handles every related row via Prisma schema
  // (`onDelete: Cascade` on Workspace-scoped models).
  await prisma.workspace.delete({ where: { id: workspace.id } })

  return NextResponse.json({ success: true, deletedWorkspaceId: workspace.id, deletedName: workspace.name })
}
