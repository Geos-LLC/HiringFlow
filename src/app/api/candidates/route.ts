import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { excludeTestSessions } from '@/lib/session-filters'
import { normalizeStages } from '@/lib/funnel-stages'
import { getOrCreateDefaultPipeline } from '@/lib/pipelines'

export async function GET(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const status = request.nextUrl.searchParams.get('status')
  const flowId = request.nextUrl.searchParams.get('flowId')
  const pipelineId = request.nextUrl.searchParams.get('pipelineId')
  // Filter by Hiring Process — set by the candidates list dropdown and by
  // deep-links from the processes page ("X candidates"). Strict match: only
  // sessions whose processId equals this value (we deliberately don't fall
  // back to processes that *would* match via flowId — analytics need historical
  // attribution, not a "what would this look like today" projection).
  const processId = request.nextUrl.searchParams.get('processId')
  const search = request.nextUrl.searchParams.get('search')
  // `candidateStatus` is the new orthogonal axis (active/stalled/lost/...)
  // Accepts a comma-separated list, e.g. ?candidateStatus=active,waiting for
  // the kanban's default "active pool" view. `status` is the legacy alias
  // that still maps to pipelineStatus (funnel stage id) — left intact so
  // existing query params keep working.
  const candidateStatusParam = request.nextUrl.searchParams.get('candidateStatus')
  // `interesting=1` restricts to recruiter-starred candidates. The flag is
  // independent of status / pipelineStatus — a recruiter can keep an eye on
  // anyone, including rejected ones — so it composes with the other filters.
  const interestingParam = request.nextUrl.searchParams.get('interesting')
  // Source filter — matches the kanban card's display logic
  // (`ad.source || session.source`). When the candidate came through a flow
  // ad, the ad's source wins; otherwise the session's own `source` (set by
  // manual add or by ?source= URL param on flow entry) is used. Comma-list
  // accepted to filter to multiple sources at once.
  const sourceParam = request.nextUrl.searchParams.get('source')
  // Target position — filters sessions to those attributed to ads with a
  // matching Ad.targetPosition. The sentinel value '__unassigned' covers
  // sessions that came through an ad with no position set OR no ad at all
  // (direct/manual entries) so the "Unassigned" group on Campaigns lines up
  // with what the candidates list shows.
  const targetPositionParam = request.nextUrl.searchParams.get('targetPosition')
  // Date range — bounded on `Session.startedAt`. Both params are ISO strings.
  // Parsing failures are ignored so a malformed param can't 500 the kanban.
  const startedAfterParam = request.nextUrl.searchParams.get('startedAfter')
  const startedBeforeParam = request.nextUrl.searchParams.get('startedBefore')

  const where: Record<string, unknown> = { workspaceId: ws.workspaceId }
  const startedAtRange: Record<string, Date> = {}
  if (startedAfterParam) {
    const d = new Date(startedAfterParam)
    if (!Number.isNaN(d.getTime())) startedAtRange.gte = d
  }
  if (startedBeforeParam) {
    const d = new Date(startedBeforeParam)
    if (!Number.isNaN(d.getTime())) startedAtRange.lte = d
  }
  if (Object.keys(startedAtRange).length > 0) {
    where.startedAt = startedAtRange
  }
  // Exclude `source='test'` rows produced by the automation test endpoint
  // from the kanban. They live in the same table as real candidates but are
  // throwaway by design. Pushed into AND so it composes with any source
  // filter the caller passes (a filter on `source='facebook'` would already
  // exclude test rows naturally — this only matters for the default view).
  const andClauses: Record<string, unknown>[] = [excludeTestSessions()]

  if (status && status !== 'all') {
    // The kanban groups candidates via resolveStage(), which is forgiving:
    // a candidate with pipelineStatus=null (or any unrecognized legacy
    // value) lands in the FIRST stage column. A strict
    // `pipelineStatus = <stageId>` filter doesn't match those rows — so
    // selecting the first stage in the dropdown would silently empty a
    // column that's clearly populated on the kanban. Mirror the resolver
    // here: when the requested stage is the first one in the active
    // pipeline, also include null + any pipelineStatus that isn't an
    // explicit current-stage id.
    const stages = await resolveActivePipelineStages({
      workspaceId: ws.workspaceId,
      pipelineId,
      flowId,
    })
    const isFallbackStage = stages.length > 0 && stages[0].id === status
    if (isFallbackStage) {
      const knownStageIds = stages.map((s) => s.id)
      andClauses.push({
        OR: [
          { pipelineStatus: status },
          { pipelineStatus: null },
          { pipelineStatus: { notIn: knownStageIds } },
        ],
      })
    } else {
      where.pipelineStatus = status
    }
  }
  if (candidateStatusParam && candidateStatusParam !== 'all') {
    const values = candidateStatusParam.split(',').map((s) => s.trim()).filter(Boolean)
    if (values.length === 1) where.status = values[0]
    else if (values.length > 1) where.status = { in: values }
  }
  // Filter by pipeline: resolves to "candidates whose flow's pipelineId
  // matches OR flow.pipelineId is null and the requested pipeline is the
  // workspace default". When both flowId and pipelineId are passed, flowId
  // wins (the more specific filter) — the pipeline branch is a no-op so the
  // explicit flow lookup keeps working.
  if (pipelineId && !flowId) {
    const pipeline = await prisma.pipeline.findFirst({
      where: { id: pipelineId, workspaceId: ws.workspaceId },
      select: { id: true, isDefault: true },
    })
    if (!pipeline) {
      // Unknown pipeline → empty list (don't 404 since this is a filter).
      return NextResponse.json([])
    }
    const flowsForPipeline = await prisma.flow.findMany({
      where: pipeline.isDefault
        ? { workspaceId: ws.workspaceId, OR: [{ pipelineId: pipeline.id }, { pipelineId: null }] }
        : { workspaceId: ws.workspaceId, pipelineId: pipeline.id },
      select: { id: true },
    })
    where.flowId = { in: flowsForPipeline.map((f) => f.id) }
  }
  if (flowId) {
    where.flowId = flowId
  }
  if (processId) {
    where.processId = processId
  }
  if (interestingParam === '1' || interestingParam === 'true') {
    where.interestingAt = { not: null }
  }
  if (search) {
    andClauses.push({
      OR: [
        { candidateName: { contains: search, mode: 'insensitive' } },
        { candidateEmail: { contains: search, mode: 'insensitive' } },
        { candidatePhone: { contains: search, mode: 'insensitive' } },
      ],
    })
  }
  if (sourceParam && sourceParam !== 'all') {
    const sources = sourceParam.split(',').map((s) => s.trim()).filter(Boolean)
    if (sources.length > 0) {
      const adMatch = sources.length === 1 ? { source: sources[0] } : { source: { in: sources } }
      const sessionMatch = sources.length === 1 ? { source: sources[0] } : { source: { in: sources } }
      andClauses.push({
        OR: [
          { ad: adMatch },
          { adId: null, ...sessionMatch },
        ],
      })
    }
  }
  if (targetPositionParam) {
    // `__unassigned` covers sessions with no ad attribution OR with an ad
    // whose targetPosition is null — that's how the Campaigns "Unassigned"
    // bucket is defined, and the candidates list should mirror it.
    if (targetPositionParam === '__unassigned') {
      andClauses.push({
        OR: [
          { adId: null },
          { ad: { targetPosition: null } },
        ],
      })
    } else {
      andClauses.push({ ad: { targetPosition: targetPositionParam } })
    }
  }
  if (andClauses.length > 0) {
    where.AND = andClauses
  }

  const now = new Date()
  const sessions = await prisma.session.findMany({
    where: where as any,
    orderBy: { startedAt: 'desc' },
    include: {
      flow: { select: { id: true, name: true, slug: true } },
      ad: { select: { id: true, name: true, source: true } },
      answers: { select: { id: true } },
      submissions: { select: { id: true } },
      trainingEnrollments: {
        select: {
          id: true, status: true, startedAt: true, completedAt: true,
          training: { select: { title: true } },
        },
      },
      schedulingEvents: { select: { id: true, eventType: true, eventAt: true, metadata: true } },
      // Next upcoming InterviewMeeting (Meet v2 path)
      interviewMeetings: {
        where: { scheduledStart: { gt: now } },
        orderBy: { scheduledStart: 'asc' },
        take: 1,
        select: { scheduledStart: true, meetingUri: true },
      },
    },
  })

  // Most recent past automation executions per session — fed into the per-card
  // "latest step" hint below. Loaded as a separate query because the Session
  // ↔ AutomationExecution relation only carries the FK (no back-reference on
  // Session), so we can't include it in the session query above. Capped per
  // session in JS to keep the merge cheap.
  type AEForCard = {
    sessionId: string | null
    status: string
    channel: string
    sentAt: Date | null
    createdAt: Date
    skipReason: string | null
    automationRule: { name: string }
  }
  const sessionIds = sessions.map((s) => s.id)
  const automationExecRows: AEForCard[] = sessionIds.length === 0
    ? []
    : await prisma.automationExecution.findMany({
        where: {
          sessionId: { in: sessionIds },
          // Past-only — the card hint shows what just happened, not what's
          // queued. Future-dated rows (status='queued' with scheduledFor) are
          // intentionally excluded.
          status: { in: ['sent', 'failed', 'cancelled', 'skipped_wrong_status', 'skipped_wrong_stage', 'skipped_missing_prerequisite', 'skipped_duplicate', 'skipped_cancelled', 'skipped_ineligible'] },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          sessionId: true,
          status: true,
          channel: true,
          sentAt: true,
          createdAt: true,
          skipReason: true,
          automationRule: { select: { name: true } },
        },
      })
  const automationExecsBySession = new Map<string, AEForCard[]>()
  for (const ae of automationExecRows) {
    if (!ae.sessionId) continue
    const list = automationExecsBySession.get(ae.sessionId)
    if (list) {
      if (list.length < 10) list.push(ae)
    } else {
      automationExecsBySession.set(ae.sessionId, [ae])
    }
  }

  // Build email → earliest meeting_no_show timestamp map. A later session for
  // the same email is a "rebook" — i.e. the candidate took the no-show
  // follow-up invite and started over.
  const earliestNoShowByEmail = new Map<string, Date>()
  for (const s of sessions) {
    if (!s.candidateEmail) continue
    for (const ev of s.schedulingEvents) {
      if (ev.eventType !== 'meeting_no_show') continue
      const key = s.candidateEmail.toLowerCase().trim()
      const cur = earliestNoShowByEmail.get(key)
      if (!cur || ev.eventAt < cur) earliestNoShowByEmail.set(key, ev.eventAt)
    }
  }
  const computeIsRebook = (s: { candidateEmail: string | null; startedAt: Date }) => {
    if (!s.candidateEmail) return false
    const key = s.candidateEmail.toLowerCase().trim()
    const at = earliestNoShowByEmail.get(key)
    return !!at && s.startedAt > at
  }

  // Dedupe by candidate email: when the same person re-applies (e.g. they
  // clicked a no-show "re-book invite" and went through the flow again), the
  // database has multiple Session rows but the kanban should show only ONE
  // card per person — the most recent one (already first thanks to ordering
  // by startedAt desc). Sessions without an email stay individually since
  // they can't be merged. Older sessions remain queryable directly.
  const seenEmails = new Set<string>()
  const deduped = sessions.filter((s) => {
    if (!s.candidateEmail) return true
    const key = s.candidateEmail.toLowerCase().trim()
    if (seenEmails.has(key)) return false
    seenEmails.add(key)
    return true
  })

  // Latest *past* timeline event for the card hint — mirrors the detail-page
  // timeline (training + scheduling + automation rows) but server-side picks
  // only the single most-recent entry per candidate. Future-dated rows
  // (queued automations, upcoming meetings) are intentionally excluded so
  // the line reflects "what just happened", not "what's pending".
  const SCHED_LABELS: Record<string, string> = {
    invite_sent: 'Scheduling invite sent',
    link_clicked: 'Scheduling link clicked',
    marked_scheduled: 'Marked as scheduled',
    meeting_scheduled: 'Meeting scheduled',
    meeting_rescheduled: 'Meeting rescheduled',
    meeting_cancelled: 'Meeting cancelled',
    meeting_confirmed: 'Candidate confirmed',
    meeting_no_show: 'Candidate no-show',
    nudge_sent: 'Manual nudge sent',
    rejection_email_sent: 'Rejection email sent',
  }
  const computeLatestStep = (s: typeof sessions[number]): { label: string; at: string } | null => {
    const items: { label: string; at: Date }[] = []
    items.push({ label: 'Applied', at: s.startedAt })
    if (s.finishedAt) items.push({ label: `Flow ${s.outcome || 'completed'}`, at: s.finishedAt })
    for (const te of s.trainingEnrollments) {
      const title = te.training?.title || 'training'
      items.push({ label: `Training started: ${title}`, at: te.startedAt })
      if (te.completedAt) items.push({ label: `Training completed: ${title}`, at: te.completedAt })
    }
    for (const ev of s.schedulingEvents) {
      items.push({ label: SCHED_LABELS[ev.eventType] || ev.eventType, at: ev.eventAt })
    }
    for (const ae of automationExecsBySession.get(s.id) || []) {
      const name = ae.automationRule.name
      const chan = ae.channel === 'sms' ? 'SMS' : 'Email'
      if (ae.status === 'sent' && ae.sentAt) {
        items.push({ label: `${chan} sent: ${name}`, at: ae.sentAt })
      } else if (ae.status === 'failed') {
        items.push({ label: `Automation failed: ${name}`, at: ae.createdAt })
      } else if (ae.status === 'cancelled') {
        items.push({ label: `Automation cancelled: ${name}`, at: ae.createdAt })
      } else if (ae.status.startsWith('skipped_')) {
        const reason = (ae.skipReason || ae.status).replace(/^skipped_/, '').replace(/_/g, ' ')
        items.push({ label: `Automation skipped: ${name} (${reason})`, at: ae.createdAt })
      }
    }
    const nowMs = now.getTime()
    let best: { label: string; at: Date } | null = null
    for (const it of items) {
      if (it.at.getTime() > nowMs) continue
      if (!best || it.at.getTime() > best.at.getTime()) best = it
    }
    if (!best) return null
    return { label: best.label, at: best.at.toISOString() }
  }

  // Next upcoming meeting time. Prefer the InterviewMeeting (Meet v2 row) when
  // present; fall back to the latest meeting_scheduled / meeting_rescheduled
  // SchedulingEvent's metadata for legacy / Calendly bookings that didn't go
  // through the Meet v2 adoption path.
  const computeNextMeetingAt = (s: typeof sessions[number]): Date | null => {
    const v2 = s.interviewMeetings[0]?.scheduledStart
    if (v2) return v2
    const evs = s.schedulingEvents
      .filter((e) => e.eventType === 'meeting_scheduled' || e.eventType === 'meeting_rescheduled')
      .map((e) => {
        const meta = e.metadata as Record<string, unknown> | null
        const at = typeof meta?.scheduledAt === 'string' ? new Date(meta.scheduledAt) : null
        return at && !isNaN(at.getTime()) ? at : null
      })
      .filter((d): d is Date => !!d && d.getTime() > now.getTime())
      .sort((a, b) => a.getTime() - b.getTime())
    return evs[0] ?? null
  }

  return NextResponse.json(deduped.map(s => ({
    isRebook: computeIsRebook(s),
    id: s.id,
    candidateName: s.candidateName,
    candidateEmail: s.candidateEmail,
    candidatePhone: s.candidatePhone,
    outcome: s.outcome,
    pipelineStatus: s.pipelineStatus,
    rejectionReason: s.rejectionReason,
    // Status axis fields (added 2026-05-06). Always serialized so the
    // kanban can filter and render the status badge / disposition pill
    // without a separate fetch per card.
    status: s.status,
    dispositionReason: s.dispositionReason,
    stalledAt: s.stalledAt,
    lostAt: s.lostAt,
    hiredAt: s.hiredAt,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    source: s.source,
    addedManually: s.addedManually,
    interestingAt: s.interestingAt,
    flow: s.flow,
    ad: s.ad,
    answerCount: s.answers.length,
    submissionCount: s.submissions.length,
    trainingStatus: s.trainingEnrollments[0]?.status || null,
    trainingCompletedAt: s.trainingEnrollments[0]?.completedAt || null,
    schedulingEvents: s.schedulingEvents.length,
    lastSchedulingEvent: s.schedulingEvents[0]?.eventType || null,
    nextMeetingAt: computeNextMeetingAt(s),
    latestStep: computeLatestStep(s),
  })))
}

