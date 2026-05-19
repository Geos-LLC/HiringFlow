import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { logSchedulingEvent } from '@/lib/scheduling'
import { issueBookingToken } from '@/lib/scheduling/booking-links'
import { getAppUrl } from '@/lib/google'
import { bookingErrorMessage } from '@/lib/scheduling/error-messages'
import { notifyTenantOfBookingFailure } from '@/lib/google-auth-notifier'

// Email scanners (Gmail link safety, Microsoft Defender Safe Links, Mimecast,
// Proofpoint, etc.) frequently hit this endpoint within milliseconds of
// invite delivery — and again on periodic re-scan passes. Link previewers
// (Slack, Discord, etc.) do the same. Without filtering, every scan shows up
// as a "Scheduling link clicked" event on the candidate timeline, making it
// look like the candidate clicked 5+ times when they may not have clicked at
// all.
const BOT_UA_PATTERN = /(googleimageproxy|microsoft office|mimecast|proofpoint|barracuda|safelinks|urldefense|slack-?linkexpanding|slackbot|bitlybot|skypeuripreview|whatsapp|telegrambot|facebookexternalhit|twitterbot|linkedinbot|discordbot|pinterest|vkshare|urlscan|virustotal|headlesschrome|phantomjs|puppeteer|playwright|crawler|spider|bot\b)/i

export async function POST(request: NextRequest) {
  const { sessionId, configId } = await request.json()

  if (!sessionId || !configId) {
    return NextResponse.json({ error: 'invalid_request', message: bookingErrorMessage('invalid_slot') }, { status: 400 })
  }

  const [config, session] = await Promise.all([
    prisma.schedulingConfig.findUnique({
      where: { id: configId },
      include: { workspace: { select: { senderEmail: true } } },
    }),
    prisma.session.findUnique({
      where: { id: sessionId },
      select: { candidateName: true, candidateEmail: true },
    }),
  ])

  if (!config || !config.isActive) {
    if (config) void notifyTenantOfBookingFailure(config.workspaceId, 'config_not_found')
    return NextResponse.json({
      error: 'config_not_found',
      message: bookingErrorMessage('config_not_found', { contactEmail: config?.workspace.senderEmail }),
    }, { status: 404 })
  }

  // Log the click only when (a) the caller doesn't smell like a known
  // scanner / preview bot, and (b) we haven't already logged one for this
  // session+config in the last 60s. The dedup window catches repeat scanner
  // hits whose UAs we don't yet recognise, plus benign retries (browser
  // back/forward, double-clicked link, React StrictMode re-renders).
  const userAgent = request.headers.get('user-agent') || ''
  if (!BOT_UA_PATTERN.test(userAgent)) {
    const recent = await prisma.schedulingEvent.findFirst({
      where: {
        sessionId,
        schedulingConfigId: configId,
        eventType: 'link_clicked',
        eventAt: { gt: new Date(Date.now() - 60_000) },
      },
      select: { id: true },
    })
    if (!recent) {
      await logSchedulingEvent({
        sessionId,
        schedulingConfigId: configId,
        eventType: 'link_clicked',
      }).catch((err) => console.error('[Schedule] Failed to log click:', err))
    }
  }

  // Built-in scheduler path: issue a signed token and bounce to the in-app
  // booking page. The page re-validates the token server-side before
  // rendering slots.
  if (config.useBuiltInScheduler) {
    const token = issueBookingToken({
      sessionId,
      configId,
      purpose: 'book',
      daysFromNow: 30,
    })
    const redirectUrl = `${getAppUrl()}/book/${configId}?t=${encodeURIComponent(token)}`
    return NextResponse.json({ redirectUrl })
  }

  // External-URL path (Calendly / Cal.com / Google Appointments). All
  // respect name, email, and utm_content for prefill + downstream matching.
  const redirectUrl = buildPrefilledUrl(config.schedulingUrl, {
    name: session?.candidateName || null,
    email: session?.candidateEmail || null,
    sessionId,
  })

  return NextResponse.json({ redirectUrl })
}

function buildPrefilledUrl(base: string, opts: { name: string | null; email: string | null; sessionId: string }): string {
  try {
    const url = new URL(base)
    if (opts.name) url.searchParams.set('name', opts.name)
    if (opts.email) url.searchParams.set('email', opts.email)
    // utm_content is preserved by Calendly and written into booking metadata,
    // giving us a deterministic link back to the candidate when syncing from
    // Google Calendar or webhooks.
    url.searchParams.set('utm_content', opts.sessionId)
    url.searchParams.set('utm_source', 'hirefunnel')
    return url.toString()
  } catch {
    return base
  }
}
