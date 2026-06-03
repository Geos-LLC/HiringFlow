import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { completeEnrollment } from '@/lib/training-access'
import { fireTrainingStartedAutomations } from '@/lib/automation'
import { emitAutomationEvent, eventKeys } from '@/lib/automation-emit'
import { bumpSessionProgress } from '@/lib/session-activity'

// Progress JSON shape stored on TrainingEnrollment.progress.
//   `sectionTimestamps`: sectionId → ISO completion time, so the recruiter
//      timeline can render real per-section events instead of inheriting
//      the enrollment.startedAt.
//   `currentLesson`: where the candidate is right now (mid-section). Pinged
//      by the training viewer on every lesson navigation; lets the recruiter
//      see "Section 2: Safety · Lesson 3" before the section is finished.
//      Without this, a candidate who watches videos but never finishes a
//      section looks like they haven't started.
// All optional — older enrollments lack these fields and readers must
// tolerate their absence.
type EnrollmentProgress = {
  completedSections: string[]
  quizScores: { sectionId: string; score: number }[]
  sectionTimestamps?: Record<string, string>
  currentLesson?: { sectionId: string; lessonIdx: number; at: string }
}

/**
 * PATCH — Update training progress (section completion, status changes)
 * POST  — Mark training as completed
 */
export async function PATCH(request: NextRequest) {
  const { enrollmentId, accessToken, completedSections, currentLesson } = await request.json()

  if (!enrollmentId) {
    return NextResponse.json({ error: 'enrollmentId required' }, { status: 400 })
  }

  // Read-modify-write the progress JSON inside a transaction with a
  // Postgres advisory lock keyed by the enrollment id. Without this, two
  // PATCHes for the same enrollment racing each other can both read a
  // stale `progress` and the second write clobbers the first — which is
  // how Daphney Laloy's two section timestamps ended up identical to the
  // millisecond. The advisory lock serializes concurrent PATCHes per
  // enrollment without blocking PATCHes against other rows.
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${enrollmentId}::text, 0))`

    const enrollment = await tx.trainingEnrollment.findUnique({
      where: { id: enrollmentId },
      include: { accessToken: true },
    })
    if (!enrollment) return { notFound: true as const }

    // Token gate — see POST handler for the rationale. PATCH also accepts
    // arbitrary `completedSections` from the client (line 62 below replaces
    // the array wholesale), so an unauthenticated PATCH can either advance
    // a candidate's progress OR clobber it back to an earlier state. Same
    // signed-token check protects both directions.
    if (enrollment.accessTokenId) {
      if (typeof accessToken !== 'string' || !accessToken) {
        return { unauthorized: true as const }
      }
      if (!enrollment.accessToken || enrollment.accessToken.token !== accessToken) {
        return { unauthorized: true as const }
      }
    }

    const progress: EnrollmentProgress = (enrollment.progress as EnrollmentProgress) || { completedSections: [], quizScores: [] }

    if (completedSections) {
      // Stamp a timestamp the first time each section appears as complete so
      // the timeline can render real per-section events. Existing entries are
      // preserved.
      const previous = new Set(progress.completedSections)
      const stamps = { ...(progress.sectionTimestamps || {}) }
      const now = new Date().toISOString()
      for (const sid of completedSections) {
        if (!previous.has(sid) && !stamps[sid]) stamps[sid] = now
      }
      progress.completedSections = completedSections
      progress.sectionTimestamps = stamps
    }

    // Lightweight position ping: validate shape and stamp received-at so
    // the recruiter card can show "Lesson 3 of section X" with a freshness
    // signal. Lesson-navigation pings double as activity heartbeats — the
    // bumpSessionActivity below catches them whether or not they include
    // a `completedSections` change.
    if (currentLesson && typeof currentLesson === 'object'
        && typeof currentLesson.sectionId === 'string'
        && Number.isInteger(currentLesson.lessonIdx) && currentLesson.lessonIdx >= 0) {
      progress.currentLesson = {
        sectionId: currentLesson.sectionId,
        lessonIdx: currentLesson.lessonIdx,
        at: new Date().toISOString(),
      }
    }

    // Once an enrollment is completed, navigating back to a section or
    // re-PATCHing progress shouldn't downgrade status from 'completed' to
    // 'in_progress' — that masked the real state and caused the funnel
    // backfill to misclassify already-graduated candidates.
    const isCompleted = enrollment.status === 'completed' || enrollment.completedAt !== null

    const updated = await tx.trainingEnrollment.update({
      where: { id: enrollmentId },
      data: {
        status: isCompleted ? 'completed' : 'in_progress',
        progress,
      },
    })

    return {
      notFound: false as const,
      unauthorized: false as const,
      sessionId: enrollment.sessionId,
      trainingId: enrollment.trainingId,
      isCompleted,
      progress: updated.progress,
      status: updated.status,
    }
  })

  if ('notFound' in result && result.notFound) {
    return NextResponse.json({ error: 'Enrollment not found' }, { status: 404 })
  }
  if ('unauthorized' in result && result.unauthorized) {
    return NextResponse.json({ error: 'invalid accessToken' }, { status: 401 })
  }

  // Route through the funnel-stage trigger only on initial progression so
  // we don't re-fire training_started for every section navigation post-
  // completion. Outside the transaction since it touches other rows.
  // Keyed by enrollmentId so subsequent section pings are deduped — first
  // section ping wins, the rest no-op without needing the !isCompleted
  // check (kept for cheap early-out).
  if (result.sessionId && !result.isCompleted) {
    const session = await prisma.session.findUnique({
      where: { id: result.sessionId },
      select: { workspaceId: true },
    })
    if (session) {
      await emitAutomationEvent({
        workspaceId: session.workspaceId,
        sessionId: result.sessionId,
        triggerType: 'training_started',
        eventKey: eventKeys.trainingStarted(enrollmentId),
        source: 'public_endpoint',
        payload: { trainingEnrollmentId: enrollmentId, trainingId: result.trainingId },
        dispatch: () => fireTrainingStartedAutomations(result.sessionId!, result.trainingId, {
          executionMode: 'public_trigger',
        }),
      }).catch(() => {})
    }
  }

  await bumpSessionProgress(result.sessionId)

  return NextResponse.json({ success: true, progress: result.progress, status: result.status })
}

export async function POST(request: NextRequest) {
  const { enrollmentId, accessToken } = await request.json()

  if (!enrollmentId) {
    return NextResponse.json({ error: 'enrollmentId required' }, { status: 400 })
  }

  const enrollment = await prisma.trainingEnrollment.findUnique({
    where: { id: enrollmentId },
    include: { training: true, accessToken: true },
  })
  if (!enrollment) {
    return NextResponse.json({ error: 'Enrollment not found' }, { status: 404 })
  }

  // Per-candidate token gate. The enrollment was created behind a signed
  // training link (TrainingAccessToken), and the candidate's browser knows
  // that token. Require it on the completion POST so a stale tab replay,
  // prefetch, or external scanner that learns enrollmentId can't mark the
  // training complete and fire downstream automations. Tokens that don't
  // match (or weren't supplied) are rejected — the prior implementation
  // accepted any caller who knew enrollmentId, which is how a session that
  // never completed any section could end up triggering the
  // `training_completed` rule chain.
  if (enrollment.accessTokenId) {
    if (typeof accessToken !== 'string' || !accessToken) {
      return NextResponse.json({ error: 'accessToken required' }, { status: 401 })
    }
    if (!enrollment.accessToken || enrollment.accessToken.token !== accessToken) {
      return NextResponse.json({ error: 'invalid accessToken' }, { status: 401 })
    }
  }

  if (enrollment.status === 'completed') {
    return NextResponse.json({ success: true, alreadyCompleted: true })
  }

  await completeEnrollment(enrollmentId)

  console.log(`[Training] Enrollment ${enrollmentId} completed for training ${enrollment.training.title}`)

  // Note: training_completed automations fire via the Prisma lifecycle
  // middleware on the TrainingEnrollment.completedAt write inside
  // completeEnrollment. Calling fireTrainingCompletedAutomations explicitly
  // here used to race the middleware: two concurrent dispatches both passed
  // the guard's `status==='sent'` idempotency check (both still 'pending')
  // and produced duplicate sends + duplicate invite_sent rows on the
  // candidate timeline.

  await bumpSessionProgress(enrollment.sessionId)

  return NextResponse.json({ success: true, status: 'completed' })
}
