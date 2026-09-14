/**
 * GET /api/mc-connection/calls
 *
 * Thin proxy over MC's GET /v1/partners/organizations/:slug/calls so the
 * browser can render the "attach existing recording" picker.
 * Passes through cursor + limit + onlyWithRecording as query params.
 *
 * Never exposes the partner token to the browser.
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { listMcCalls, McPartnerApiError } from '@/lib/mockcustomer/partner-ai-customers'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const mapping = await prisma.mcWorkspaceMapping.findUnique({
    where: { workspaceId: ws.workspaceId },
    select: { mcOrganizationSlug: true, canaryEnabled: true },
  })
  if (!mapping || !mapping.canaryEnabled) {
    return NextResponse.json(
      { error: 'MockCustomer not connected', reason: 'not_connected' },
      { status: 409 },
    )
  }
  const url = new URL(request.url)
  const cursor = url.searchParams.get('cursor')
  const limitStr = url.searchParams.get('limit')
  const onlyWithRecording = url.searchParams.get('onlyWithRecording') === 'true'
  const limit = limitStr ? Number.parseInt(limitStr, 10) || 25 : 25
  try {
    const result = await listMcCalls(mapping.mcOrganizationSlug, {
      cursor: cursor ?? undefined,
      limit,
      onlyWithRecording,
    })
    return NextResponse.json(result)
  } catch (err) {
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
        { error: 'MockCustomer list-calls failed', reason: `mc_${err.reason}`, detail: err.message },
        { status },
      )
    }
    console.error('[mc-connection/calls] unexpected', err)
    return NextResponse.json({ error: 'Internal error', reason: 'internal' }, { status: 500 })
  }
}