// Manually add a candidate without going through a flow. The Session row is
// the candidate's record; flowId is required (Session.flow is non-nullable).
// source='manual' marks the row so analytics can distinguish self-applied
// sessions from ones created by a recruiter.
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const body = await request.json().catch(() => null) as {
    flowId?: string
    candidateName?: string | null
    candidateEmail?: string | null
    candidatePhone?: string | null
    pipelineStatus?: string | null
    source?: string | null
    sourceNote?: string | null
  } | null

  if (!body || typeof body.flowId !== 'string' || !body.flowId) {
    return NextResponse.json({ error: 'flowId is required' }, { status: 400 })
  }

  const flow = await prisma.flow.findFirst({
    where: { id: body.flowId, workspaceId: ws.workspaceId },
    select: { id: true },
  })
  if (!flow) return NextResponse.json({ error: 'Flow not found' }, { status: 404 })

  const trim = (v: unknown) => {
    if (typeof v !== 'string') return null
    const t = v.trim()
    return t.length > 0 ? t : null
  }

  const name = trim(body.candidateName)
  const email = trim(body.candidateEmail)
  const phone = trim(body.candidatePhone)
  const pipelineStatus = trim(body.pipelineStatus)
  // source defaults to 'manual' (recruiter-created); the modal can pass any
  // built-in source id ('indeed', 'facebook', …) or a custom workspace label.
  const source = trim(body.source) ?? 'manual'
  const sourceNote = trim(body.sourceNote)

  if (!name && !email && !phone) {
    return NextResponse.json({ error: 'At least one of name, email, or phone is required' }, { status: 400 })
  }

  const created = await prisma.session.create({
    data: {
      workspaceId: ws.workspaceId,
      flowId: flow.id,
      candidateName: name,
      candidateEmail: email,
      candidatePhone: phone,
      pipelineStatus,
      source,
      // addedManually is independent of `source` — recruiter may pick
      // 'indeed' for analytics but the row was still created by hand.
      addedManually: true,
    },
    select: { id: true },
  })

  // Persist the recruiter's lead-origin comment as a regular CandidateNote
  // (recruiter-only, surfaces in the candidate detail Notes panel). Avoids a
  // separate column for what is essentially free-form context.
  if (sourceNote) {
    const author = await prisma.user.findUnique({
      where: { id: ws.userId },
      select: { name: true, email: true },
    })
    await prisma.candidateNote.create({
      data: {
        sessionId: created.id,
        workspaceId: ws.workspaceId,
        authorId: ws.userId,
        authorName: author?.name || author?.email || null,
        body: `Lead origin: ${sourceNote}`,
      },
    })
  }

  return NextResponse.json({ id: created.id }, { status: 201 })
}

/**
 * Resolve which pipeline's stages are visible in the current view, given the
 * caller's flow / pipeline filter. Mirrors `resolvePipelineForFlow` but kept
 * inline here because GET only needs the stages list, not the full pipeline
 * row. Returns [] if no pipeline is reachable (workspace with no flows etc.).
 */
async function resolveActivePipelineStages(opts: {
  workspaceId: string
  pipelineId: string | null
  flowId: string | null
}) {
  let pipelineRow: { stages: unknown } | null = null
  if (opts.pipelineId && !opts.flowId) {
    pipelineRow = await prisma.pipeline.findFirst({
      where: { id: opts.pipelineId, workspaceId: opts.workspaceId },
      select: { stages: true },
    })
  } else if (opts.flowId) {
    const flow = await prisma.flow.findUnique({
      where: { id: opts.flowId },
      select: { pipelineId: true },
    })
    if (flow?.pipelineId) {
      pipelineRow = await prisma.pipeline.findUnique({
        where: { id: flow.pipelineId },
        select: { stages: true },
      })
    }
  }
  if (!pipelineRow) {
    const def = await getOrCreateDefaultPipeline(opts.workspaceId)
    pipelineRow = { stages: def.stages }
  }
  return normalizeStages(pipelineRow.stages)
}
