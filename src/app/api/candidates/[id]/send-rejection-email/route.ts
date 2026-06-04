import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, renderTemplate } from '@/lib/email'

// Sends a manual rejection email to the candidate. The recruiter has either
// generated the body via /generate-rejection-email or hand-typed it. We
// render merge tokens (candidate_name, flow_name) here so the same body can
// be saved as an EmailTemplate downstream and re-used.
//
// Logs a SchedulingEvent of type 'rejection_email_sent' so the timeline on
// the candidate page surfaces it next to the rest of the lifecycle events.

interface Body {
  subject?: string
  bodyHtml?: string
  // Optional plain-text alternative. Falls back to a strip of bodyHtml.
  bodyText?: string | null
}

function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = (await request.json().catch(() => ({}))) as Body
  const subjectRaw = typeof body.subject === 'string' ? body.subject.trim() : ''
  const bodyHtmlRaw = typeof body.bodyHtml === 'string' ? body.bodyHtml.trim() : ''
  if (!subjectRaw || !bodyHtmlRaw) {
    return NextResponse.json({ error: 'subject and bodyHtml required' }, { status: 400 })
  }

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    include: {
      flow: { select: { name: true } },
      workspace: {
        select: {
          senderEmail: true,
          senderName: true,
          senderVerifiedAt: true,
          senderDomain: true,
          senderDomainValidatedAt: true,
        },
      },
    },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!session.candidateEmail) {
    return NextResponse.json({ error: 'Candidate has no email on file.' }, { status: 400 })
  }

  const variables: Record<string, string> = {
    candidate_name: session.candidateName || 'there',
    flow_name: session.flow?.name || '',
    candidate_email: session.candidateEmail || '',
    candidate_phone: session.candidatePhone || '',
  }

  const subject = renderTemplate(subjectRaw, variables)
  const html = renderTemplate(bodyHtmlRaw, variables)
  const text = body.bodyText ? renderTemplate(body.bodyText, variables) : stripHtml(html)

  // Prefer workspace verified sender, else platform default.
  let from: { email: string; name?: string } | null = null
  const wsRow = session.workspace
  if (wsRow?.senderEmail && wsRow?.senderName) {
    const domainOk = !!(
      wsRow.senderDomainValidatedAt &&
      wsRow.senderDomain &&
      wsRow.senderEmail.toLowerCase().endsWith('@' + wsRow.senderDomain.toLowerCase())
    )
    const singleOk = !!wsRow.senderVerifiedAt
    if (domainOk || singleOk) from = { email: wsRow.senderEmail, name: wsRow.senderName || undefined }
  }

  const result = await sendEmail({
    to: session.candidateEmail,
    subject,
    html,
    text,
    from,
    workspaceId: session.workspaceId,
    candidateId: session.id,
    unsubscribeSessionId: session.id,
  })
  if (!result.success) {
    return NextResponse.json({ error: result.error || 'Email send failed' }, { status: 502 })
  }

  await prisma.schedulingEvent
    .create({
      data: {
        sessionId: session.id,
        eventType: 'rejection_email_sent',
        metadata: {
          subject,
          to: session.candidateEmail,
          reason: session.rejectionReason || null,
          sentBy: ws.userId,
          messageId: result.messageId || null,
        },
      },
    })
    .catch((err) => console.error('[send-rejection-email] failed to log SchedulingEvent:', err))

  return NextResponse.json({ ok: true, messageId: result.messageId || null })
}
