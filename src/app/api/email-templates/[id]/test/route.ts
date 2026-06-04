import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, renderTemplate } from '@/lib/email'
import { createAccessToken } from '@/lib/training-access'

// Send a single test email rendering an EmailTemplate so the recruiter
// can confirm formatting in their inbox without first wiring the
// template into an AutomationRule. Independent of the automation
// engine: no AutomationExecution rows, no lifecycle hooks.
//
// Merge tokens get filled with realistic sample values so the rendered
// output mirrors a real send visually AND so the recruiter can click
// through and verify the candidate experience end-to-end.
//
// Training links: mint a real TrainingAccessToken bound to a per-workspace
// preview Session (source='test', automationsHaltedAt set). Clicking the
// link from the test email actually opens the training landing page and
// progresses just like a candidate would see. Without this, the recruiter
// hits "Access unavailable" because the link carried a literal "PREVIEW"
// token that never resolved.
//
// Scheduling links: resolve sub-tokens to real /book/<configId> URLs;
// bare {{schedule_link}} falls back to the workspace's first active
// SchedulingConfig. The /book page is public (no token), so no special
// session is needed.
//
// Reschedule / cancel links: still placeholders. Those require a real
// InterviewMeeting that doesn't exist in test mode; the recruiter sees
// the styled button without a working click-through.
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
    reschedule_link: `${appUrl}/book/sample/reschedule?t=PREVIEW`,
    cancel_link: `${appUrl}/book/sample/cancel?t=PREVIEW`,
    // Filled below.
    schedule_link: `${appUrl}/book/sample`,
    training_link: `${appUrl}/t/sample?token=PREVIEW`,
  }

  // Scan the composite text for which sub-tokens AND bare tokens appear, so
  // we only allocate preview resources for templates that actually use them.
  const composite = `${template.subject}\n${template.bodyHtml}\n${template.bodyText ?? ''}`
  const subTokenRe = /\{\{\s*(schedule_link|training_link):([A-Za-z0-9_-]+)\s*\}\}/g
  const scheduleIds = new Set<string>()
  const trainingIds = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = subTokenRe.exec(composite)) !== null) {
    if (m[1] === 'schedule_link') scheduleIds.add(m[2])
    else trainingIds.add(m[2])
  }
  const hasBareTraining = /\{\{\s*training_link\s*\}\}/.test(composite)
  const hasBareSchedule = /\{\{\s*schedule_link\s*\}\}/.test(composite)
  const needsTrainingPreview = trainingIds.size > 0 || hasBareTraining

  // schedule_link sub-tokens: no token needed, the booking page is public.
  for (const id of Array.from(scheduleIds)) {
    variables[`schedule_link:${id}`] = `${appUrl}/book/${id}`
  }

  // Bare {{schedule_link}}: pick the workspace's first active SchedulingConfig
  // as the fallback so the button leads somewhere real.
  if (hasBareSchedule) {
    const cfg = await prisma.schedulingConfig.findFirst({
      where: { workspaceId: ws.workspaceId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (cfg) variables.schedule_link = `${appUrl}/book/${cfg.id}`
  }

  // Training links need a real TrainingAccessToken so the recruiter can
  // click through. Mint one against a per-workspace preview Session.
  if (needsTrainingPreview) {
    const previewSession = await ensurePreviewSession(ws.workspaceId, to)
    if (previewSession) {
      // Sub-tokens: validate each id belongs to this workspace, then mint a
      // token for that exact training.
      if (trainingIds.size > 0) {
        const trainings = await prisma.training.findMany({
          where: { id: { in: Array.from(trainingIds) }, workspaceId: ws.workspaceId },
          select: { id: true, slug: true },
        })
        for (const t of trainings) {
          const tok = await createAccessToken({ sessionId: previewSession.id, trainingId: t.id })
          variables[`training_link:${t.id}`] = `${appUrl}/t/${t.slug}?token=${tok.token}`
        }
      }

      // Bare {{training_link}}: pick the workspace's first training as the
      // fallback so the button leads somewhere real. Recruiters who want a
      // specific training in a generic template should use {{training_link:<id>}}.
      if (hasBareTraining) {
        const fallback = await prisma.training.findFirst({
          where: { workspaceId: ws.workspaceId },
          orderBy: { createdAt: 'asc' },
          select: { id: true, slug: true },
        })
        if (fallback) {
          const tok = await createAccessToken({ sessionId: previewSession.id, trainingId: fallback.id })
          variables.training_link = `${appUrl}/t/${fallback.slug}?token=${tok.token}`
        }
      }
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

/**
 * Find-or-create a per-workspace "preview" Session that test-send tokens
 * bind to. Source='test' so the automation guard's existing test-session
 * filter (`source='test'`) keeps lifecycle hooks from firing when the
 * recruiter clicks through and creates an enrollment. `automationsHaltedAt`
 * is set as belt-and-suspenders — even paths that don't consult the
 * source filter hit the central kill-switch.
 *
 * Returns null when the workspace has no Flow yet (Session requires a
 * flowId). In that case the caller falls back to the literal PREVIEW
 * placeholder URL — there's no candidate funnel to mint against anyway.
 */
async function ensurePreviewSession(workspaceId: string, recipientEmail: string) {
  const existing = await prisma.session.findFirst({
    where: { workspaceId, source: 'test', candidateName: '__template_preview__' },
  })
  if (existing) return existing

  const flow = await prisma.flow.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (!flow) return null

  return prisma.session.create({
    data: {
      workspaceId,
      flowId: flow.id,
      source: 'test',
      candidateName: '__template_preview__',
      candidateEmail: recipientEmail,
      automationsHaltedAt: new Date(),
      automationsHaltedReason: 'preview:test_send',
    },
  })
}
