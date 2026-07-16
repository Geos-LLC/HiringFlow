import { Prisma } from '@prisma/client'
import { prisma } from './prisma'

/**
 * Resolve the scheduling URL for a given automation rule.
 * Priority: rule's schedulingConfigId > default active config > null
 */
export async function resolveSchedulingUrl(schedulingConfigId: string | null, workspaceId?: string): Promise<{ url: string; configId: string } | null> {
  if (schedulingConfigId) {
    const config = await prisma.schedulingConfig.findUnique({ where: { id: schedulingConfigId } })
    if (config?.isActive) return { url: config.schedulingUrl, configId: config.id }
  }

  if (!workspaceId) return null

  // Fall back to default active config for this workspace
  const defaultConfig = await prisma.schedulingConfig.findFirst({
    where: { isActive: true, isDefault: true, workspaceId },
  })
  if (defaultConfig) return { url: defaultConfig.schedulingUrl, configId: defaultConfig.id }

  // Fall back to any active config in this workspace
  const anyConfig = await prisma.schedulingConfig.findFirst({
    where: { isActive: true, workspaceId },
    orderBy: { createdAt: 'asc' },
  })
  if (anyConfig) return { url: anyConfig.schedulingUrl, configId: anyConfig.id }

  return null
}

/**
 * Build a tracking redirect URL for click tracking.
 */
export function buildScheduleRedirectUrl(sessionId: string, configId: string): string {
  const appUrl = process.env.APP_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || process.env.NEXTAUTH_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000'
  return `${appUrl}/schedule/redirect/${sessionId}/${configId}`
}

/**
 * Log a scheduling event.
 */
export type SchedulingEventType =
  | 'invite_sent'
  | 'link_clicked'
  | 'marked_scheduled'
  | 'meeting_scheduled'
  | 'meeting_rescheduled'
  | 'meeting_cancelled'
  // Candidate replied YES/CONFIRM to a before_meeting SMS reminder. Audit
  // entry; the InterviewMeeting.confirmedAt column is the canonical flag.
  | 'meeting_confirmed'
  // Meet integration v2 lifecycle events — driven by Google Workspace Events.
  | 'meeting_started'
  | 'meeting_ended'
  | 'meeting_no_show'
  | 'recording_ready'
  | 'transcript_ready'
  // Recall.ai bot failed to record (fatal error or recording permission
  // denied by host). Audit only — no lifecycle event fires from this; the
  // Meet native auto-record path remains the fallback.
  | 'recall_bot_failed'

export async function logSchedulingEvent(opts: {
  sessionId: string
  schedulingConfigId?: string | null
  eventType: SchedulingEventType
  metadata?: Record<string, unknown>
}) {
  return prisma.schedulingEvent.create({
    data: {
      sessionId: opts.sessionId,
      schedulingConfigId: opts.schedulingConfigId || null,
      eventType: opts.eventType,
      metadata: opts.metadata ? (opts.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
  })
}

/**
 * Update candidate pipeline status.
 *
 * Routes through the audit helper so every change is recorded — this
 * function is called from in-app scheduler / Calendly adoption / etc., all
 * of which are scheduling-driven moves and tag the source as such.
 *
 * Furthest-wins guard: when the workspace has configured funnel stages,
 * we never regress a candidate from a higher-order stage to a lower one.
 * Without this, an automation step writing the legacy `invited_to_schedule`
 * status would knock a candidate at a custom "Orientation training" stage
 * (which has no `training_completed` trigger to keep them put) back to the
 * "Application" column. Caller can opt out via `{ allowRegression: true }`
 * for cases where the regression is intentional (e.g. a manual recruiter
 * action via the candidate page that explicitly moves the candidate back).
 */
export async function updatePipelineStatus(
  sessionId: string,
  status: string,
  opts?: { source?: string; triggeredBy?: string | null; metadata?: Record<string, unknown>; allowRegression?: boolean },
) {
  // Local imports to avoid pulling pipeline-status' / funnel-stages' prisma
  // bindings into a module-level cycle (scheduling.ts is imported very
  // early during request lifecycle).
  const { setPipelineStatus } = await import('./pipeline-status')
  const { normalizeStages, mapLegacyStatusToStageId } = await import('./funnel-stages')

  if (!opts?.allowRegression) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { pipelineStatus: true, workspaceId: true },
    })
    if (session) {
      // Resolve stages from the SAME source applyStageTrigger uses — the
      // session's pipeline (its flow's pipeline, else the workspace default) —
      // via the pipelines chokepoint, NOT the legacy
      // Workspace.settings.funnelStages. Workspaces migrated to pipelines have
      // an empty funnelStages, so reading it here fell back to the four default
      // stages and mis-ranked every custom stage id (e.g. "stage_8" = "Meeting",
      // real order 3) as order 0 through mapLegacyStatusToStageId's 'new'
      // fallback. That blinded this furthest-wins guard: a duplicate booking
      // write of the legacy 'scheduled' status (order 1) looked like forward
      // progress and clobbered the candidate straight back out of the Meeting
      // stage the meeting_scheduled trigger had just placed them in.
      const { resolvePipelineForSession, stagesFor } = await import('./pipelines')
      const pipeline = await resolvePipelineForSession({
        sessionId,
        workspaceId: session.workspaceId,
      })
      const stages = pipeline ? stagesFor(pipeline) : normalizeStages(undefined)
      const orderOf = (statusValue: string | null): number | null => {
        if (!statusValue) return null
        const direct = stages.find((s) => s.id === statusValue)
        if (direct) return direct.order
        const mapped = mapLegacyStatusToStageId(statusValue)
        const fallback = stages.find((s) => s.id === mapped)
        return fallback ? fallback.order : null
      }
      const currentOrder = orderOf(session.pipelineStatus)
      const targetOrder = orderOf(status)
      if (currentOrder !== null && targetOrder !== null && targetOrder < currentOrder) {
        // Skip silently — the candidate is already further along. Caller's
        // intent (e.g. "send scheduling invite, mark invited") is satisfied
        // implicitly because the candidate is past that point.
        return prisma.session.findUnique({ where: { id: sessionId } })
      }
    }
  }

  await setPipelineStatus({
    sessionId,
    toStatus: status,
    source: opts?.source ?? 'scheduling:update',
    triggeredBy: opts?.triggeredBy ?? null,
    metadata: opts?.metadata,
  })
  return prisma.session.findUnique({ where: { id: sessionId } })
}
