import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { buildConsentUrl } from '@/lib/google'
import { cookies } from 'next/headers'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  // State token ties callback back to this workspace + prevents CSRF
  const state = randomBytes(16).toString('hex')
  cookies().set(`goog_oauth_${state}`, ws.workspaceId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })

  try {
    const url = buildConsentUrl(state)
    return NextResponse.redirect(url)
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'OAuth not configured' }, { status: 500 })
  }
}
