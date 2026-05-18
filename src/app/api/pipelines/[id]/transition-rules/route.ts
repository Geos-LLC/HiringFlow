/**
 * Pipeline Transition Rules — list + create.
 *
 * Sibling to /api/pipelines/[id] but kept separate because rules live in a
 * dedicated table (not in the Pipeline.stages JSON) and have their own CRUD
 * lifecycle. Every endpoint enforces workspace ownership of the pipeline
 * before touching rules so a recruiter from another workspace cannot edit
 * rules by guessing pipeline / rule ids.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { normalizeStages, type StageTriggerEvent } from '@/lib/funnel-stages'

// Mirror of the StageTriggerEvent union — kept here as a runtime allowlist
// because TS unions don't carry into runtime, and we need to reject unknown
// event names at the API boundary rather than persisting garbage.
const ALLOWED_EVENTS = new Set<StageTriggerEvent>([
  'flow_passed', 'flow_completed',
  'training_started', 'training_completed',
  'meeting_scheduled', 'meeting_rescheduled', 'meeting_confirmed', 'meeting_cancelled',
  'meeting_started', 'meeting_ended', 'meeting_no_show',
  'recording_ready', 'transcript_ready',
  'background_check_passed', 'background_check_failed', 'background_check_needs_review',
])

async function loadPipelineOrReject(pipelineId: string, workspaceId: string) {
  const pipeline = await prisma.pipeline.findFirst({
    where: { id: pipelineId, workspaceId },
    select: { id: true, workspaceId: true, stages: true },
  })
  return pipeline
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const pipeline = await loadPipelineOrReject(params.id, ws.workspaceId)
  if (!pipeline) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })

  const rules = await prisma.pipelineTransitionRule.findMany({
    where: { pipelineId: pipeline.id },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  })
  return NextResponse.json(rules)
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()
  const pipeline = await loadPipelineOrReject(params.id, ws.workspaceId)
  if (!pipeline) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })

  const body = await request.json().catch(() => ({})) as {
    eventType?: string
    fromStageId?: string | null
    targetId?: string | null
    toStageId?: string
    priority?: number
    allowBackward?: boolean
    enabled?: boolean
  }

  if (typeof body.eventType !== 'string' || !ALLOWED_EVENTS.has(body.eventType as StageTriggerEvent)) {
    return NextResponse.json({ error: 'Unknown or missing eventType' }, { status: 400 })
  }
  if (typeof body.toStageId !== 'string' || !body.toStageId) {
    return NextResponse.json({ error: 'toStageId is required' }, { status: 400 })
  }

  // Validate stage ids belong to this pipeline so we don't accept rules that
  // can never fire (typoed stage id, copy-pasted from another pipeline).
  const stageIds = new Set(normalizeStages(pipeline.stages).map((s) => s.id))
  if (!stageIds.has(body.toStageId)) {
    return NextResponse.json({ error: `toStageId "${body.toStageId}" is not a stage in this pipeline` }, { status: 400 })
  }
  if (body.fromStageId && !stageIds.has(body.fromStageId)) {
    return NextResponse.json({ error: `fromStageId "${body.fromStageId}" is not a stage in this pipeline` }, { status: 400 })
  }

  const rule = await prisma.pipelineTransitionRule.create({
    data: {
      workspaceId: pipeline.workspaceId,
      pipelineId: pipeline.id,
      eventType: body.eventType,
      fromStageId: body.fromStageId ?? null,
      targetId: body.targetId ?? null,
      toStageId: body.toStageId,
      priority: Number.isFinite(body.priority) ? Math.floor(body.priority as number) : 0,
      allowBackward: body.allowBackward === true,
      enabled: body.enabled !== false,
    },
  })
  return NextResponse.json(rule, { status: 201 })
}
