import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const configs = await prisma.schedulingConfig.findMany({
    where: { workspaceId: ws.workspaceId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { events: true } },
    },
  })

  return NextResponse.json(configs)
}

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const { name, schedulingUrl, isDefault, useBuiltInScheduler, assignedMemberIds } = await request.json()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  // Built-in scheduler doesn't need an external URL; placeholder is fine.
  if (!useBuiltInScheduler && !schedulingUrl) {
    return NextResponse.json({ error: 'schedulingUrl required for external providers' }, { status: 400 })
  }

  // If setting as default, clear existing defaults
  if (isDefault) {
    await prisma.schedulingConfig.updateMany({
      where: { workspaceId: ws.workspaceId, isDefault: true },
      data: { isDefault: false },
    })
  }

  const memberIds = await validateMemberIds(ws.workspaceId, assignedMemberIds)

  const config = await prisma.schedulingConfig.create({
    data: {
      workspaceId: ws.workspaceId,
      createdById: ws.userId,
      name,
      provider: useBuiltInScheduler ? 'built_in' : 'calendly',
      schedulingUrl: schedulingUrl || '',
      isDefault: !!isDefault,
      useBuiltInScheduler: !!useBuiltInScheduler,
      assignedMemberIds: memberIds,
    },
  })

  return NextResponse.json(config)
}

// Cross-check submitted WorkspaceMember ids belong to this workspace so a
// forged/stale id can't be persisted onto the config. Silent-drops mismatched
// ids rather than throwing — a stale id in the picker (member was removed
// between page load and save) shouldn't block the save entirely.
async function validateMemberIds(workspaceId: string, ids: unknown): Promise<string[]> {
  if (!Array.isArray(ids)) return []
  const clean = ids.filter((v): v is string => typeof v === 'string' && v.length > 0)
  if (clean.length === 0) return []
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId, id: { in: Array.from(new Set(clean)) } },
    select: { id: true },
  })
  const valid = new Set(rows.map((r) => r.id))
  return clean.filter((id) => valid.has(id))
}
