import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function POST(_: Request, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const source = await prisma.automationRule.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    include: {
      steps: { orderBy: { order: 'asc' } },
      // Multi-flow scope. Copy it verbatim onto the duplicate so cloning
      // a rule preserves "which flows does this apply to?" — otherwise the
      // duplicate would silently become workspace-wide (empty scope).
      flows: { select: { flowId: true } },
    },
  })
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const copy = await prisma.automationRule.create({
    data: {
      workspaceId: source.workspaceId,
      createdById: ws.userId,
      // Sort the duplicate to land immediately below its source under the
      // list endpoint's createdAt-desc order — without this, the copy would
      // jump to the top of the table on the next refresh (since createdAt
      // defaults to now()), so it visually detached from the row the
      // recruiter cloned it from. 1ms backdate is invisible in the UI's
      // createdAt displays but is enough to stabilize sort order.
      createdAt: new Date(source.createdAt.getTime() - 1),
      name: `${source.name} (copy)`,
      triggerType: source.triggerType,
      // Legacy single-flow column kept in sync with the join table (see
      // POST /api/automations for the same mirror rule).
      flowId: source.flows.length === 1 ? source.flows[0].flowId : null,
      flows:
        source.flows.length > 0
          ? { create: source.flows.map((f) => ({ flowId: f.flowId })) }
          : undefined,
      // Preserve pipeline + stage scope on the copy. Without this, duplicating
      // a rule from a specific pipeline view dropped the copy into
      // "Any-pipeline", making it invisible in the user's current filter and
      // making the duplicate button look broken.
      pipelineId: source.pipelineId,
      stageId: source.stageId,
      triggerAutomationId: source.triggerAutomationId,
      actionType: source.actionType,
      // Legacy per-rule fields are still in sync with step 0 right after the
      // backfill; mirror them on the copy so existing read paths keep working
      // until we drop these columns in a follow-up.
      channel: source.channel,
      emailTemplateId: source.emailTemplateId,
      smsBody: source.smsBody,
      nextStepType: source.nextStepType,
      nextStepUrl: source.nextStepUrl,
      trainingId: source.trainingId,
      schedulingConfigId: source.schedulingConfigId,
      delayMinutes: source.delayMinutes,
      minutesBefore: source.minutesBefore,
      waitForRecording: source.waitForRecording,
      emailDestination: source.emailDestination,
      emailDestinationAddress: source.emailDestinationAddress,
      // Inherit the source's active state. Previously hard-forced to false
      // for "review before enabling" safety, but the recruiter's mental
      // model is that duplicating a rule produces a working copy ready to
      // run — they expect the toggle to match the original.
      isActive: source.isActive,
      steps: {
        create: source.steps.map((s) => ({
          order: s.order,
          delayMinutes: s.delayMinutes,
          timingMode: s.timingMode,
          channel: s.channel,
          emailTemplateId: s.emailTemplateId,
          smsTemplateId: s.smsTemplateId,
          smsBody: s.smsBody,
          emailDestination: s.emailDestination,
          emailDestinationAddress: s.emailDestinationAddress,
          smsDestination: s.smsDestination,
          smsDestinationNumber: s.smsDestinationNumber,
          nextStepType: s.nextStepType,
          nextStepUrl: s.nextStepUrl,
          trainingId: s.trainingId,
          schedulingConfigId: s.schedulingConfigId,
        })),
      },
    },
    // Match the shape the list endpoint returns so the client can splice the
    // new row into local state without a refetch. Without these includes the
    // page crashes trying to read r.steps[0] / r._count.executions on the
    // returned object.
    include: {
      flows: { include: { flow: { select: { id: true, name: true } } } },
      pipeline: { select: { id: true, name: true, isDefault: true } },
      emailTemplate: { select: { id: true, name: true, subject: true } },
      training: { select: { id: true, title: true, slug: true } },
      schedulingConfig: { select: { id: true, name: true, schedulingUrl: true } },
      steps: {
        orderBy: { order: 'asc' },
        include: {
          emailTemplate: { select: { id: true, name: true, subject: true } },
          smsTemplate: { select: { id: true, name: true, body: true } },
          training: { select: { id: true, title: true, slug: true } },
          schedulingConfig: { select: { id: true, name: true, schedulingUrl: true } },
        },
      },
      _count: { select: { executions: true } },
    },
  })

  return NextResponse.json(copy)
}
