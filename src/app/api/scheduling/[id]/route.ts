import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { parseBookingRules } from '@/lib/scheduling/booking-rules'
import { parseCustomFields } from '@/lib/scheduling/custom-fields'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const config = await prisma.schedulingConfig.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!config) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json()

  // If setting as default, clear existing defaults
  if (body.isDefault === true) {
    await prisma.schedulingConfig.updateMany({
      where: { workspaceId: ws.workspaceId, isDefault: true, id: { not: params.id } },
      data: { isDefault: false },
    })
  }

  // Validate bookingRules if present. Reject the whole PATCH on bad shape so
  // we never persist a malformed blob the slot computer can't read.
  let bookingRulesUpdate: Prisma.InputJsonValue | undefined
  if (body.bookingRules !== undefined) {
    try {
      bookingRulesUpdate = parseBookingRules(body.bookingRules) as unknown as Prisma.InputJsonValue
    } catch (err) {
      return NextResponse.json({ error: 'invalid_booking_rules', message: (err as Error).message }, { status: 400 })
    }
  }

  let customFieldsUpdate: Prisma.InputJsonValue | undefined
  if (body.customFields !== undefined) {
    try {
      customFieldsUpdate = parseCustomFields(body.customFields) as unknown as Prisma.InputJsonValue
    } catch (err) {
      return NextResponse.json({ error: 'invalid_custom_fields', message: (err as Error).message }, { status: 400 })
    }
  }

  // Cross-check assigned member ids belong to this workspace. Silent-drop
  // stale ids so a save doesn't fail if a member was removed between page
  // load and save.
  let assignedMemberIdsUpdate: string[] | undefined
  if (Array.isArray(body.assignedMemberIds)) {
    const clean = body.assignedMemberIds.filter((v: unknown): v is string => typeof v === 'string' && v.length > 0)
    const rows = await prisma.workspaceMember.findMany({
      where: { workspaceId: ws.workspaceId, id: { in: Array.from(new Set(clean)) as string[] } },
      select: { id: true },
    })
    const valid = new Set(rows.map((r) => r.id))
    assignedMemberIdsUpdate = clean.filter((id: string) => valid.has(id))
  }

  const updated = await prisma.schedulingConfig.update({
    where: { id: params.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.schedulingUrl !== undefined && { schedulingUrl: body.schedulingUrl }),
      ...(body.isDefault !== undefined && { isDefault: body.isDefault }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      ...(body.useBuiltInScheduler !== undefined && { useBuiltInScheduler: !!body.useBuiltInScheduler }),
      ...(bookingRulesUpdate !== undefined && { bookingRules: bookingRulesUpdate }),
      ...(body.calendarId !== undefined && { calendarId: body.calendarId || null }),
      ...(assignedMemberIdsUpdate !== undefined && { assignedMemberIds: assignedMemberIdsUpdate }),
      ...(customFieldsUpdate !== undefined && { customFields: customFieldsUpdate }),
    },
  })

  return NextResponse.json(updated)
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const config = await prisma.schedulingConfig.findFirst({ where: { id: params.id, workspaceId: ws.workspaceId } })
  if (!config) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await prisma.schedulingConfig.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
