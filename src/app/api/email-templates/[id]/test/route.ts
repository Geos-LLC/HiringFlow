import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, renderTemplate } from '@/lib/email'

// Send a single test email rendering an EmailTemplate so the recruiter
// can confirm formatting in their inbox without first wiring the
// template into an AutomationRule. Independent of the automation
// engine: no AutomationExecution rows, no lifecycle hooks, no test
// Session. Merge tokens get filled with realistic sample values so the
// rendered output mirrors a real send visually.
//
// For sub-tokens like {{schedule_link:<configId>}} and
// {{training_link:<trainingId>}} the route resolves to the workspace
// resource's public URL (no candidate session means we can't mint a
// candidate-bound training token — the test email shows the unsigned
// path so the recruiter sees the button styled and labelled correctly).
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const { to } = await request.json().catch(() => ({ to: null }))
  if (!to || typeof to !== 'string' || !to.includes('@')) {
    return NextResponse.json({ error: 'Valid recipient email required' }, { status: 400 })
  }

  const template = await prisma.emailTemplate.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
  })
  if (!template) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

  const workspace = await prisma.workspace.findUnique({
    where: { id: ws.workspaceId },
    select: {
      timezone: true,
      senderEmail: true, senderName: true,
      senderVerifiedAt: true, senderDomain: true, senderDomainValidatedAt: true,
    },
  })
  const tz = workspace?.timezone || 'America/New_York'
  const appUrl = process.env.APP_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || process.env.NEXTAUTH_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://www.hirefunnel.app')

  // Sample meeting at tomorrow 14:00 local, matching the automation
  // preview/test endpoints so the recruiter sees the same fake values
  // across test surfaces.
  const meetingDateObj = (() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(14, 0, 0, 0)
    return d
  })()
  const sampleMeetingTime = meetingDateObj.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: tz, timeZoneName: 'short',
  })
  const sampleMeetingDate = meetingDateObj.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: tz,
  })
  const sampleMeetingClock = meetingDateObj.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: tz, timeZoneName: 'short',
  })

  const variables: Record<string, string> = {
    candidate_name: 'Alex Sample',
    candidate_email: to,
    candidate_phone: '+1 555-0100',
    flow_name: 'Sample Flow',
    source: 'preview',
    ad_name: 'Sample ad',
    meeting_date: sampleMeetingDate,
    meeting_clock: sampleMeetingClock,
    meeting_time: sampleMeetingTime,
    meeting_link: 'https://meet.google.com/sample-test-link',
    schedule_link: `${appUrl}/book/sample`,
    training_link: `${appUrl}/t/sample?token=PREVIEW`,
    reschedule_link: `${appUrl}/book/sample/reschedule?t=PREVIEW`,
    cancel_link: `${appUrl}/book/sample/cancel?t=PREVIEW`,
  }

  // Sub-tokens: scan subject + bodyHtml + bodyText for
  // {{schedule_link:<id>}} / {{training_link:<id>}} and resolve each to
  // a real workspace URL the recruiter can click in the test email.
  // Training URLs use a literal "PREVIEW" token (won't authenticate),
  // which is fine for visual verification.
  const composite = `${template.subject}\n${template.bodyHtml}\n${template.bodyText ?? ''}`
  const subTokenRe = /\{\{\s*(schedule_link|training_link):([A-Za-z0-9_-]+)\s*\}\}/g
  const scheduleIds = new Set<string>()
  const trainingIds = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = subTokenRe.exec(composite)) !== null) {
    if (m[1] === 'schedule_link') scheduleIds.add(m[2])
    else trainingIds.add(m[2])
  }
  for (const id of Array.from(scheduleIds)) {
    variables[`schedule_link:${id}`] = `${appUrl}/book/${id}`
  }
  if (trainingIds.size > 0) {
    const trainings = await prisma.training.findMany({
      where: { id: { in: Array.from(trainingIds) }, workspaceId: ws.workspaceId },
      select: { id: true, slug: true },
    })
    const slugById = new Map(trainings.map(t => [t.id, t.slug]))
    for (const id of Array.from(trainingIds)) {
      const slug = slugById.get(id) ?? 'sample'
      variables[`training_link:${id}`] = `${appUrl}/t/${slug}?token=PREVIEW`
    }
  }

  const renderedSubject = renderTemplate(template.subject, variables)
  const renderedHtml = renderTemplate(template.bodyHtml, variables)
  const renderedText = template.bodyText ? renderTemplate(template.bodyText, variables) : undefined

  // Use the workspace's branded sender when domain auth or single-sender
  // verification is in place — same gate the automation engine and bulk
  // email use. Without this the test goes out as noreply@hirefunnel.app
  // and is more likely to be spam-filtered.
  let from: { email: string; name?: string } | null = null
  if (workspace?.senderEmail && workspace?.senderName) {
    const domainOk = !!(workspace.senderDomainValidatedAt && workspace.senderDomain && workspace.senderEmail.toLowerCase().endsWith('@' + workspace.senderDomain.toLowerCase()))
    const singleOk = !!workspace.senderVerifiedAt
    if (domainOk || singleOk) {
      from = { email: workspace.senderEmail, name: workspace.senderName }
    }
  }

  const res = await sendEmail({
    to,
    subject: renderedSubject,
    html: renderedHtml,
    text: renderedText,
    from,
    workspaceId: ws.workspaceId,
  })

  if (!res.success) {
    return NextResponse.json({ success: false, error: res.error || 'Send failed' }, { status: 502 })
  }
  return NextResponse.json({ success: true, sentTo: to })
}
