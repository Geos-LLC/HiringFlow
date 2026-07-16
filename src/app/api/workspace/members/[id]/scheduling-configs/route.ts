import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized, forbidden, isAdminOrOwner } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// List every SchedulingConfig in the workspace and flag which ones already
// include this member in assignedMemberIds. Powers the "assign calendars to
// team member" modal opened right after invite (and from each member row).
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const member = await prisma.workspaceMember.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!member) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const rows = await prisma.schedulingConfig.findMany({
    where: { workspaceId: ws.workspaceId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      isDefault: true,
      useBuiltInScheduler: true,
      assignedMemberIds: true,
    },
  })

  const configs = rows.map((c) => ({
    id: c.id,
    name: c.name,
    isDefault: c.isDefault,
    useBuiltInScheduler: c.useBuiltInScheduler,
    assigned: c.assignedMemberIds.includes(member.id),
  }))

  return NextResponse.json({ configs })
}

// Sync this member's presence across the workspace's SchedulingConfigs:
// body.configIds is the exact set the member should now belong to. Add to
// configs newly included, remove from configs newly excluded. Runs in a
// transaction so a mid-way error can't leave the picker half-applied.
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  if (!isAdminOrOwner(ws.role, ws.isSuperAdmin)) {
    return forbidden('Only workspace admins and owners can assign calendars to team members')
  }

  const member = await prisma.workspaceMember.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!member) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  const raw: unknown[] = Array.isArray(body?.configIds) ? body.configIds : []
  const requested: string[] = raw.filter(
    (v: unknown): v is string => typeof v === 'string' && v.length > 0,
  )

  const configs = await prisma.schedulingConfig.findMany({
    where: { workspaceId: ws.workspaceId },
    select: { id: true, assignedMemberIds: true },
  })

  // Silent-drop config ids that don't belong to this workspace — same
  // stale-id tolerance the scheduling PATCH uses.
  const validIds = new Set<string>(configs.map((c) => c.id))
  const target = new Set<string>(requested.filter((id) => validIds.has(id)))

  const ops = configs.flatMap((c) => {
    const has = c.assignedMemberIds.includes(member.id)
    const shouldHave = target.has(c.id)
    if (has === shouldHave) return []
    const next = shouldHave
      ? Array.from(new Set([...c.assignedMemberIds, member.id]))
      : c.assignedMemberIds.filter((id) => id !== member.id)
    return [
      prisma.schedulingConfig.update({
        where: { id: c.id },
        data: { assignedMemberIds: next },
      }),
    ]
  })

  if (ops.length > 0) await prisma.$transaction(ops)

  return NextResponse.json({ success: true, assignedTo: target.size })
}
