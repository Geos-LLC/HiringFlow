import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const workspace = await prisma.workspace.findUnique({
    where: { id: ws.workspaceId },
    include: {
      members: {
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { joinedAt: 'asc' },
      },
      _count: { select: { flows: true, sessions: true, ads: true, trainings: true } },
    },
  })

  if (!workspace) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    plan: workspace.plan,
    website: workspace.website,
    phone: workspace.phone,
    timezone: workspace.timezone,
    logoUrl: workspace.logoUrl,
    senderName: workspace.senderName,
    senderEmail: workspace.senderEmail,
    settings: workspace.settings,
    defaultStalledDays: workspace.defaultStalledDays,
    createdAt: workspace.createdAt,
    members: workspace.members.map(m => ({
      id: m.id,
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
    counts: workspace._count,
  })
}

export async function PATCH(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = await request.json()

  const updated = await prisma.workspace.update({
    where: { id: ws.workspaceId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.website !== undefined && { website: body.website || null }),
      ...(body.phone !== undefined && { phone: body.phone || null }),
      ...(body.timezone !== undefined && { timezone: body.timezone }),
      ...(body.logoUrl !== undefined && { logoUrl: body.logoUrl || null }),
      ...(body.senderName !== undefined && { senderName: body.senderName || null }),
      ...(body.senderEmail !== undefined && { senderEmail: body.senderEmail || null }),
      ...(body.settings !== undefined && { settings: body.settings }),
      ...(body.defaultStalledDays !== undefined && {
        defaultStalledDays: normalizeStalledDaysInput(body.defaultStalledDays),
      }),
    },
  })

  return NextResponse.json(updated)
}

// Empty string / null / negative / non-numeric → null (use platform default).
// Cap at 365 days so a typo can't disable detection. Floors to integer days.
function normalizeStalledDaysInput(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(365, Math.floor(n))
}
