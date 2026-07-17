import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// Temporary diagnostic endpoint for the "training link in automation preview
// doesn't open" bug. Dumps the rule's step templates and pattern-matches every
// merge-token form we know about so we can see exactly which one the recruiter
// is using. DELETE ME once the bug is fixed.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const rule = await prisma.automationRule.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    include: {
      steps: {
        orderBy: { order: 'asc' },
        include: {
          emailTemplate: { select: { id: true, name: true, subject: true, bodyHtml: true, bodyText: true } },
          smsTemplate: { select: { id: true, name: true, body: true } },
          training: { select: { id: true, slug: true, title: true, isPublished: true, accessMode: true, workspaceId: true } },
        },
      },
    },
  })
  if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const bareTraining = /\{\{\s*training_link\s*\}\}/g
  const subTraining = /\{\{\s*training_link:([A-Za-z0-9_-]+)\s*\}\}/g
  const anyHref = /href\s*=\s*"([^"]*)"/gi

  const findAll = (re: RegExp, text: string) => {
    const out: string[] = []
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(text)) !== null) out.push(m[0])
    return out
  }

  return NextResponse.json({
    ruleId: rule.id,
    ruleName: rule.name,
    steps: rule.steps.map((s) => {
      const combined = `${s.emailTemplate?.subject ?? ''}\n${s.emailTemplate?.bodyHtml ?? ''}\n${s.emailTemplate?.bodyText ?? ''}\n${s.smsTemplate?.body ?? ''}\n${s.smsBody ?? ''}`
      return {
        stepId: s.id,
        order: s.order,
        channel: s.channel,
        nextStepType: s.nextStepType,
        nextStepUrl: s.nextStepUrl,
        training: s.training,
        emailTemplate: s.emailTemplate ? {
          id: s.emailTemplate.id,
          name: s.emailTemplate.name,
          subject: s.emailTemplate.subject,
          bodyHtmlLength: s.emailTemplate.bodyHtml.length,
          bodyHtmlPreview: s.emailTemplate.bodyHtml.slice(0, 1500),
          bodyText: s.emailTemplate.bodyText,
        } : null,
        smsTemplate: s.smsTemplate,
        smsBody: s.smsBody,
        tokenMatches: {
          bareTrainingLink: findAll(bareTraining, combined),
          subTokenTrainingLink: findAll(subTraining, combined),
          allHrefs: findAll(anyHref, s.emailTemplate?.bodyHtml ?? ''),
        },
      }
    }),
  })
}
