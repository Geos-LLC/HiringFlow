import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized, forbidden, isAdminOrOwner } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  if (!isAdminOrOwner(ws.role, ws.isSuperAdmin)) {
    return forbidden('Only workspace admins and owners can change member roles')
  }

  const member = await prisma.workspaceMember.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
  })
  if (!member) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { role } = await request.json()

  // Admins cannot promote to owner or demote an existing owner — only
  // another owner (or a super admin) can shuffle ownership. Prevents an
  // admin from either self-promoting or removing the workspace creator's
  // ability to delete the workspace.
  const isOwnerActor = ws.isSuperAdmin || ws.role === 'owner'
  if (!isOwnerActor && (role === 'owner' || member.role === 'owner')) {
    return forbidden('Only an owner can promote to owner or change an owner\'s role')
  }

  const updated = await prisma.workspaceMember.update({
    where: { id: params.id },
    data: { role },
  })
  return NextResponse.json(updated)
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  if (!isAdminOrOwner(ws.role, ws.isSuperAdmin)) {
    return forbidden('Only workspace admins and owners can remove team members')
  }

  const member = await prisma.workspaceMember.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
  })
  if (!member) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (member.userId === ws.userId) return NextResponse.json({ error: 'Cannot remove yourself' }, { status: 400 })

  // An admin can't remove an owner; only owners (or super admins) can.
  const isOwnerActor = ws.isSuperAdmin || ws.role === 'owner'
  if (!isOwnerActor && member.role === 'owner') {
    return forbidden('Only an owner can remove another owner')
  }

  await prisma.workspaceMember.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
