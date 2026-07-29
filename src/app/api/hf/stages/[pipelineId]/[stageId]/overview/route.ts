/**
 * GET /api/hf/stages/:pipelineId/:stageId/overview
 *
 * Returns everything a Stage detail page needs — candidates in stage,
 * today's interviews, booking pages, reminder rules, recent activity,
 * health, and primary action — in one round-trip.
 *
 * The route is workspace-scoped; unauthenticated returns 401, unknown
 * stage/pipeline returns 404.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { getStageOverview } from '@/lib/hf-core/stage-overview'

export async function GET(
  _req: NextRequest,
  { params }: { params: { pipelineId: string; stageId: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const overview = await getStageOverview({
    workspaceId: ws.workspaceId,
    pipelineId: params.pipelineId,
    stageId: params.stageId,
  })

  if (!overview) {
    return NextResponse.json({ error: 'Stage not found' }, { status: 404 })
  }

  return NextResponse.json(overview)
}
