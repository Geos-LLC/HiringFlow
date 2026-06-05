/**
 * POST /api/webhooks/sigcore/sms-inbound
 *
 * Inbound SMS callback from Sigcore. Lets a candidate confirm or cancel an
 * upcoming interview by replying to the before-meeting reminder.
 *
 *   YES / Y / CONFIRM     → mark InterviewMeeting.confirmedAt; send ack;
 *                           email the recruiter
 *   NO / N / CANCEL       → delete the Google Calendar event, log
 *                           meeting_cancelled, stamp Session.rejectionReason
 *                           = 'Canceled', route candidate to Rejected stage,
 *                           cancel any queued before_meeting reminders, send
 *                           ack to candidate, email the recruiter
 *   anything else          → no-op (200 ack so Sigcore doesn't retry)
 *
 * Auth: HMAC-SHA256 of `${X-Callio-Timestamp}.${rawBody}`, hex-encoded, in
 * header `X-Callio-Signature`. Sigcore signs with the `secret` configured on
 * the webhook subscription; HF signs with `SIGCORE_WEBHOOK_KEY`. Constant-time
 * compare; 401 on mismatch. The `X-Callio-Timestamp` header is epoch seconds
 * and is also checked against a ±5 minute skew window to bound replay attacks
 * — outside the window we return 401 `stale_timestamp`. Without the env var
 * set, all webhooks are refused with 503.
 *
 * Contract history: prior to Sigcore commit 12e9bd8f (2026-05-07), the input
 * to HMAC was the raw body alone (no `${ts}.` prefix, no timestamp header).
 * That contract is no longer accepted — the regression test in this folder
 * pins the new contract so a future revert is caught at CI.
 *
 * Payload (Sigcore tenant outbound webhook contract):
 *   {
 *     "event": "message.inbound",
 *     "timestamp": "2026-05-05T...",
 *     "data": {
 *       "messageId": "uuid",
 *       "fromNumber": "+15551234567",   // candidate
 *       "toNumber":   "+19183091938",   // HF profile number
 *       "body":       "yes",
 *       "providerMessageId": "SM...",
 *       ...
 *     }
 *   }
 *
 * Other events are ignored with 200 (delivery callbacks, outbound echoes).
 *
 * Session matching is by phone number across all workspaces. If a phone
 * matches multiple workspaces (rare), we pick the session with the soonest
 * upcoming InterviewMeeting. Worst case the candidate confirms/cancels the
 * wrong one; the recruiter on the affected workspace can revert manually.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { logSchedulingEvent } from '@/lib/scheduling'
import { applyStageTrigger } from '@/lib/funnel-stage-runtime'
import { cancelBeforeMeetingReminders, cancelMeetingDependentFollowups } from '@/lib/automation'
import { deleteCalendarEvent } from '@/lib/google'
import { sendSms, normalizeToE164 } from '@/lib/sms'
import { sendEmail } from '@/lib/email'
import { verifySigcoreSignature, isFreshSigcoreTimestamp } from '@/lib/sigcore-signature'

type Intent = 'confirm' | 'cancel' | 'unknown'

const CONFIRM_KEYWORDS = new Set(['yes', 'y', 'confirm', 'confirmed', 'ok', 'okay'])
// STOP / UNSUBSCRIBE are intentionally NOT here — those are carrier-level
// opt-out keywords that Twilio handles before the message ever reaches
// Sigcore (the candidate gets unsubscribed from this number entirely).
// Treating them as "cancel my meeting" would also surprise candidates who
// replied STOP just because they want to stop receiving SMS.
const CANCEL_KEYWORDS = new Set(['no', 'n', 'cancel', 'cancelled', 'canceled'])

function classifyIntent(body: string): Intent {
  const first = body.trim().toLowerCase().split(/\s+/)[0] || ''
  // Strip trailing punctuation ("yes!", "no.", etc.)
  const word = first.replace(/[^a-z]/g, '')
  if (CONFIRM_KEYWORDS.has(word)) return 'confirm'
  if (CANCEL_KEYWORDS.has(word)) return 'cancel'
  return 'unknown'
}

interface InboundPayload {
  event?: string
  timestamp?: string
  data?: {
    messageId?: string
    fromNumber?: string
    toNumber?: string
    body?: string
    providerMessageId?: string
    direction?: string
  }
}

export async function POST(req: Request) {
  const expected = process.env.SIGCORE_WEBHOOK_KEY?.trim()
  if (!expected) {
    console.error('[sms-inbound] SIGCORE_WEBHOOK_KEY not configured — refusing all webhooks')
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 })
  }

  // Read body once as text so we can both verify the signature against the
  // exact bytes Sigcore signed AND parse it as JSON.
  const rawBody = await req.text()
  const providedSig = req.headers.get('x-callio-signature')?.trim()
  const providedTs = req.headers.get('x-callio-timestamp')?.trim()

  // Skew check first so a stale-timestamp reply is distinguishable from a
  // signature mismatch in the response body. We still 401 on both — the
  // distinct error string is only for observability/diagnosis.
  if (!isFreshSigcoreTimestamp(providedTs, Math.floor(Date.now() / 1000))) {
    return NextResponse.json({ error: 'stale_timestamp' }, { status: 401 })
  }
  if (!providedSig || !verifySigcoreSignature(providedTs as string, rawBody, providedSig, expected)) {
    return NextResponse.json({ error: 'signature_mismatch' }, { status: 401 })
  }

  let payload: InboundPayload
  try {
    payload = JSON.parse(rawBody) as InboundPayload
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // Sigcore fan-outs include outbound echoes and status callbacks. Only
  // act on inbound messages — everything else 200s without effect.
  if (payload.event && payload.event !== 'message.inbound') {
    return NextResponse.json({ ok: true, ignored: 'event_not_inbound', event: payload.event })
  }

  const data = payload.data ?? {}
  const fromRaw = typeof data.fromNumber === 'string' ? data.fromNumber : ''
  const body = typeof data.body === 'string' ? data.body : ''
  const from = normalizeToE164(fromRaw)
  if (!from) {
    console.warn('[sms-inbound] missing/invalid fromNumber:', fromRaw)
    return NextResponse.json({ ok: true, ignored: 'invalid_from' })
  }
  if (!body.trim()) {
    return NextResponse.json({ ok: true, ignored: 'empty_body' })
  }

  const intent = classifyIntent(body)
  if (intent === 'unknown') {
    console.log(`[sms-inbound] unrecognized reply from ${from}: "${body.slice(0, 60)}"`)
    return NextResponse.json({ ok: true, ignored: 'unrecognized_keyword' })
  }

  // Find the candidate's most relevant InterviewMeeting. Prefer an upcoming
  // meeting (scheduledStart > now); fall back to one that started within the
  // last hour (a "yes, on my way" reply right at start-time is still useful).
  const now = new Date()
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)
  const candidates = await prisma.session.findMany({
    where: { candidatePhone: { not: null } },
    select: {
      id: true,
      workspaceId: true,
      candidatePhone: true,
      candidateName: true,
      candidateEmail: true,
      interviewMeetings: {
        where: { scheduledStart: { gte: oneHourAgo } },
        orderBy: { scheduledStart: 'asc' },
        select: {
          id: true, googleCalendarEventId: true, scheduledStart: true,
          confirmedAt: true,
        },
      },
    },
  })

  type Match = {
    sessionId: string
    workspaceId: string
    candidateName: string | null
    candidateEmail: string | null
    meeting: {
      id: string
      googleCalendarEventId: string
      scheduledStart: Date
      confirmedAt: Date | null
    }
  }
  const matches: Match[] = []
  for (const c of candidates) {
    const normalized = c.candidatePhone ? normalizeToE164(c.candidatePhone) : null
    if (normalized !== from) continue
    const meeting = c.interviewMeetings[0]
    if (!meeting) continue
    matches.push({
      sessionId: c.id,
      workspaceId: c.workspaceId,
      candidateName: c.candidateName,
      candidateEmail: c.candidateEmail,
      meeting,
    })
  }
  if (matches.length === 0) {
    console.log(`[sms-inbound] no upcoming/recent meeting for ${from} (intent=${intent})`)
    return NextResponse.json({ ok: true, ignored: 'no_active_meeting' })
  }
  matches.sort((a, b) => a.meeting.scheduledStart.getTime() - b.meeting.scheduledStart.getTime())
  const target = matches[0]

  if (intent === 'confirm') {
    return await handleConfirm(target, from)
  }
  return await handleCancel(target, from)
}

interface Target {
  sessionId: string
  workspaceId: string
  candidateName: string | null
  candidateEmail: string | null
  meeting: {
    id: string
    googleCalendarEventId: string
    scheduledStart: Date
    confirmedAt: Date | null
  }
}

async function handleConfirm(target: Target, from: string) {
  // Idempotent: if already confirmed, just re-ack.
  if (!target.meeting.confirmedAt) {
    await prisma.interviewMeeting.update({
      where: { id: target.meeting.id },
      data: { confirmedAt: new Date() },
    })
    await logSchedulingEvent({
      sessionId: target.sessionId,
      eventType: 'meeting_confirmed',
      metadata: {
        interviewMeetingId: target.meeting.id,
        source: 'candidate_sms',
      },
    }).catch((err) => console.error('[sms-inbound] log meeting_confirmed failed:', err))

    // Optional stage move — only if the workspace wired meeting_confirmed
    // to a custom stage. No legacy fallback (we don't want to bump a
    // confirmed candidate forward by default).
    await applyStageTrigger({
      sessionId: target.sessionId,
      workspaceId: target.workspaceId,
      event: 'meeting_confirmed',
    }).catch((err) => console.error('[sms-inbound] applyStageTrigger(confirmed) failed:', err))

    // Notify the recruiter. Best-effort; failures don't block the ack SMS.
    notifyRecruiter(target, 'confirmed').catch((err) =>
      console.error('[sms-inbound] confirm notification failed:', err))
  }

  await sendAck(target.sessionId, target.workspaceId, from, 'Thanks — your interview is confirmed. See you then!')
    .catch((err) => console.error('[sms-inbound] confirm ack failed:', err))

  return NextResponse.json({ ok: true, action: 'confirmed', meetingId: target.meeting.id })
}

async function handleCancel(target: Target, from: string) {
  // Delete the Google Calendar event so the recruiter's calendar reflects
  // the cancellation. Best-effort — failures here don't block the rest of
  // the cancel flow because the HF-side state is what drives the kanban.
  let calendarDeleted = false
  let calendarError: string | null = null
  try {
    const res = await deleteCalendarEvent(target.workspaceId, target.meeting.googleCalendarEventId)
    calendarDeleted = res.deleted || !!res.alreadyGone
  } catch (err) {
    calendarError = (err as Error).message
    console.error('[sms-inbound] deleteCalendarEvent failed:', calendarError)
  }

  // Log the cancellation in the audit timeline. Idempotency: if a
  // meeting_cancelled event already exists for this meeting (e.g. the
  // calendar watch already saw the deletion before this handler ran), skip
  // the duplicate insert.
  const existing = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId: target.sessionId,
      eventType: 'meeting_cancelled',
      metadata: { path: ['interviewMeetingId'], equals: target.meeting.id },
    },
    select: { id: true },
  })
  if (!existing) {
    await logSchedulingEvent({
      sessionId: target.sessionId,
      eventType: 'meeting_cancelled',
      metadata: {
        interviewMeetingId: target.meeting.id,
        source: 'candidate_sms',
        calendarDeleted,
        calendarError,
      },
    }).catch((err) => console.error('[sms-inbound] log meeting_cancelled failed:', err))
  }

  // Cancel any queued before_meeting reminders so the candidate doesn't
  // get a "your interview is in 1h" SMS after they cancelled.
  await cancelBeforeMeetingReminders(target.sessionId).catch((err) =>
    console.error('[sms-inbound] cancelBeforeMeetingReminders failed:', err))
  // Also nuke queued post-booking follow-ups (meeting_scheduled /
  // meeting_rescheduled rules) — same reasoning as the gcal cancel path.
  await cancelMeetingDependentFollowups(target.sessionId).catch((err) =>
    console.error('[sms-inbound] cancelMeetingDependentFollowups failed:', err))

  // Stamp rejection reason. Always overwrite — the candidate's most recent
  // signal wins, mirroring the no-show auto-stamp behaviour.
  await prisma.session.update({
    where: { id: target.sessionId },
    data: {
      rejectionReason: 'Canceled',
      rejectionReasonAt: new Date(),
    },
  }).catch((err) => console.error('[sms-inbound] stamp rejectionReason failed:', err))

  // Move to Rejected. Like meeting_no_show, this falls back to the legacy
  // 'rejected' status so unconfigured workspaces still land the candidate
  // in the default Rejected column.
  await applyStageTrigger({
    sessionId: target.sessionId,
    workspaceId: target.workspaceId,
    event: 'meeting_cancelled',
    legacyStatus: 'rejected',
  }).catch((err) => console.error('[sms-inbound] applyStageTrigger(cancelled) failed:', err))

  // Notify the recruiter. Best-effort.
  notifyRecruiter(target, 'cancelled', { calendarDeleted }).catch((err) =>
    console.error('[sms-inbound] cancel notification failed:', err))

  await sendAck(target.sessionId, target.workspaceId, from, 'Got it — your interview has been cancelled. Reach out if you change your mind.')
    .catch((err) => console.error('[sms-inbound] cancel ack failed:', err))

  return NextResponse.json({
    ok: true,
    action: 'cancelled',
    meetingId: target.meeting.id,
    calendarDeleted,
  })
}

async function sendAck(sessionId: string, workspaceId: string, to: string, body: string): Promise<void> {
  await sendSms({ candidateId: sessionId, workspaceId, to, body })
}

/**
 * Email the workspace's senderEmail when a candidate confirms or cancels.
 * The kanban already reflects the change visually — this is the recruiter's
 * push-style heads-up so they don't have to be looking at the dashboard.
 *
 * No-op when the workspace has no senderEmail configured (the email-sending
 * flow needs a from-address anyway, so a missing senderEmail means email
 * isn't set up for this workspace yet).
 */
