import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, renderTemplate } from '@/lib/email'
import { sendSms, normalizeToE164 } from '@/lib/sms'
import { resolveDynamicLinks } from '@/lib/template-link-resolver'

// Generic manual candidate message. Replaces the old send-rejection-email
// endpoint for the recruiter-facing "Send message" composer on the
// candidate drawer. Supports email, SMS, or both in a single request, and
// optionally persists the body as a new EmailTemplate / SmsTemplate so
// recruiters can graduate ad-hoc messages into reusable templates.
//
// Logs one SchedulingEvent per send so the timeline reflects what went
// out on each channel.

type Channel = 'email' | 'sms' | 'both'

interface SaveAsTemplate {
  name?: string
}

interface Body {
  channels?: Channel
  email?: {
    subject?: string
    bodyHtml?: string
    bodyText?: string | null
    // Set when the recruiter ticked "Save as new template" with the email
    // tab visible. Server writes a new EmailTemplate row before sending.
    saveAsTemplate?: SaveAsTemplate
  }
  sms?: {
    body?: string
    saveAsTemplate?: SaveAsTemplate
  }
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
  const channels: Channel = body.channels === 'sms' || body.channels === 'both' ? body.channels : 'email'

  const emailSubjectRaw = body.email?.subject?.trim() || ''
  const emailHtmlRaw = body.email?.bodyHtml?.trim() || ''
  const emailTextRaw = typeof body.email?.bodyText === 'string' ? body.email.bodyText.trim() : ''
  const smsBodyRaw = body.sms?.body?.trim() || ''

  if (channels === 'email' || channels === 'both') {
    if (!emailSubjectRaw || !emailHtmlRaw) {
      return NextResponse.json({ error: 'Email subject and body are required.' }, { status: 400 })
    }
  }
  if (channels === 'sms' || channels === 'both') {
    if (!smsBodyRaw) {
      return NextResponse.json({ error: 'SMS body is required.' }, { status: 400 })
    }
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

  if ((channels === 'email' || channels === 'both') && !session.candidateEmail) {
    return NextResponse.json({ error: 'Candidate has no email on file.' }, { status: 400 })
  }
  const normalizedPhone = (channels === 'sms' || channels === 'both') && session.candidatePhone
    ? normalizeToE164(session.candidatePhone)
    : null
  if ((channels === 'sms' || channels === 'both') && !normalizedPhone) {
    return NextResponse.json({ error: 'Candidate has no valid phone on file.' }, { status: 400 })
  }

  const variables: Record<string, string> = {
    candidate_name: session.candidateName || 'there',
    flow_name: session.flow?.name || '',
    candidate_email: session.candidateEmail || '',
    candidate_phone: session.candidatePhone || '',
  }

  // Templates can embed parameterized sub-tokens like
  // {{training_link:<trainingId>}} and {{schedule_link:<configId>}}.
  // Without resolving these, the renderer leaves them empty and the
  // candidate ends up with a broken/404 href. Mirror what the automation
  // engine does in lib/automation.ts so manually-sent templates behave
  // identically to automation-driven ones.
  try {
    const composite = [
      emailSubjectRaw,
      emailHtmlRaw,
      emailTextRaw,
      smsBodyRaw,
    ].join('\n')
    if (/\{\{\s*(schedule_link|training_link):/.test(composite)) {
      const dynamic = await resolveDynamicLinks({
        text: composite,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        sourceRefId: `manual_send:${ws.userId}`,
      })
      Object.assign(variables, dynamic)
    }
  } catch (err) {
    console.error('[send-message] resolveDynamicLinks failed:', err)
  }

  // Persist new templates BEFORE sending so a save failure aborts the
  // send (otherwise the recruiter would think the template was saved
  // when it wasn't). Names are required when saveAsTemplate is set.
  const savedTemplates: { emailTemplateId?: string; smsTemplateId?: string } = {}
  if ((channels === 'email' || channels === 'both') && body.email?.saveAsTemplate) {
    const name = body.email.saveAsTemplate.name?.trim()
    if (!name) {
      return NextResponse.json({ error: 'Template name required to save as new email template.' }, { status: 400 })
    }
    const created = await prisma.emailTemplate.create({
      data: {
        workspaceId: ws.workspaceId,
        createdById: ws.userId,
        name,
        subject: emailSubjectRaw,
        bodyHtml: emailHtmlRaw,
        bodyText: emailTextRaw || null,
      },
    })
    savedTemplates.emailTemplateId = created.id
  }
  if ((channels === 'sms' || channels === 'both') && body.sms?.saveAsTemplate) {
    const name = body.sms.saveAsTemplate.name?.trim()
    if (!name) {
      return NextResponse.json({ error: 'Template name required to save as new SMS template.' }, { status: 400 })
    }
    const created = await prisma.smsTemplate.create({
      data: {
        workspaceId: ws.workspaceId,
        createdById: ws.userId,
        name,
        body: smsBodyRaw,
      },
    })
    savedTemplates.smsTemplateId = created.id
  }

  // Email send.
  let emailResult: { success: boolean; error?: string; messageId?: string } | null = null
  if (channels === 'email' || channels === 'both') {
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

    const subject = renderTemplate(emailSubjectRaw, variables)
    const html = renderTemplate(emailHtmlRaw, variables)
    const text = emailTextRaw ? renderTemplate(emailTextRaw, variables) : stripHtml(html)

    emailResult = await sendEmail({
      to: session.candidateEmail!,
      subject,
      html,
      text,
      from,
      workspaceId: session.workspaceId,
      candidateId: session.id,
      unsubscribeSessionId: session.id,
    })
  }

  // SMS send.
  let smsResult: { success: boolean; error?: string } | null = null
  if (channels === 'sms' || channels === 'both') {
    try {
      await sendSms({
        candidateId: session.id,
        workspaceId: ws.workspaceId,
        to: normalizedPhone!,
        body: renderTemplate(smsBodyRaw, variables),
      })
      smsResult = { success: true }
    } catch (err) {
      smsResult = { success: false, error: err instanceof Error ? err.message : 'SMS send failed' }
    }
  }

  // Surface a hard error only if everything failed; partial success
  // (e.g. email ok, sms failed for "both") still returns 200 with the
  // per-channel detail so the modal can show "Email sent, SMS failed".
  const anyOk = (emailResult?.success ?? false) || (smsResult?.success ?? false)
  if (!anyOk) {
    return NextResponse.json(
      {
        error: emailResult?.error || smsResult?.error || 'Send failed',
        email: emailResult,
        sms: smsResult,
      },
      { status: 502 },
    )
  }

  await prisma.schedulingEvent
    .create({
      data: {
        sessionId: session.id,
        eventType: 'message_sent',
        metadata: {
          channels,
          emailOk: emailResult?.success ?? null,
          smsOk: smsResult?.success ?? null,
          emailSubject: emailResult ? renderTemplate(emailSubjectRaw, variables) : null,
          to: {
            email: emailResult ? session.candidateEmail : null,
            phone: smsResult ? normalizedPhone : null,
          },
          sentBy: ws.userId,
          messageId: emailResult?.messageId || null,
          savedTemplates,
        },
      },
    })
    .catch((err) => console.error('[send-message] failed to log SchedulingEvent:', err))

  return NextResponse.json({
    ok: true,
    email: emailResult,
    sms: smsResult,
    savedTemplates,
  })
}
