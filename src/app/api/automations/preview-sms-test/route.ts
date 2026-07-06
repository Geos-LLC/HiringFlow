import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { sendSms, normalizeToE164, SmsConfigError, SmsValidationError, SmsSendError } from '@/lib/sms'

/**
 * Send a rendered preview SMS body to a tester's phone.
 *
 * Unlike /api/automations/[id]/test which spins up a full test Session and
 * runs the automation engine end-to-end, this endpoint just forwards the
 * already-rendered body from the preview modal to Sigcore. The recruiter is
 * looking at the sample-token preview and wants that exact message on their
 * device to sanity-check formatting, length, links, and character encoding.
 *
 * Body: { phone: string, body: string }
 * Returns: { providerMessageId, status }
 */
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const { phone, body } = await request.json().catch(() => ({ phone: null, body: null }))

  if (!phone || typeof phone !== 'string') {
    return NextResponse.json({ error: 'Recipient phone required' }, { status: 400 })
  }
  if (!body || typeof body !== 'string' || body.trim().length === 0) {
    return NextResponse.json({ error: 'SMS body is empty' }, { status: 400 })
  }
  const normalized = normalizeToE164(phone)
  if (!normalized) {
    return NextResponse.json({ error: 'Invalid recipient phone. Use E.164 format (e.g. +15551234567)' }, { status: 400 })
  }

  try {
    const result = await sendSms({
      candidateId: `preview-test-${ws.userId}`,
      workspaceId: ws.workspaceId,
      to: normalized,
      body,
    })
    return NextResponse.json({
      providerMessageId: result.providerMessageId,
      status: result.status,
      sentTo: normalized,
    })
  } catch (err) {
    if (err instanceof SmsConfigError) {
      return NextResponse.json({ error: `SMS not configured: ${err.message}` }, { status: 500 })
    }
    if (err instanceof SmsValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    if (err instanceof SmsSendError) {
      return NextResponse.json({ error: `Send failed: ${err.message}` }, { status: 502 })
    }
    return NextResponse.json({ error: (err as Error).message || 'Send failed' }, { status: 500 })
  }
}
