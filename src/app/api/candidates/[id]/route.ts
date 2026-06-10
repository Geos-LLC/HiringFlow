import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { logSchedulingEvent } from '@/lib/scheduling'
import { recordPipelineStatusChange } from '@/lib/pipeline-status'
import { resolvePipelineForFlow, stagesFor } from '@/lib/pipelines'
import {
  isAllowedStatus,
  isCandidateStatus,
  isDispositionReason,
  normalizeCustomStatuses,
  statusTransitionPatch,
  type CandidateDispositionReason,
  type CandidateStatus,
} from '@/lib/candidate-status'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    include: {
      flow: {
        select: {
          id: true, name: true, slug: true,
          // Timeouts drive the "Candidate didn't complete X" entries the
          // timeline synthesizes from sent automations. Null → platform
          // default in src/lib/candidate-status.ts.
          videoInterviewTimeoutDays: true,
          trainingTimeoutDays: true,
          noShowTimeoutHours: true,
          schedulingTimeoutHours: true,
          backgroundCheckTimeoutDays: true,
        },
      },
      // Step the candidate is currently sitting on. Drives the "Step X of Y"
      // progress card on the dashboard. Null once the flow is finished.
      lastStep: { select: { id: true, title: true, stepOrder: true, stepType: true, questionType: true } },
      ad: { select: { id: true, name: true, source: true } },
      answers: {
        include: {
          step: { select: { id: true, title: true, questionText: true, stepType: true, questionType: true } },
          option: { select: { id: true, optionText: true } },
        },
        orderBy: { answeredAt: 'asc' },
      },
      submissions: {
        include: {
          step: { select: { id: true, title: true, questionText: true } },
        },
        orderBy: { submittedAt: 'asc' },
      },
      trainingEnrollments: {
        include: {
          training: {
            select: {
              id: true,
              title: true,
              // Section list lets us render "2 of 5 — currently on
              // <name>" and label per-section timeline events. Includes
              // each section's content rows so the card can compute
              // "Lesson 3 of 4" from the candidate's currentLesson ping.
              // We pull only ids here — counting client-side keeps the
              // payload small and avoids a separate aggregate query.
              sections: {
                select: {
                  id: true,
                  title: true,
                  sortOrder: true,
                  kind: true,
                  contents: { select: { id: true, type: true }, orderBy: { sortOrder: 'asc' } },
                },
                orderBy: { sortOrder: 'asc' },
              },
            },
          },
        },
      },
      schedulingEvents: { orderBy: { eventAt: 'desc' } },
      // Hiring Process this candidate was attached to at flow-entry time.
      // Sticky — even if the recruiter later reassigns the flow, processId
      // stays on the historical record so analytics keep their attribution.
      process: {
        select: {
          id: true,
          name: true,
          status: true,
          flow: { select: { id: true, name: true } },
          training: { select: { id: true, title: true } },
          schedulingConfig: { select: { id: true, name: true } },
          pipeline: { select: { id: true, name: true } },
        },
      },
    },
  })

  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Total step count for the flow — used to render the candidate's flow
  // progress as "Step 3 / 8". Counted once and serialized into the response.
  const flowStepCount = session.flow?.id
    ? await prisma.flowStep.count({ where: { flowId: session.flow.id } })
    : 0

  const automationExecutions = await prisma.automationExecution.findMany({
    where: { sessionId: params.id },
    include: {
      automationRule: {
        select: {
          id: true, name: true, triggerType: true,
          chainedBy: { select: { id: true, name: true, steps: { orderBy: { order: 'asc' }, select: { delayMinutes: true } } } },
        },
      },
      step: {
        select: {
          id: true, order: true, channel: true, delayMinutes: true,
          // Read so the timeline's deadline synthesis can skip meeting-
          // relative steps (a "1h before meeting" reminder presupposes a
          // meeting already exists — synthesising "waiting for candidate
          // to book" against those produces false positives).
          timingMode: true,
          nextStepType: true, emailDestination: true, emailDestinationAddress: true,
          training: { select: { title: true, slug: true } },
          schedulingConfig: { select: { name: true, schedulingUrl: true } },
          emailTemplate: { select: { name: true, subject: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  // Resolve form field labels from the flow's form steps so the candidate page
  // can render `Address` instead of `custom_1775512958533`. A flow may have
  // multiple form steps; we merge their fields into one label map keyed by id.
  const formFieldLabels: Record<string, string> = {}
  if (session.flow?.id) {
    const formSteps = await prisma.flowStep.findMany({
      where: { flowId: session.flow.id, formEnabled: true },
      select: { formConfig: true },
    })
    for (const s of formSteps) {
      const cfg = s.formConfig as { fields?: Array<{ id?: string; label?: string }> } | null
      for (const f of cfg?.fields || []) {
        if (f?.id && f?.label) formFieldLabels[f.id] = f.label
      }
    }
  }

  // Pull every other Session for this candidate (matched by email,
  // case-insensitive — the same dedupe key the candidates list uses) so the
  // detail page can surface "this person also has X other application(s)".
  // The previous implementation only computed an `isRebook` boolean here,
  // which meant the UI had no way to link out to the sibling — recruiters
  // could end up looking at a stale older session without realising a
  // current one existed (Stephanie Descofleur, 2026-05-06).
  type SiblingSession = {
    id: string
    startedAt: string
    finishedAt: string | null
    pipelineStatus: string | null
    status: string
    dispositionReason: string | null
    rejectionReason: string | null
    flowName: string | null
    hadNoShow: boolean
  }
  let siblingSessions: SiblingSession[] = []
  let isRebook = false
  if (session.candidateEmail) {
    const siblings = await prisma.session.findMany({
      where: {
        workspaceId: ws.workspaceId,
        candidateEmail: { equals: session.candidateEmail, mode: 'insensitive' },
        id: { not: session.id },
      },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        finishedAt: true,
        pipelineStatus: true,
        status: true,
        dispositionReason: true,
        rejectionReason: true,
        flow: { select: { name: true } },
        schedulingEvents: {
          where: { eventType: 'meeting_no_show' },
          select: { id: true },
          take: 1,
        },
      },
    })
    siblingSessions = siblings.map((s) => ({
      id: s.id,
      startedAt: s.startedAt.toISOString(),
      finishedAt: s.finishedAt?.toISOString() ?? null,
      pipelineStatus: s.pipelineStatus,
      status: s.status,
      dispositionReason: s.dispositionReason,
      rejectionReason: s.rejectionReason,
      flowName: s.flow?.name ?? null,
      hadNoShow: s.schedulingEvents.length > 0,
    }))
    // Same definition as before: a session is a "rebook" iff there is an
    // earlier sibling that had a meeting_no_show.
    isRebook = siblings.some(
      (s) => s.startedAt < session.startedAt && s.schedulingEvents.length > 0,
    )
  }

  // Effective "last activity" — derived from every event timestamp we know
  // about, not just Session.lastActivityAt. The heartbeat field was added
  // mid-flight, so existing candidates whose recent engagement was a meeting
  // or an automation-driven training visit don't have it populated. Computing
  // the max here means recruiters see "Last active 2h ago" the moment those
  // events exist, without needing to backfill the column.
  //
  // Sources:
  //   - Session.lastActivityAt (the new heartbeat)
  //   - Most recent SessionAnswer / CandidateSubmission / SchedulingEvent
  //   - Most recent InterviewMeeting actualStart/actualEnd (the candidate
  //     was actually in the meeting)
  //   - Most recent TrainingEnrollment startedAt/completedAt + currentLesson.at
  //   - Most recent AutomationExecution sentAt (system activity, not
  //     candidate activity, so weighted lower in label only)
  const interviewMeetings = await prisma.interviewMeeting.findMany({
    where: { sessionId: params.id },
    select: { id: true, actualStart: true, actualEnd: true, scheduledStart: true, scheduledEnd: true, meetingUri: true, confirmedAt: true, createdAt: true },
    orderBy: { scheduledStart: 'desc' },
  })

  // Background checks — surfaced so the timeline can detect whether a sent
  // `nextStepType='background_check'` automation produced a completed case.
  const backgroundChecks = await prisma.backgroundCheck.findMany({
    where: { sessionId: params.id },
    select: { id: true, status: true, overallScore: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })

  const candidateActivityCandidates: Array<Date | null | undefined> = [
    session.lastActivityAt,
    session.finishedAt,
    ...session.answers.map((a) => a.answeredAt),
    ...session.submissions.map((s) => s.submittedAt),
    ...session.schedulingEvents.map((e) => e.eventAt),
    ...interviewMeetings.flatMap((m) => [m.actualStart, m.actualEnd]),
    ...session.trainingEnrollments.flatMap((e) => [e.startedAt, e.completedAt]),
    ...session.trainingEnrollments.flatMap((e) => {
      const p = e.progress as { sectionTimestamps?: Record<string, string>; currentLesson?: { at: string } } | null
      const stamps = Object.values(p?.sectionTimestamps || {}).map((s) => new Date(s))
      const cl = p?.currentLesson?.at ? [new Date(p.currentLesson.at)] : []
      return [...stamps, ...cl]
    }),
  ]
  const effectiveLastActivityAt = candidateActivityCandidates
    .filter((d): d is Date => d instanceof Date && !isNaN(d.getTime()))
    .reduce<Date | null>((best, d) => (best == null || d.getTime() > best.getTime() ? d : best), null)

  // Per-training access status for the activity card. 'revoked' iff this
  // candidate has at least one TrainingAccessToken for the training and
  // all of them are in status='revoked'. 'active' iff any token is
  // 'active' or 'used'. 'none' iff no tokens exist (e.g. accessMode='public'
  // training the candidate self-served into). The activity card uses this
  // to swap the "Revoke access" button to a "Restore access" button + show
  // a red "Access revoked" badge.
  const accessTokens = await prisma.trainingAccessToken.findMany({
    where: { candidateId: session.id },
    select: { trainingId: true, status: true },
  })
  const trainingAccessStatus: Record<string, 'active' | 'revoked' | 'none'> = {}
  for (const t of accessTokens) {
    const prev = trainingAccessStatus[t.trainingId]
    const isLive = t.status === 'active' || t.status === 'used'
    if (prev === 'active') continue
    trainingAccessStatus[t.trainingId] = isLive ? 'active' : 'revoked'
  }

  // Resolve which pipeline applies to this candidate. The detail page renders
  // its kanban-style status panel against these stages, not the legacy
  // workspace.settings.funnelStages — so a Dispatcher candidate gets the
  // Dispatcher pipeline's columns even if the recruiter is on a Cleaner
  // pipeline view in the kanban.
  const pipeline = await resolvePipelineForFlow({
    flowId: session.flowId,
    workspaceId: ws.workspaceId,
  })

  return NextResponse.json({
    ...session,
    automationExecutions,
    interviewMeetings,
    backgroundChecks,
    formFieldLabels,
    isRebook,
    siblingSessions,
    flowStepCount,
    pipeline: {
      id: pipeline.id,
      name: pipeline.name,
      isDefault: pipeline.isDefault,
      stages: stagesFor(pipeline),
    },
    trainingAccessStatus,
    effectiveLastActivityAt: effectiveLastActivityAt?.toISOString() ?? null,
  })
}

// Update pipeline status. Accepts the legacy fields (pipelineStatus / outcome
// / rejectionReason) and the new status-axis fields (status / dispositionReason).
//
// Manual lifecycle actions are expressed as a `status` transition:
//   markAsStalled(reason) → PATCH { status: 'stalled', dispositionReason: reason }
//   markAsLost(reason)    → PATCH { status: 'lost',    dispositionReason: reason }
//   markAsNurture(reason) → PATCH { status: 'nurture', dispositionReason: reason? }
//   markAsHired()         → PATCH { status: 'hired' }
//   reactivate()          → PATCH { status: 'active' }
//
// statusTransitionPatch() handles the `*At` stamps and clears `dispositionReason`
// on reactivate, so callers don't need to remember the bookkeeping rules.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = (await request.json()) as {
    pipelineStatus?: string
    outcome?: string
    rejectionReason?: string | null
    status?: string
    dispositionReason?: string | null
    candidateName?: string | null
    candidateEmail?: string | null
    candidatePhone?: string | null
    flowId?: string
    interesting?: boolean
  }
  const {
    pipelineStatus,
    outcome,
    rejectionReason,
    status,
    dispositionReason,
    candidateName,
    candidateEmail,
    candidatePhone,
    flowId,
    interesting,
  } = body

  const data: Record<string, unknown> = {}
  if (pipelineStatus !== undefined) data.pipelineStatus = pipelineStatus
  if (outcome !== undefined) data.outcome = outcome
  if (rejectionReason !== undefined) {
    // Empty string clears the reason; non-empty stamps the timestamp
    const trimmed = typeof rejectionReason === 'string' ? rejectionReason.trim() : null
    data.rejectionReason = trimmed && trimmed.length > 0 ? trimmed : null
    data.rejectionReasonAt = trimmed && trimmed.length > 0 ? new Date() : null
  }

  // Profile edits — name / email / phone are nullable strings; empty string
  // clears them. Trim whitespace on the way in so a stray space doesn't
  // break the dedupe-by-email match used in the candidates list and inbound
  // SMS lookup.
  if (candidateName !== undefined) {
    const trimmed = typeof candidateName === 'string' ? candidateName.trim() : null
    data.candidateName = trimmed && trimmed.length > 0 ? trimmed : null
  }
  if (candidateEmail !== undefined) {
    const trimmed = typeof candidateEmail === 'string' ? candidateEmail.trim() : null
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
    }
    data.candidateEmail = trimmed && trimmed.length > 0 ? trimmed : null
  }
  if (candidatePhone !== undefined) {
    const trimmed = typeof candidatePhone === 'string' ? candidatePhone.trim() : null
    data.candidatePhone = trimmed && trimmed.length > 0 ? trimmed : null
  }
  // Star / un-star — recruiter shortlist toggle. Setting to `true` stamps now,
  // `false` clears. Stored timestamp doubles as the sort key so the dashboard
  // can list "interesting candidates" newest-first.
  if (interesting !== undefined) {
    data.interestingAt = interesting ? new Date() : null
  }
  // Reassign to a different flow. The current `lastStepId` references a step
  // in the old flow, which would dangle once flowId moves — clear it so the
  // progress card resets cleanly. flowStepCount + lastStep are recomputed by
  // GET on the next read.
  if (flowId !== undefined) {
    if (typeof flowId !== 'string' || !flowId) {
      return NextResponse.json({ error: 'flowId is required' }, { status: 400 })
    }
    const flow = await prisma.flow.findFirst({
      where: { id: flowId, workspaceId: ws.workspaceId },
      select: { id: true },
    })
    if (!flow) {
      return NextResponse.json({ error: 'Flow not found' }, { status: 404 })
    }
    if (flow.id !== session.flowId) {
      data.flowId = flow.id
      data.lastStepId = null
    }
  }

  if (status !== undefined) {
    // Built-in statuses go through statusTransitionPatch (which writes the
    // *At stamps). Custom statuses (cust_*) are nurture-like — manual labels
    // with no lifecycle stamp. They write only the status field and clear
    // the lifecycle stamps the same way reactivate does.
    const workspace = await prisma.workspace.findUnique({
      where: { id: ws.workspaceId },
      select: { settings: true },
    })
    const customStatuses = normalizeCustomStatuses((workspace?.settings as { customStatuses?: unknown } | null)?.customStatuses)
    if (!isAllowedStatus(status, customStatuses)) {
      return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 })
    }
    // Validate disposition reason if provided. `null` is allowed to clear.
    let dispArg: CandidateDispositionReason | null | undefined
    if (dispositionReason !== undefined) {
      if (dispositionReason === null || dispositionReason === '') {
        dispArg = null
      } else if (isDispositionReason(dispositionReason)) {
        dispArg = dispositionReason
      } else {
        return NextResponse.json(
          { error: `Invalid dispositionReason: ${dispositionReason}` },
          { status: 400 },
        )
      }
    }
    if (isCandidateStatus(status)) {
      Object.assign(data, statusTransitionPatch(status, { dispositionReason: dispArg }))
    } else {
      // Custom status — treat like a nurture-style transition: clear the
      // terminal stamps so the candidate isn't simultaneously "lost" and
      // "follow-up needed". Disposition reason is preserved if explicitly
      // passed, otherwise cleared.
      data.status = status
      data.stalledAt = null
      data.lostAt = null
      data.hiredAt = null
      if (dispArg !== undefined) data.dispositionReason = dispArg
      else data.dispositionReason = null
    }
  } else if (dispositionReason !== undefined) {
    // dispositionReason can be edited without changing the status
    // (e.g. recruiter recategorising a stalled candidate's reason).
    if (dispositionReason === null || dispositionReason === '') {
      data.dispositionReason = null
    } else if (isDispositionReason(dispositionReason)) {
      data.dispositionReason = dispositionReason
    } else {
      return NextResponse.json(
        { error: `Invalid dispositionReason: ${dispositionReason}` },
        { status: 400 },
      )
    }
  }

  const updated = await prisma.session.update({
    where: { id: params.id },
    data,
  })

  // Audit pipelineStatus changes from the manual PATCH surface (kanban drag,
  // pipeline buttons, outcome flip — all funnel through this endpoint).
  // The original `session` snapshot above holds the pre-update value.
  if (pipelineStatus !== undefined && session.pipelineStatus !== updated.pipelineStatus) {
    await recordPipelineStatusChange({
      sessionId: params.id,
      fromStatus: session.pipelineStatus,
      toStatus: updated.pipelineStatus ?? '',
      source: 'manual:patch',
      triggeredBy: ws.userId,
      metadata: outcome !== undefined ? { outcome } : undefined,
    })
  }

  // Log scheduling event if marking as scheduled
  if (pipelineStatus === 'scheduled') {
    await logSchedulingEvent({
      sessionId: params.id,
      eventType: 'marked_scheduled',
      metadata: { markedBy: ws.userId },
    }).catch(() => {})
  }

  return NextResponse.json({
    id: updated.id,
    pipelineStatus: updated.pipelineStatus,
    outcome: updated.outcome,
    rejectionReason: updated.rejectionReason,
    rejectionReasonAt: updated.rejectionReasonAt,
    status: updated.status,
    dispositionReason: updated.dispositionReason,
    stalledAt: updated.stalledAt,
    lostAt: updated.lostAt,
    hiredAt: updated.hiredAt,
    candidateName: updated.candidateName,
    candidateEmail: updated.candidateEmail,
    candidatePhone: updated.candidatePhone,
    flowId: updated.flowId,
    interestingAt: updated.interestingAt,
  })
}

// Delete a candidate. The candidates list dedupes Session rows by email
// (one card per person), so deleting only the visible row would leave older
// applications by the same person in the DB and they'd reappear after refresh.
// We delete every Session for that email in the workspace. If the row has no
// email we can't identify "same person" — fall back to deleting just that row.
// Cascades handle: SessionAnswer, CandidateSubmission, SchedulingEvent, InterviewMeeting.
// Non-cascading FKs (TrainingEnrollment.sessionId, TrainingAccessToken.candidateId,
// AICall.sessionId) and the FK-less AutomationExecution.sessionId are cleaned up
// explicitly so the delete doesn't fail and we don't leave orphan rows.
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) {
    console.log('[candidate DELETE] 401 no session', { id: params.id })
    return unauthorized()
  }

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true, candidateEmail: true, candidateName: true },
  })
  if (!session) {
    console.log('[candidate DELETE] 404 not in workspace', { id: params.id, workspaceId: ws.workspaceId })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const email = session.candidateEmail?.trim() || null
  const sessionIds: string[] = email
    ? (await prisma.session.findMany({
        where: {
          workspaceId: ws.workspaceId,
          candidateEmail: { equals: email, mode: 'insensitive' },
        },
        select: { id: true },
      })).map((s) => s.id)
    : [session.id]
  console.log('[candidate DELETE] in', { id: params.id, name: session.candidateName, email, sessionIds })

  try {
    await prisma.$transaction([
      prisma.aICall.updateMany({ where: { sessionId: { in: sessionIds } }, data: { sessionId: null } }),
      prisma.trainingEnrollment.deleteMany({ where: { sessionId: { in: sessionIds } } }),
      prisma.trainingAccessToken.deleteMany({ where: { candidateId: { in: sessionIds } } }),
      prisma.automationExecution.deleteMany({ where: { sessionId: { in: sessionIds } } }),
      prisma.session.deleteMany({ where: { id: { in: sessionIds } } }),
    ])
    console.log('[candidate DELETE] done', { deletedCount: sessionIds.length })
    return NextResponse.json({ success: true, deletedCount: sessionIds.length })
  } catch (err: any) {
    // Surface the real error to the client + server log so a missed FK
    // cleanup or constraint hit doesn't disappear into a silent 500 the
    // recruiter has no way to diagnose.
    console.error('[candidate DELETE] failed', {
      id: params.id,
      sessionIds,
      error: err?.message,
      code: err?.code,
      meta: err?.meta,
    })
    return NextResponse.json(
      { error: err?.message || 'Delete failed', code: err?.code },
      { status: 500 },
    )
  }
}
