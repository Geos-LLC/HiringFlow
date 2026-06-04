import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// SMS templates are referenced only from AutomationStep — there is no direct
// AutomationRule.smsTemplateId column (legacy single-step rules carried the
// body inline in `automationRule.smsBody`). We aggregate to parent rules so
// the UI badge counts "rules using this template", not "steps."
export interface TemplateUsage {
  ruleIds: string[]
  ruleNames: string[]
}

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const templates = await prisma.smsTemplate.findMany({
    where: { workspaceId: ws.workspaceId },
    orderBy: { updatedAt: 'desc' },
    include: {
      steps: { select: { rule: { select: { id: true, name: true } } } },
    },
  })

  const withUsage = templates.map((t) => {
    const refs = new Map<string, string>()
    for (const s of t.steps) refs.set(s.rule.id, s.rule.name)
    const { steps: _s, ...rest } = t
    return {
      ...rest,
      usage: { ruleIds: Array.from(refs.keys()), ruleNames: Array.from(refs.values()) } as TemplateUsage,
    }
  })

  return NextResponse.json(withUsage)
}

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const { name, body } = await request.json()
  if (!name || !body) return NextResponse.json({ error: 'name, body required' }, { status: 400 })
  try {
    const template = await prisma.smsTemplate.create({
      data: { workspaceId: ws.workspaceId, createdById: ws.userId, name, body },
    })
    return NextResponse.json(template)
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json(
        { error: 'A template with this name already exists', code: 'duplicate_name' },
        { status: 409 },
      )
    }
    throw err
  }
}
