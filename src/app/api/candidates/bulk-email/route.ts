import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, renderTemplate } from '@/lib/email'

// Bulk email to a manually-picked set of candidates from the candidates
// page. Distinct from the automation engine — this is a one-shot recruiter
// send. Still uses AutomationExecution rows so the existing SendGrid
// Event Webhook stamps delivery status (delivered / bounced / dropped)
// onto each send, and the candidate timeline renders each row as a
// normal automation event with a delivery badge.
//
// We funnel every bulk send through one synthetic AutomationRule per
// workspace (triggerType='manual_bulk', isActive=false) so the automations
// page doesn't fill up with one-off rules. The /api/automations list
// route filters out this trigger type.
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

  // Optional: persist the composed message as a reusable EmailTemplate
  // before the sends fan out.
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

  // Synthetic AutomationRule that owns every bulk-email execution for
  // this workspace. Find-or-create. We name it so the candidate timeline
  // reads "Automation: Recruiter bulk email — email sent" with a delivery
  // badge.
  let bulkRule = await prisma.automationRule.findFirst({
    where: { workspaceId: ws.workspaceId, triggerType: 'manual_bulk' },
    select: { id: true },
  })
  if (!bulkRule) {
    bulkRule = await prisma.automationRule.create({
      data: {
        workspaceId: ws.workspaceId,
        createdById: ws.userId,
        name: 'Recruiter bulk email',
        triggerType: 'manual_bulk',
        actionType: 'send_email',
        channel: 'email',
        isActive: false,
      },
      select: { id: true },
    })
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
      workspace: { select: { timezone: true } },
      // Pull the latest InterviewMeeting per session so {{meeting_date}},
      // {{meeting_clock}}, {{meeting_time}}, {{meeting_link}} fill when the
      // recruiter is following up on candidates who already booked.
      interviewMeetings: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { meetingUri: true, scheduledStart: true },
      },
    },
  })

  let sent = 0
  let failed = 0
  const failures: { id: string; reason: string }[] = []

  for (const s of sessions) {
    if (!s.candidateEmail) {
      failed += 1
      failures.push({ id: s.id, reason: 'no email on file' })
      // Still log a failed execution so the candidate timeline shows the
      // attempt and why it didn't go out.
      await prisma.automationExecution.create({
        data: {
          automationRuleId: bulkRule.id,
          sessionId: s.id,
          status: 'failed',
          channel: 'email',
          provider: 'sendgrid',
          errorMessage: 'No email on file',
          executionMode: 'manual_rerun',
          triggeredByUserId: ws.userId,
        },
      })
      continue
    }

    // Create the row in 'pending' first so we have an id to pass to
    // SendGrid as a customArg — that's how the Event Webhook joins the
    // delivered/bounced event back to this execution.
    const execution = await prisma.automationExecution.create({
      data: {
        automationRuleId: bulkRule.id,
        sessionId: s.id,
        status: 'pending',
        channel: 'email',
        provider: 'sendgrid',
        executionMode: 'manual_rerun',
        triggeredByUserId: ws.userId,
      },
      select: { id: true },
    })

    // Meeting tokens — populated only if this candidate has a meeting on
    // file. Same workspace-tz formatting as the automation engine so a
    // template authored for `meeting_scheduled` automations renders
    // identically when reused via bulk email.
    const tz = s.workspace?.timezone || 'America/New_York'
    const m = s.interviewMeetings[0]
    let mTime = '', mDate = '', mClock = '', mLink = ''
    if (m?.scheduledStart) {
      const d = m.scheduledStart
      mTime = d.toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: tz, timeZoneName: 'short',
      })
      mDate = d.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        timeZone: tz,
      })
      mClock = d.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: tz, timeZoneName: 'short',
      })
    }
    if (m?.meetingUri) mLink = m.meetingUri

    const variables: Record<string, string> = {
      candidate_name: s.candidateName || 'Candidate',
      candidate_email: s.candidateEmail,
      candidate_phone: s.candidatePhone || '',
      flow_name: s.flow?.name || '',
      source: s.source || '',
      ad_name: s.ad?.name || '',
      meeting_time: mTime,
      meeting_date: mDate,
      meeting_clock: mClock,
      meeting_link: mLink,
    }
    const renderedSubject = renderTemplate(subject, variables)
    const renderedHtml = renderTemplate(bodyHtml, variables)
    const renderedText = bodyText ? renderTemplate(bodyText, variables) : undefined

    const res = await sendEmail({
      to: s.candidateEmail,
      subject: renderedSubject,
      html: renderedHtml,
      text: renderedText,
      executionId: execution.id,
      workspaceId: ws.workspaceId,
      candidateId: s.id,
    })

    if (res.success) {
      sent += 1
      await prisma.automationExecution.update({
        where: { id: execution.id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          providerMessageId: res.messageId ?? null,
        },
      })
    } else {
      failed += 1
      failures.push({ id: s.id, reason: res.error || 'unknown' })
      await prisma.automationExecution.update({
        where: { id: execution.id },
        data: { status: 'failed', errorMessage: res.error ?? 'unknown' },
      })
    }
  }

  // Requested ids that didn't resolve to a Session row in this workspace.
  const found = new Set(sessions.map((s) => s.id))
  for (const id of ids) {
    if (!found.has(id)) { failed += 1; failures.push({ id, reason: 'not found' }) }
  }

  return NextResponse.json({ sent, failed, failures, savedTemplateId })
}
