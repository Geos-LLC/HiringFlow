import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, renderTemplate } from '@/lib/email'

// Bulk email to a manually-picked set of candidates from the candidates
// page. Distinct from the automation engine — this is a one-shot recruiter
// send, no AutomationExecution rows, no lifecycle hooks. Optional
// `saveAsTemplate.name` persists the composed subject/body as a reusable
// EmailTemplate so the recruiter can reuse it (and pick it up in any of
// the automation step editors that read EmailTemplate).
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = await request.json().catch(() => null) as {
    ids?: unknown
    subject?: unknown
    bodyHtml?: unknown
    bodyText?: unknown
    saveAsTemplate?: { name?: unknown } | null
  } | null

  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 })

  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : []
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const bodyHtml = typeof body.bodyHtml === 'string' ? body.bodyHtml : ''
  const bodyText = typeof body.bodyText === 'string' && body.bodyText.trim() ? body.bodyText : null
  const saveTemplateName = body.saveAsTemplate && typeof body.saveAsTemplate.name === 'string'
    ? body.saveAsTemplate.name.trim()
    : ''

  if (ids.length === 0) return NextResponse.json({ error: 'ids required' }, { status: 400 })
  if (!subject) return NextResponse.json({ error: 'subject required' }, { status: 400 })
  if (!bodyHtml.trim()) return NextResponse.json({ error: 'bodyHtml required' }, { status: 400 })

  // Optionally persist the composed message as a reusable EmailTemplate
  // before the sends fan out. The new template id is returned to the
  // client so it can prepend it to the template picker without refetching.
  let savedTemplateId: string | null = null
  if (saveTemplateName) {
    const template = await prisma.emailTemplate.create({
      data: {
        workspaceId: ws.workspaceId,
        createdById: ws.userId,
        name: saveTemplateName,
        subject,
        bodyHtml,
        bodyText,
      },
    })
    savedTemplateId = template.id
  }

  const sessions = await prisma.session.findMany({
    where: { id: { in: ids }, workspaceId: ws.workspaceId },
    select: {
      id: true,
      candidateName: true,
      candidateEmail: true,
      candidatePhone: true,
      source: true,
      flow: { select: { name: true } },
      ad: { select: { name: true } },
    },
  })

  let sent = 0
  let failed = 0
  const failures: { id: string; reason: string }[] = []

  for (const s of sessions) {
    if (!s.candidateEmail) {
      failed += 1
      failures.push({ id: s.id, reason: 'no email on file' })
      continue
    }
    const variables: Record<string, string> = {
      candidate_name: s.candidateName || 'Candidate',
      candidate_email: s.candidateEmail,
      candidate_phone: s.candidatePhone || '',
      flow_name: s.flow?.name || '',
      source: s.source || '',
      ad_name: s.ad?.name || '',
    }
    const renderedSubject = renderTemplate(subject, variables)
    const renderedHtml = renderTemplate(bodyHtml, variables)
    const renderedText = bodyText ? renderTemplate(bodyText, variables) : undefined
    const res = await sendEmail({
      to: s.candidateEmail,
      subject: renderedSubject,
      html: renderedHtml,
      text: renderedText,
      workspaceId: ws.workspaceId,
      candidateId: s.id,
    })
    if (res.success) sent += 1
    else { failed += 1; failures.push({ id: s.id, reason: res.error || 'unknown' }) }
  }

  // Surface ids that were requested but didn't resolve to a Session row
  // (cross-workspace id, deleted candidate, etc.) — counted as failures
  // so the client total matches the requested count.
  const found = new Set(sessions.map((s) => s.id))
  for (const id of ids) {
    if (!found.has(id)) { failed += 1; failures.push({ id, reason: 'not found' }) }
  }

  return NextResponse.json({ sent, failed, failures, savedTemplateId })
}
