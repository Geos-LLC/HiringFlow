/**
 * GET /api/hf/home
 *
 * Returns everything the alive Home page needs — Today summary, next
 * interview, needs-attention rows, new applicants, workspace-wide activity —
 * in one round-trip.
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { getHomeData } from '@/lib/hf-core/home-data'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const data = await getHomeData({ workspaceId: ws.workspaceId })
  return NextResponse.json(data)
}
