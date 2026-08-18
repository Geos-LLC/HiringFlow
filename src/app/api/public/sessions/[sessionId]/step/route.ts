import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getVideoUrl } from '@/lib/storage'
import { tryParseCaptureConfig } from '@/lib/capture/capture-config'
import { isCaptureStepsEnabledForWorkspace } from '@/lib/capture/capture-feature-flag'
import { createAccessToken, buildTrainingLink } from '@/lib/training-access'
import { issueBookingToken } from '@/lib/scheduling/booking-links'
import { getAppUrl } from '@/lib/google'

export async function GET(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  const session = await prisma.session.findUnique({
    where: { id: params.sessionId },
    include: {
      flow: true,
      // Pull workspace.settings so the response can advertise whether the
      // capture feature is on for this tenant. The candidate UI uses this
      // boolean (rather than the global env flag) to decide whether to
      // render the recorder or the graceful-unavailable notice.
      workspace: { select: { settings: true } },
      lastStep: {
        include: {
          video: true,
          options: {
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  })

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  // Allow access if flow is published OR if this is a preview session (already authenticated at creation)
  // Session creation already validates ownership for unpublished flows

  // Session is finished
  if (session.finishedAt) {
    return NextResponse.json({ finished: true })
  }

  // No current step (shouldn't happen normally)
  if (!session.lastStep) {
    return NextResponse.json({ finished: true })
  }

  const step = session.lastStep

  // Count total steps and get all step IDs for progress navigation.
  // Include options + button targets so we can compute the LONGEST path
  // through the flow (max screens the candidate could see) instead of
  // total step rows — which double-counts forks and combined partners.
  const allSteps = await prisma.flowStep.findMany({
    where: { flowId: session.flowId },
    orderBy: { stepOrder: 'asc' },
    select: {
      id: true,
      stepOrder: true,
      combinedWithId: true,
      buttonConfig: true,
      options: { select: { nextStepId: true } },
    },
  })

  // Progress numbering — unique per step, assigned in BFS visit order from
  // the flow entry. Combined partners share their primary's number (one
  // screen). Forked branches get consecutive numbers. Matches the stage
  // numbering used in the visual flow / builder dropdowns exactly, so
  // clicking slot N in the progress bar navigates to the step actually
  // numbered N on the canvas. stepIds is ordered by this numbering so
  // slot index = step number - 1.
  const combinedPartners = new Set<string>()
  for (const s of allSteps) {
    if (s.combinedWithId) combinedPartners.add(s.combinedWithId)
  }
  const stepById = new Map(allSteps.map((s) => [s.id, s]))
  const stageNumberByStep = new Map<string, number>()
  const sortedByOrder = [...allSteps].sort((a, b) => a.stepOrder - b.stepOrder)
  // Find real flow roots (no incoming from another step's option/button
  // AND not a combined partner). Prefer these over lowest-stepOrder so
  // BFS starts at the actual entry, giving stable stage numbers even if
  // the entry step was added late in DB order.
  const incoming = new Map<string, number>()
  for (const s of allSteps) incoming.set(s.id, 0)
  for (const s of allSteps) {
    for (const o of s.options) {
      if (o.nextStepId && o.nextStepId !== '__end__' && incoming.has(o.nextStepId)) {
        incoming.set(o.nextStepId, (incoming.get(o.nextStepId) ?? 0) + 1)
      }
    }
    const btn = (s.buttonConfig as { nextStepId?: string | null } | null)?.nextStepId
    if (btn && btn !== '__end__' && incoming.has(btn)) {
      incoming.set(btn, (incoming.get(btn) ?? 0) + 1)
    }
  }
  const rootIds = sortedByOrder
    .filter((s) => !combinedPartners.has(s.id) && (incoming.get(s.id) ?? 0) === 0)
    .map((s) => s.id)
  let counter = 1
  const assignShared = (id: string, shareWith: string) => {
    if (stageNumberByStep.has(id)) return
    if (stageNumberByStep.has(shareWith)) {
      stageNumberByStep.set(id, stageNumberByStep.get(shareWith)!)
    }
  }
  const assignNew = (id: string) => {
    if (stageNumberByStep.has(id)) return
    if (combinedPartners.has(id)) return // partners never get their own number
    stageNumberByStep.set(id, counter++)
  }
  const bfsFromRoot = (rootId: string) => {
    if (stageNumberByStep.has(rootId)) return
    assignNew(rootId)
    const bfsQ: string[] = [rootId]
    while (bfsQ.length) {
      const id = bfsQ.shift()!
      const s = stepById.get(id)
      if (!s) continue
      if (s.combinedWithId && stepById.has(s.combinedWithId) && !stageNumberByStep.has(s.combinedWithId)) {
        assignShared(s.combinedWithId, id)
        bfsQ.push(s.combinedWithId)
      }
      const children: string[] = []
      for (const o of s.options) {
        if (o.nextStepId && o.nextStepId !== '__end__' && stepById.has(o.nextStepId) && !stageNumberByStep.has(o.nextStepId)) {
          children.push(o.nextStepId)
        }
      }
      const btn = (s.buttonConfig as { nextStepId?: string | null } | null)?.nextStepId
      if (btn && btn !== '__end__' && stepById.has(btn) && !stageNumberByStep.has(btn)) {
        children.push(btn)
      }
      for (const cid of children) {
        assignNew(cid)
        bfsQ.push(cid)
      }
    }
  }
  if (rootIds.length > 0) {
    for (const rid of rootIds) bfsFromRoot(rid)
  } else if (sortedByOrder[0]) {
    bfsFromRoot(sortedByOrder[0].id)
  }
  // Fallback: any non-partner still unassigned (orphan branch BFS missed).
  for (const s of sortedByOrder) {
    if (combinedPartners.has(s.id)) continue
    if (!stageNumberByStep.has(s.id)) stageNumberByStep.set(s.id, counter++)
  }
  // Assign partners left over (BFS didn't reach their primary) the
  // primary's number so they collapse into the same slot on the bar.
  for (const s of sortedByOrder) {
    if (!combinedPartners.has(s.id)) continue
    if (stageNumberByStep.has(s.id)) continue
    // Find primary by walking backward via "some other step's combinedWithId === s.id"
    let primary = s.id
    let guard = 32
    while (guard-- > 0) {
      const parent = allSteps.find((p) => p.combinedWithId === primary)
      if (!parent) break
      primary = parent.id
    }
    if (stageNumberByStep.has(primary)) {
      stageNumberByStep.set(s.id, stageNumberByStep.get(primary)!)
    }
  }
  // Longest-path progress: total = count of screens on the LONGEST path
  // from a flow root to a terminal. Fork branches (e.g. "NO" answers
  // that dead-end) are OFF this path and don't inflate the total — the
  // candidate can only traverse one path at a time, so showing the count
  // of every possible fork exit was misleading.
  const primaryOf = (sid: string): string => {
    const parent = allSteps.find((s) => s.combinedWithId === sid)
    return parent ? primaryOf(parent.id) : sid
  }
  const longestPathCache = new Map<string, string[]>()
  const inFlight = new Set<string>()
  const longestPathFrom = (startId: string): string[] => {
    if (longestPathCache.has(startId)) return longestPathCache.get(startId)!
    if (inFlight.has(startId)) return []
    inFlight.add(startId)
    const s = stepById.get(startId)
    if (!s) { inFlight.delete(startId); return [] }
    const candidates: string[] = []
    for (const o of s.options) {
      if (o.nextStepId && o.nextStepId !== '__end__' && stepById.has(o.nextStepId)) candidates.push(o.nextStepId)
    }
    const btn = (s.buttonConfig as { nextStepId?: string | null } | null)?.nextStepId
    if (btn && btn !== '__end__' && stepById.has(btn)) candidates.push(btn)
    if (s.combinedWithId && stepById.has(s.combinedWithId)) candidates.push(s.combinedWithId)
    let bestTail: string[] = []
    for (const c of candidates) {
      const t = longestPathFrom(c)
      if (t.length > bestTail.length) bestTail = t
    }
    inFlight.delete(startId)
    // Prepend startId ONLY if it's a non-partner (partners share the
    // primary's slot, so their inclusion would inflate the count).
    const path = combinedPartners.has(startId) ? bestTail : [startId, ...bestTail]
    longestPathCache.set(startId, path)
    return path
  }
  let mainPath: string[] = []
  const rootSearchOrder = rootIds.length > 0 ? rootIds : (sortedByOrder[0] ? [sortedByOrder[0].id] : [])
  for (const rid of rootSearchOrder) {
    const p = longestPathFrom(rid)
    if (p.length > mainPath.length) mainPath = p
  }
  const visibleStepIds = mainPath
  const totalSteps = visibleStepIds.length
  // Current position: if candidate is on the main path (or a partner
  // of one), use its index. Otherwise (on a fork branch off the main
  // path) fall back to the branch parent's index — that keeps the
  // progress bar sensible during a NO/branch detour.
  const mainPathSet = new Set(visibleStepIds)
  const currentPrimaryId = primaryOf(step.id)
  let currentPosition = 1
  if (mainPathSet.has(currentPrimaryId)) {
    currentPosition = visibleStepIds.indexOf(currentPrimaryId) + 1
  } else {
    // Walk backward from the current step through incoming edges until
    // we hit a main-path step; use its position as the current position.
    const backSeen = new Set<string>([currentPrimaryId])
    const queue: string[] = [currentPrimaryId]
    let anchor: string | null = null
    while (queue.length && !anchor) {
      const id = queue.shift()!
      for (const s of allSteps) {
        const btn = (s.buttonConfig as { nextStepId?: string | null } | null)?.nextStepId
        const points = btn === id || s.options.some((o) => o.nextStepId === id) || s.combinedWithId === id
        if (points && !backSeen.has(s.id)) {
          backSeen.add(s.id)
          const primaryS = primaryOf(s.id)
          if (mainPathSet.has(primaryS)) { anchor = primaryS; break }
          queue.push(s.id)
        }
      }
    }
    if (anchor) currentPosition = visibleStepIds.indexOf(anchor) + 1
  }
  currentPosition = Math.min(currentPosition, totalSteps || 1)

  void step.stepOrder

  // Walk the ENTIRE combinedWithId chain (both directions) and pick the
  // best partner to expose as combinedStep. Priority for chains of 3+:
  //   1. First chain member that's a question with options — that's the
  //      one the candidate actually answers.
  //   2. Any chain member with options.length > 0.
  //   3. Any chain member that's a question step (even without options).
  //   4. The direct partner (fallback for legacy 2-chains with no question).
  // Without this walk, a middle member of a 3-chain would return the
  // WRONG partner (typically its forward neighbor), hiding the question
  // options from the candidate.
  let combinedStep: {
    stepId: string; title: string; videoUrl: string | null; videoHlsUrl: string | null;
    videoStatus: string | null; questionText: string | null; stepType: string;
    questionType: string | null; infoContent: string | null; captionsEnabled: boolean;
    segments: unknown[]; formEnabled: boolean; formConfig: unknown;
    options: Array<{ optionId: string; text: string; nextStepId: string | null }>;
  } | null = null
  {
    const chainIds = new Set<string>([step.id])
    // forward walk
    let fwd: string | null | undefined = (step as any).combinedWithId
    while (fwd && !chainIds.has(fwd)) {
      chainIds.add(fwd)
      const nx = await prisma.flowStep.findUnique({ where: { id: fwd }, select: { combinedWithId: true } })
      fwd = nx?.combinedWithId
    }
    // backward walk (repeatedly find any step whose combinedWithId ∈ chain)
    let grew = true
    while (grew) {
      grew = false
      const parents = await prisma.flowStep.findMany({
        where: { flowId: session.flowId, combinedWithId: { in: Array.from(chainIds) } },
        select: { id: true },
      })
      for (const p of parents) {
        if (!chainIds.has(p.id)) { chainIds.add(p.id); grew = true }
      }
    }
    const otherIds = Array.from(chainIds).filter((id) => id !== step.id)
    if (otherIds.length > 0) {
      const members = await prisma.flowStep.findMany({
        where: { id: { in: otherIds } },
        include: { video: true, options: { orderBy: { createdAt: 'asc' } } },
      })
      const shape = (m: (typeof members)[number]) => ({
        stepId: m.id,
        title: m.title,
        videoUrl: m.video ? getVideoUrl(m.video.storageKey) : null,
        videoHlsUrl: m.video?.hlsManifestUrl ?? null,
        videoStatus: m.video?.status ?? null,
        questionText: m.questionText,
        stepType: m.stepType,
        questionType: m.questionType,
        infoContent: (m as any).infoContent || null,
        captionsEnabled: m.captionsEnabled,
        segments: m.captionsEnabled && m.video ? (m.video as any).segments || [] : [],
        formEnabled: m.formEnabled || m.stepType === 'form',
        formConfig: m.formConfig,
        options: m.options.map((o) => ({ optionId: o.id, text: o.optionText, nextStepId: o.nextStepId })),
      })
      // Priority selection
      const questionWithOptions = members.find((m) => m.stepType === 'question' && m.options.length > 0)
      const anyWithOptions = questionWithOptions || members.find((m) => m.options.length > 0)
      const anyQuestion = anyWithOptions || members.find((m) => m.stepType === 'question')
      // Legacy fallback: direct partner (forward), then reverse
      let directPartner: (typeof members)[number] | undefined
      const directFwdId = (step as any).combinedWithId as string | null
      if (directFwdId) directPartner = members.find((m) => m.id === directFwdId)
      if (!directPartner) directPartner = members.find((m) => (m as any).combinedWithId === step.id)
      const chosen = anyQuestion || directPartner || members[0]
      if (chosen) combinedStep = shape(chosen)
    }
  }

  // Parse the capture config through the validator so the client only ever
  // receives a known shape (or null). Anything malformed in DB is treated as
  // "not a capture step" by isCaptureStep and falls through to the legacy
  // behaviour, preserving non-regression on older rows.
  const captureConfig =
    step.stepType === 'capture' ? tryParseCaptureConfig((step as any).captureConfig) : null

  // Chain companions: walk the ENTIRE combinedWithId chain (both
  // directions) and collect every member EXCEPT the current step. The
  // candidate UI uses this to render a "How would you like to answer?"
  // choice on a single card when a text-field question is combined
  // with audio (capture) / video (submission) companions and/or a
  // question-with-video primary. Also finds a chain-wide video so the
  // left panel keeps showing the intro video even when the current
  // lastStep is a text-Q or capture step (no videoUrl of its own).
  let chainVideoUrl: string | null = null
  let chainVideoHlsUrl: string | null = null
  let chainVideoStatus: string | null = null
  const companions: Array<{ stepId: string; stepType: string; questionType?: string | null; questionText?: string | null; captureConfig: unknown; filename?: string | null }> = []
  {
    // First find the chain LEADER by walking backward via
    // "someone.combinedWithId === current".
    let leaderId = step.id
    const backSeen = new Set<string>([step.id])
    while (true) {
      const parent = await prisma.flowStep.findFirst({
        where: { flowId: session.flowId, combinedWithId: leaderId },
        select: { id: true },
      })
      if (!parent || backSeen.has(parent.id)) break
      backSeen.add(parent.id)
      leaderId = parent.id
    }
    // Now walk forward from leader collecting every member.
    const fwdSeen = new Set<string>()
    let cursor: string | null | undefined = leaderId
    while (cursor && !fwdSeen.has(cursor)) {
      fwdSeen.add(cursor)
      const m: { id: string; stepType: string; questionType: string | null; questionText: string | null; captureConfig: unknown; combinedWithId: string | null; video: { storageKey: string; hlsManifestUrl: string | null; status: string | null } | null } | null = await prisma.flowStep.findUnique({
        where: { id: cursor },
        select: { id: true, stepType: true, questionType: true, questionText: true, captureConfig: true, combinedWithId: true, video: { select: { storageKey: true, hlsManifestUrl: true, status: true } } },
      })
      if (!m) break
      if (m.video && !chainVideoUrl) {
        chainVideoUrl = getVideoUrl(m.video.storageKey)
        chainVideoHlsUrl = m.video.hlsManifestUrl ?? null
        chainVideoStatus = m.video.status ?? null
      }
      if (m.id !== step.id) {
        companions.push({
          stepId: m.id,
          stepType: m.stepType,
          questionType: m.questionType,
          questionText: m.questionText,
          captureConfig: m.stepType === 'capture' ? tryParseCaptureConfig((m as any).captureConfig) : null,
          filename: null,
        })
      }
      cursor = m.combinedWithId
    }
  }

  // Composite gate: global env + workspace opt-in. Client renders the
  // recorder only when this is true.
  const captureStepsEnabled = isCaptureStepsEnabledForWorkspace({
    workspaceSettings: session.workspace?.settings,
  })

  // Training step: resolve the linked training, mint (or reuse) a per-
  // candidate access token, and surface completion status so the client
  // can poll for completion + auto-advance.
  let training: {
    id: string
    title: string
    slug: string
    description: string | null
    // Full standalone URL — retained for the eventual "open in a new tab"
    // fallback and for share/log surfaces. The embedded viewer uses
    // { slug, accessToken } instead so it doesn't have to parse the URL.
    url: string
    accessToken: string
    completed: boolean
  } | null = null
  const stepTrainingId = (step as unknown as { trainingId?: string | null }).trainingId ?? null
  if (step.stepType === 'training' && stepTrainingId) {
    const t = await prisma.training.findUnique({
      where: { id: stepTrainingId },
      select: { id: true, title: true, slug: true, description: true },
    })
    if (t) {
      const { token } = await createAccessToken({
        sessionId: session.id,
        trainingId: t.id,
        sourceRefId: step.id,
      })
      const enrollment = await prisma.trainingEnrollment.findFirst({
        where: { sessionId: session.id, trainingId: t.id },
        select: { completedAt: true },
      })
      training = {
        id: t.id,
        title: t.title,
        slug: t.slug,
        description: t.description,
        url: buildTrainingLink(t.slug, token),
        accessToken: token,
        completed: !!enrollment?.completedAt,
      }
    }
  }

  // Scheduling step: resolve the linked config, mint a signed booking
  // token, look up any existing (non-cancelled) meeting, and hand back a
  // single actionUrl the client can just window.open on click. Reschedule
  // is only supported for the built-in scheduler; external providers own
  // reschedule themselves.
  let scheduling: {
    id: string
    name: string
    useBuiltInScheduler: boolean
    actionUrl: string
    existingMeeting: {
      id: string
      scheduledStart: string
      scheduledEnd: string
      meetingUri: string | null
      confirmed: boolean
    } | null
    booked: boolean
  } | null = null
  const stepSchedulingConfigId = (step as unknown as { schedulingConfigId?: string | null }).schedulingConfigId ?? null
  if (step.stepType === 'scheduling' && stepSchedulingConfigId) {
    const config = await prisma.schedulingConfig.findUnique({
      where: { id: stepSchedulingConfigId },
      select: { id: true, name: true, isActive: true, useBuiltInScheduler: true, schedulingUrl: true },
    })
    if (config && config.isActive) {
      const meeting = await prisma.interviewMeeting.findFirst({
        where: {
          sessionId: session.id,
          schedulingConfigId: config.id,
          cancelledAt: null,
        },
        orderBy: { scheduledStart: 'desc' },
        select: { id: true, scheduledStart: true, scheduledEnd: true, meetingUri: true, confirmedAt: true },
      })

      // `next` param is picked up by BookingClient's success state to
      // auto-redirect the candidate back into the flow after they book,
      // instead of stranding them on the /book success screen in a
      // separate tab. `advance=1` on the flow session URL is picked up
      // by the flow player to fire /answer immediately, so the
      // candidate lands on the NEXT step (usually the end screen)
      // without any extra click.
      // Same-origin only — BookingClient validates before redirecting.
      // Skipped for external providers because Calendly/Cal.com don't
      // respect our `next` param.
      const flowReturnPath = session.flow?.slug
        ? `/f/${session.flow.slug}/s/${session.id}?advance=1`
        : null

      // Book URL — signed token for built-in, prefilled external URL
      // otherwise. Same shape /api/public/schedule/redirect produces,
      // but built directly so the client doesn't need an extra roundtrip
      // (which would also log a fake `link_clicked` event every render).
      const buildBookUrl = () => {
        if (config.useBuiltInScheduler) {
          const token = issueBookingToken({
            sessionId: session.id,
            configId: config.id,
            purpose: 'book',
            daysFromNow: 30,
          })
          const nextQs = flowReturnPath ? `&next=${encodeURIComponent(flowReturnPath)}` : ''
          return `${getAppUrl()}/book/${config.id}?t=${encodeURIComponent(token)}${nextQs}`
        }
        // External provider — prefill name/email + tag utm_content with
        // sessionId so webhooks / Calendar sync can attribute the booking.
        try {
          const url = new URL(config.schedulingUrl)
          if (session.candidateName) url.searchParams.set('name', session.candidateName)
          if (session.candidateEmail) url.searchParams.set('email', session.candidateEmail)
          url.searchParams.set('utm_content', session.id)
          url.searchParams.set('utm_source', 'hirefunnel')
          return url.toString()
        } catch {
          return config.schedulingUrl
        }
      }

      let actionUrl: string
      if (meeting && config.useBuiltInScheduler) {
        const token = issueBookingToken({
          sessionId: session.id,
          configId: config.id,
          purpose: 'reschedule',
          daysFromNow: 30,
        })
        const nextQs = flowReturnPath ? `&next=${encodeURIComponent(flowReturnPath)}` : ''
        actionUrl = `${getAppUrl()}/book/${config.id}/reschedule?t=${encodeURIComponent(token)}${nextQs}`
      } else {
        actionUrl = buildBookUrl()
      }

      scheduling = {
        id: config.id,
        name: config.name,
        useBuiltInScheduler: config.useBuiltInScheduler,
        actionUrl,
        existingMeeting: meeting
          ? {
              id: meeting.id,
              scheduledStart: meeting.scheduledStart.toISOString(),
              scheduledEnd: meeting.scheduledEnd.toISOString(),
              meetingUri: meeting.meetingUri,
              confirmed: !!meeting.confirmedAt,
            }
          : null,
        booked: !!meeting,
      }
    }
  }

  return NextResponse.json({
    stepId: step.id,
    title: step.title,
    videoUrl: step.video ? getVideoUrl(step.video.storageKey) : null,
    // HLS manifest + status: the candidate-side <CaptionedVideo /> only
    // considers a video playable when hlsUrl is present (or when the
    // status is 'ready' with a cached local blob). Previously we sent
    // only videoUrl (the raw origin file), which made CaptionedVideo
    // treat every step-video as "still processing" and never render the
    // player. Sending hlsUrl + status lets it pick HLS when available
    // and show a real processing / failed state otherwise.
    videoHlsUrl: step.video?.hlsManifestUrl ?? null,
    videoStatus: step.video?.status ?? null,
    questionText: step.questionText,
    stepType: step.stepType,
    questionType: step.questionType,
    infoContent: (step as Record<string, unknown>).infoContent || null,
    captionsEnabled: step.captionsEnabled,
    captionStyle: step.captionStyle,
    segments: step.captionsEnabled && step.video ? (step.video as any).segments || [] : [],
    formEnabled: step.formEnabled || step.stepType === 'form',
    formConfig: step.formConfig,
    captureConfig,
    captureStepsEnabled,
    training,
    scheduling,
    progress: {
      current: Math.min(currentPosition, totalSteps || currentPosition),
      total: totalSteps,
    },
    stepIds: visibleStepIds,
    combinedStep,
    companions,
    chainVideoUrl,
    chainVideoHlsUrl,
    chainVideoStatus,
    options: step.options.map((o) => ({
      optionId: o.id,
      text: o.optionText,
      nextStepId: o.nextStepId,
    })),
  })
}
