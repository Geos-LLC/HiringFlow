/**
 * GET /api/mc-connection/ai-customers
 * PATCH /api/mc-connection/ai-customers  { aiCustomerId: string | null }
 *
 * Thin HF-side proxy over MC's partner endpoints so the browser can
 * populate the AiCustomer picker + persist a selection.
 *
 * Auth: HF workspace session. MC-side auth uses the partner token,
 * scoped by the workspace's connected MC org slug — never leaks either
 * MC creds or the partner token to the browser.
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import {
  listMcAiCustomers,
  setActiveMcAiCustomer,
  McPartnerApiError,
} from '@/lib/mockcustomer/partner-ai-customers'

export const dynamic = 'force-dynamic'

async function resolveConnectedOrgSlug(workspaceId: string): Promise<string | null> {
  const row = await prisma.mcWorkspaceMapping.findUnique({
    where: { workspaceId },
    select: { mcOrganizationSlug: true, canaryEnabled: true },
  })
  if (!row || !row.canaryEnabled) return null
  return row.mcOrganizationSlug
}

function mapErr(err: unknown): NextResponse {
  if (err instanceof McPartnerApiError) {
    const status =
      err.reason === 'not_configured'
        ? 500
        : err.reason === 'timeout'
          ? 504
          : err.reason === 'http_error'
            ? err.status ?? 502
            : 502
    return NextResponse.json(
      { error: 'MockCustomer request failed', reason: `mc_${err.reason}`, detail: err.message },
      { status },
    )
  }
  console.error('[mc-connection/ai-customers] unexpected', err)
  return NextResponse.json({ error: 'Internal error', reason: 'internal' }, { status: 500 })
}

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const slug = await resolveConnectedOrgSlug(ws.workspaceId)
  if (!slug) {
    return NextResponse.json({ error: 'MockCustomer not connected', reason: 'not_connected' }, { status: 409 })
  }
  try {
    const result = await listMcAiCustomers(slug)
    return NextResponse.json(result)
  } catch (err) {
    return mapErr(err)
  }
}

export async function PATCH(request: Request) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const slug = await resolveConnectedOrgSlug(ws.workspaceId)
  if (!slug) {
    return NextResponse.json({ error: 'MockCustomer not connected', reason: 'not_connected' }, { status: 409 })
  }
  let body: { aiCustomerId?: unknown } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const raw = body.aiCustomerId
  const aiCustomerId =
    raw === null || raw === undefined ? null : typeof raw === 'string' ? raw.trim() || null : null
  if (raw !== null && raw !== undefined && aiCustomerId === null) {
    return NextResponse.json(
      { error: 'aiCustomerId must be a non-empty string or null' },
      { status: 400 },
    )
  }
  try {
    const result = await setActiveMcAiCustomer(slug, aiCustomerId)
    return NextResponse.json(result)
  } catch (err) {
    return mapErr(err)
  }
}