async function notifyRecruiter(
  target: Target,
  action: 'confirmed' | 'cancelled',
  extras?: { calendarDeleted?: boolean },
): Promise<void> {
  const ws = await prisma.workspace.findUnique({
    where: { id: target.workspaceId },
    select: { senderEmail: true, senderName: true, senderDomain: true, senderDomainValidatedAt: true, senderVerifiedAt: true, timezone: true, name: true },
  })
  if (!ws?.senderEmail) {
    console.log(`[sms-inbound] no senderEmail on workspace ${target.workspaceId}, skipping recruiter notification`)
    return
  }

  const tz = ws.timezone || 'America/New_York'
  const meetingTime = target.meeting.scheduledStart.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: tz, timeZoneName: 'short',
  })
  const candidateLabel = target.candidateName
    ? `${target.candidateName}${target.candidateEmail ? ` <${target.candidateEmail}>` : ''}`
    : (target.candidateEmail || 'A candidate')

  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'https://www.hirefunnel.app'
  const candidateLink = `${appUrl}/dashboard/candidates/${target.sessionId}`

  const subject = action === 'confirmed'
    ? `✅ ${target.candidateName || 'Candidate'} confirmed their interview`
    : `❌ ${target.candidateName || 'Candidate'} cancelled their interview`

  const calendarLine = action === 'cancelled'
    ? (extras?.calendarDeleted
        ? '<p>The Google Calendar event has been deleted.</p>'
        : '<p><em>Note: the Google Calendar event could not be deleted automatically — please remove it manually if needed.</em></p>')
    : ''

  const stageLine = action === 'cancelled'
    ? '<p>The candidate has been moved to <strong>Rejected</strong> with reason <strong>Canceled</strong>.</p>'
    : '<p>The interview is marked confirmed on the candidate card.</p>'

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #15171a; max-width: 560px;">
      <p>${candidateLabel} replied via SMS and ${action === 'confirmed' ? '<strong style="color:#16a34a">confirmed</strong>' : '<strong style="color:#dc2626">cancelled</strong>'} the interview scheduled for <strong>${meetingTime}</strong>.</p>
      ${calendarLine}
      ${stageLine}
      <p><a href="${candidateLink}" style="color:#FF9500;text-decoration:none;font-weight:500">Open candidate</a></p>
      <p style="color:#888;font-size:12px;margin-top:24px;">${ws.name} · HireFunnel</p>
    </div>
  `.trim()

  // Match the executeStep email-from selection logic so we only send if the
  // workspace's sender is actually authorized to send mail.
  const domainOk = !!(ws.senderDomainValidatedAt && ws.senderDomain && ws.senderEmail.toLowerCase().endsWith('@' + ws.senderDomain.toLowerCase()))
  const singleOk = !!ws.senderVerifiedAt
  const from = (domainOk || singleOk) && ws.senderName
    ? { email: ws.senderEmail, name: ws.senderName }
    : null

  await sendEmail({
    to: ws.senderEmail,
    subject,
    html,
    text: `${candidateLabel} ${action} the interview at ${meetingTime}. View: ${candidateLink}`,
    from,
  })
}
