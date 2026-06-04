import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// Shape of the `usage` field returned on every template row. Empty arrays
// mean "not referenced anywhere" — the UI uses that as the trigger for the
// "Not used" badge and the unguarded delete affordance.
export interface TemplateUsage {
  ruleIds: string[]
  ruleNames: string[]
}

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const templates = await prisma.emailTemplate.findMany({
    where: { workspaceId: ws.workspaceId },
    orderBy: { updatedAt: 'desc' },
    include: {
      // Rules that point directly at this template (legacy single-step
      // rules) — referenced via `AutomationRule.emailTemplateId`.
      automations: { select: { id: true, name: true } },
      // Steps inside multi-step rules that use this template — we want the
      // PARENT rule's id+name so the "Used in" pill names the rule, not the
      // anonymous step.
      steps: { select: { rule: { select: { id: true, name: true } } } },
    },
  })

  const withUsage = templates.map((t) => {
    const refs = new Map<string, string>()
    for (const r of t.automations) refs.set(r.id, r.name)
    for (const s of t.steps) refs.set(s.rule.id, s.rule.name)
    const ruleIds = Array.from(refs.keys())
    const ruleNames = Array.from(refs.values())
    // Strip the relation arrays before returning — the UI only needs `usage`.
    const { automations: _a, steps: _s, ...rest } = t
    return { ...rest, usage: { ruleIds, ruleNames } as TemplateUsage }
  })

  return NextResponse.json(withUsage)
}

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const { name, subject, bodyHtml, bodyText } = await request.json()
  if (!name || !subject || !bodyHtml) return NextResponse.json({ error: 'name, subject, bodyHtml required' }, { status: 400 })
  try {
    const template = await prisma.emailTemplate.create({
      data: { workspaceId: ws.workspaceId, createdById: ws.userId, name, subject, bodyHtml, bodyText: bodyText || null },
    })
    return NextResponse.json(template)
  } catch (err) {
    // P2002 = unique constraint violation on (workspaceId, name).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json(
        { error: 'A template with this name already exists', code: 'duplicate_name' },
        { status: 409 },
      )
    }
    throw err
  }
}
