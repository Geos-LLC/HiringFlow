/**
 * Pipeline Transition Rule — update / delete a single rule.
 *
 * Workspace ownership is enforced by joining through the pipeline; we
 * reject if either the pipeline OR the rule isn't owned by the caller's
 * workspace, so the URL `pipelineId` always agrees with the rule's own
 * `pipelineId`.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { normalizeStages, type StageTriggerEvent } from '@/lib/funnel-stages'

const ALLOWED_EVENTS = new Set<StageTriggerEvent>([
  'flow_passed', 'flow_completed',
  'training_started', 'training_completed',
  'meeting_scheduled', 'meeting_rescheduled', 'meeting_confirmed', 'meeting_cancelled',
  'meeting_started', 'meeting_ended', 'meeting_no_show',
  'recording_ready', 'transcript_ready',
  'background_check_passed', 'background_check_failed', 'background_check_needs_review',
])

async function loadRuleOrReject(pipelineId: string, ruleId: string, workspaceId: string) {
  const pipeline = await prisma.pipeline.findFirst({
    where: { id: pipelineId, workspaceId },
    select: { id: true, stages: true },
  })
  if (!pipeline) return { error: NextResponse.json({ error: 'Pipeline not found' }, { status: 404 }) }
  const rule = await prisma.pipelineTransitionRule.findFirst({
    where: { id: ruleId, pipelineId: pipeline.id },
  })
  if (!rule) return { error: NextResponse.json({ error: 'Rule not found' }, { status: 404 }) }
  return { pipeline, rule }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; ruleId: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const loaded = await loadRuleOrReject(params.id, params.ruleId, ws.workspaceId)
  if ('error' in loaded) return loaded.error

  const body = await request.json().catch(() => ({})) as {
    eventType?: string
    fromStageId?: string | null
    targetId?: string | null
    toStageId?: string
    priority?: number
    allowBackward?: boolean
    enabled?: boolean
  }

  const data: Record<string, unknown> = {}
  if (body.eventType !== undefined) {
    if (typeof body.eventType !== 'string' || !ALLOWED_EVENTS.has(body.eventType as StageTriggerEvent)) {
      return NextResponse.json({ error: 'Unknown eventType' }, { status: 400 })
    }
    data.eventType = body.eventType
  }
  const stageIds = new Set(normalizeStages(loaded.pipeline.stages).map((s) => s.id))
  if (body.toStageId !== undefined) {
    if (typeof body.toStageId !== 'string' || !body.toStageId) {
      return NextResponse.json({ error: 'toStageId cannot be empty' }, { status: 400 })
    }
    if (!stageIds.has(body.toStageId)) {
      return NextResponse.json({ error: `toStageId "${body.toStageId}" is not a stage in this pipeline` }, { status: 400 })
    }
    data.toStageId = body.toStageId
  }
  if (body.fromStageId !== undefined) {
    if (body.fromStageId !== null && !stageIds.has(body.fromStageId)) {
      return NextResponse.json({ error: `fromStageId "${body.fromStageId}" is not a stage in this pipeline` }, { status: 400 })
    }
    data.fromStageId = body.fromStageId
  }
  if (body.targetId !== undefined) data.targetId = body.targetId === '' ? null : body.targetId
  if (body.priority !== undefined && Number.isFinite(body.priority)) data.priority = Math.floor(body.priority as number)
  if (typeof body.allowBackward === 'boolean') data.allowBackward = body.allowBackward
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No editable fields supplied' }, { status: 400 })
  }
  const updated = await prisma.pipelineTransitionRule.update({
    where: { id: loaded.rule.id },
    data,
  })
  return NextResponse.json(updated)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; ruleId: string } },
) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const loaded = await loadRuleOrReject(params.id, params.ruleId, ws.workspaceId)
  if ('error' in loaded) return loaded.error

  await prisma.pipelineTransitionRule.delete({ where: { id: loaded.rule.id } })
  return NextResponse.json({ success: true })
}
