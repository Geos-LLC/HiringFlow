/**
 * Public unsubscribe endpoint for the List-Unsubscribe header.
 *
 *   GET  /u/[token]  → renders a confirmation page (candidate clicked the
 *                       link in their email client). Already idempotent.
 *   POST /u/[token]  → RFC 8058 one-click endpoint that mailbox providers
 *                       (Apple Mail, Gmail) call automatically when the
 *                       user clicks "Unsubscribe" in the mail UI. Mail
 *                       providers expect a 2xx response and no redirect.
 *
 * Effect: stamps Session.automationsHaltedAt + automationsHaltedReason =
 * 'unsubscribed'. The automation guard at src/lib/automation-guard.ts
 * already short-circuits any further sends for sessions with a non-null
 * automationsHaltedAt — so this reuses the existing kill switch and adds
 * no new code paths to the engine.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifyUnsubscribeToken } from '@/lib/unsubscribe'

export const dynamic = 'force-dynamic'

async function unsubscribeSession(sessionId: string): Promise<{ ok: boolean; alreadyUnsubscribed: boolean }> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, automationsHaltedAt: true, automationsHaltedReason: true },
  })
  if (!session) return { ok: false, alreadyUnsubscribed: false }
  if (session.automationsHaltedAt && session.automationsHaltedReason === 'unsubscribed') {
    return { ok: true, alreadyUnsubscribed: true }
  }
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      automationsHaltedAt: session.automationsHaltedAt ?? new Date(),
      automationsHaltedReason: 'unsubscribed',
    },
  })
  return { ok: true, alreadyUnsubscribed: false }
}

function renderHtml(message: string, sub?: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Be Vietnam Pro", sans-serif; background:#F7F7F8; margin:0; padding:48px 16px; color:#262626; }
  .card { max-width: 480px; margin: 0 auto; background:#FCFCFD; border:1px solid #E4E4E7; border-radius:12px; padding:32px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p  { font-size: 15px; line-height: 1.5; margin: 0; color:#59595A; }
</style>
</head><body>
  <div class="card">
    <h1>${message}</h1>
    ${sub ? `<p>${sub}</p>` : ''}
  </div>
</body></html>`
}

export async function POST(_req: NextRequest, { params }: { params: { token: string } }) {
  const verify = verifyUnsubscribeToken(params.token)
  if (!verify.ok) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
  }
  const result = await unsubscribeSession(verify.sessionId)
  if (!result.ok) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // RFC 8058 expects a 2xx with no redirect for one-click POSTs.
  return NextResponse.json({ ok: true, alreadyUnsubscribed: result.alreadyUnsubscribed })
}

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const verify = verifyUnsubscribeToken(params.token)
  if (!verify.ok) {
    return new NextResponse(renderHtml('Invalid unsubscribe link', 'This link could not be verified. It may have been mistyped.'), {
      status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
  const result = await unsubscribeSession(verify.sessionId)
  if (!result.ok) {
    return new NextResponse(renderHtml('We could not find that subscription', 'Your record may have been removed already.'), {
      status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
  const message = result.alreadyUnsubscribed ? 'You were already unsubscribed' : 'You have been unsubscribed'
  return new NextResponse(renderHtml(message, "You will no longer receive automated emails about this application. If this was a mistake, reply directly to the recruiter to be reactivated."), {
    status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
