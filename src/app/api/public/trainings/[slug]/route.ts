import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getVideoUrl } from '@/lib/storage'
import { validateAccessToken, findExistingEnrollment } from '@/lib/training-access'
import { getWorkspaceSession } from '@/lib/auth'
import { bumpSessionActivity } from '@/lib/session-activity'
import { logger } from '@/lib/logger'

// Time a labelled async section. Used by the GET handler to record where the
// public-training response actually spends its time — so we don't add Redis
// before knowing whether the bottleneck is the Prisma read, the token check,
// the enrollment upsert, or a cold start (none of which Redis can fix the
// same way).
async function time<T>(label: string, fn: () => Promise<T>, timings: Record<string, number>): Promise<T> {
  const t0 = Date.now()
  try {
    return await fn()
  } finally {
    timings[label] = Date.now() - t0
  }
}

// ─────────────────────────── Quiz options shapes ───────────────────────────
//
// `TrainingQuestion.options` is a JSON blob whose shape varies by `questionType`.
// Helpers below normalize reads, redact correct-answer secrets before sending
// to candidates, and grade submissions per type.
//
// Choice options:
//   single | multiselect | image  → Array<ChoiceOption>
//     (image variant adds imageUrl)
// Free-form:
//   text  → { acceptedAnswers: string[], caseSensitive?: boolean, hint?: string }
//   number → { value: number, tolerance?: number, hint?: string }
// Upload:
//   file  → { acceptedMimeTypes: string[], maxSizeMb: number }
type ChoiceOption = { text?: string; imageUrl?: string; isCorrect: boolean; hint?: string }
type TextOptions = { acceptedAnswers: string[]; caseSensitive?: boolean; hint?: string }
type NumberOptions = { value: number; tolerance?: number; hint?: string }
type FileOptions = { acceptedMimeTypes: string[]; maxSizeMb: number }

function isChoiceType(t: string): boolean {
  return t === 'single' || t === 'multiselect' || t === 'image'
}

// Strip correct-answer signals before sending options to the candidate viewer.
function redactOptionsForCandidate(questionType: string, raw: unknown): unknown {
  if (isChoiceType(questionType)) {
    const opts = (raw as ChoiceOption[]) ?? []
    return opts.map((o, i) => ({
      index: i,
      text: o.text,
      imageUrl: o.imageUrl,
    }))
  }
  if (questionType === 'text') {
    // Don't reveal accepted answers. Send an empty shell so the viewer knows
    // it's a text question.
    return { kind: 'text' }
  }
  if (questionType === 'number') {
    return { kind: 'number' }
  }
  if (questionType === 'file') {
    const o = (raw as FileOptions) ?? { acceptedMimeTypes: [], maxSizeMb: 25 }
    return {
      kind: 'file',
      acceptedMimeTypes: o.acceptedMimeTypes ?? [],
      maxSizeMb: o.maxSizeMb ?? 25,
    }
  }
  return raw
}

// ─────────────────────────── Per-type grading ───────────────────────────
//
// `answers` is { [questionId]: AnswerValue }. Shape per type:
//   choice/multi/image → number[] (selected option indices)
//   text   → string
//   number → number
//   file   → { url: string, mimeType: string, sizeBytes: number }
type GradeResult = {
  questionId: string
  isCorrect: boolean
  // For choice types, surface which indices were correct (for review UI).
  correctIndices?: number[]
  // For free-form types, surface the canonical correct answer when feedbackMode
  // is 'explanation'. The caller decides whether to forward this to the client.
  correctAnswerText?: string | null
  // Per-option hints aligned with the candidate's selection (choice types) or
  // the option-level hint for free-form types.
  hints: (string | null)[]
}

function gradeChoice(q: { id: string; questionType: string; options: unknown }, selected: number[]): GradeResult {
  const opts = (q.options as ChoiceOption[]) ?? []
  // For "single" and "image" with one correct, exact-set match. For "multiselect",
  // all correct selected and no incorrect selected.
  const isCorrect = opts.every((o, i) => Boolean(o.isCorrect) === selected.includes(i))
  return {
    questionId: q.id,
    isCorrect,
    correctIndices: opts.map((o, i) => (o.isCorrect ? i : -1)).filter((i) => i >= 0),
    hints: opts.map((o, i) => (selected.includes(i) ? o.hint || null : null)),
  }
}

function gradeText(q: { id: string; options: unknown }, given: string): GradeResult {
  const opts = (q.options as TextOptions) ?? { acceptedAnswers: [] }
  const norm = (s: string) => (opts.caseSensitive ? s : s.toLowerCase()).trim()
  const target = (opts.acceptedAnswers ?? []).map(norm)
  const isCorrect = target.length > 0 && target.includes(norm(given || ''))
  return {
    questionId: q.id,
    isCorrect,
    correctAnswerText: opts.acceptedAnswers?.[0] ?? null,
    hints: [opts.hint || null],
  }
}

function gradeNumber(q: { id: string; options: unknown }, given: number): GradeResult {
  const opts = (q.options as NumberOptions) ?? { value: 0 }
  const tol = Math.abs(opts.tolerance ?? 0)
  const isCorrect = typeof given === 'number' && Number.isFinite(given) && Math.abs(given - opts.value) <= tol
  return {
    questionId: q.id,
    isCorrect,
    correctAnswerText: String(opts.value),
    hints: [opts.hint || null],
  }
}

function gradeFile(q: { id: string; options: unknown }, given: { url?: string; mimeType?: string; sizeBytes?: number } | null): GradeResult {
  const opts = (q.options as FileOptions) ?? { acceptedMimeTypes: [], maxSizeMb: 25 }
  const hasFile = !!given?.url
  const mimeOk = !opts.acceptedMimeTypes?.length || (given?.mimeType ? opts.acceptedMimeTypes.includes(given.mimeType) : false)
  const sizeOk = (given?.sizeBytes ?? 0) <= (opts.maxSizeMb ?? 25) * 1024 * 1024
  const isCorrect = hasFile && mimeOk && sizeOk
  return {
    questionId: q.id,
    isCorrect,
    hints: [],
  }
}

export async function GET(request: NextRequest, { params }: { params: { slug: string } }) {
  const tStart = Date.now()
  const timings: Record<string, number> = {}

  const training = await time('trainingQuery', () => prisma.training.findUnique({
    where: { slug: params.slug },
    include: {
      sections: {
        orderBy: { sortOrder: 'asc' },
        include: {
          contents: { orderBy: { sortOrder: 'asc' }, include: { video: true } },
          quiz: { include: { questions: { orderBy: { sortOrder: 'asc' } } } },
        },
      },
    },
  }), timings)

  if (!training) {
    return NextResponse.json({ error: 'Training not found' }, { status: 404 })
  }

  // Preview mode: owner/admin can view unpublished or invitation-only trainings via dashboard session.
  const isPreview = request.nextUrl.searchParams.get('preview') === '1'
  let isOwnerPreview = false
  if (isPreview) {
    const ws = await getWorkspaceSession()
    if (ws && (ws.isSuperAdmin || ws.workspaceId === training.workspaceId)) {
      isOwnerPreview = true
    }
  }

  if (!training.isPublished && !isOwnerPreview) {
    return NextResponse.json({ error: 'Training not found' }, { status: 404 })
  }

  // Token-based access control for invitation_only trainings
  const token = request.nextUrl.searchParams.get('token')
  let enrollmentId: string | null = null
  let enrollmentStatus: string | null = null
  let enrollmentProgress: unknown = null
  let candidateName: string | null = null
  let candidateEmail: string | null = null

  if (training.accessMode === 'invitation_only' && !isOwnerPreview) {
    if (!token) {
      return NextResponse.json({ error: 'Access token required', code: 'TOKEN_REQUIRED' }, { status: 403 })
    }

    const accessToken = await time('validateAccessToken', () => validateAccessToken(token, training.id), timings)
    if (!accessToken) {
      return NextResponse.json({ error: 'Access unavailable or expired', code: 'TOKEN_INVALID' }, { status: 403 })
    }

    // Look up an existing enrollment WITHOUT creating one. Opening the
    // invitation link is a passive signal — we only want `training_started`
    // to fire when the candidate presses Start. The POST /start endpoint is
    // the write-side counterpart that creates the enrollment.
    const enrollment = await time('findExistingEnrollment', () => findExistingEnrollment({
      trainingId: training.id,
      accessTokenId: accessToken.id,
    }), timings)

    enrollmentId = enrollment?.id ?? null
    enrollmentStatus = enrollment?.status ?? null
    enrollmentProgress = enrollment?.progress ?? null
    candidateName = accessToken.candidate?.candidateName || null
    candidateEmail = accessToken.candidate?.candidateEmail || null

    // Heartbeat fire-and-forget: the recruiter dashboard reads
    // Session.lastActivityAt to surface "last active Nm ago", but a stale
    // heartbeat is never user-visible to the candidate, and bumpSessionActivity
    // already swallows its own errors. Awaiting it just added DB round-trip
    // time to the candidate's first paint.
    void bumpSessionActivity(accessToken.candidateId)
  }

  const response = NextResponse.json({
    id: training.id,
    title: training.title,
    description: training.description,
    coverImage: training.coverImage,
    branding: training.branding,
    passingGrade: training.passingGrade,
    accessMode: training.accessMode,
    sectionOrder: training.sectionOrder,
    enrollmentId,
    enrollmentStatus,
    enrollmentProgress,
    candidateName,
    candidateEmail,
    sections: training.sections.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      contents: s.contents.map((c) => ({
        id: c.id,
        type: c.type,
        // Legacy MP4 URL — viewer falls back to this when hlsManifestUrl is null
        // (Vercel Blob videos predating the R2/HLS pipeline, or videos still
        // mid-transcode where the manifest doesn't exist yet).
        videoUrl: c.video ? getVideoUrl(c.video.storageKey) : null,
        videoHlsUrl: c.video?.hlsManifestUrl ?? null,
        videoPosterUrl: c.video?.posterUrl ?? null,
        videoStatus: c.video?.status ?? null,
        videoName: c.video?.displayName || c.video?.filename || null,
        videoDurationSeconds: c.video?.durationSeconds ?? null,
        requiredWatch: c.requiredWatch,
        autoplayNext: c.autoplayNext,
        textContent: c.textContent,
      })),
      quiz: s.quiz ? {
        id: s.quiz.id,
        title: s.quiz.title,
        requiredPassing: s.quiz.requiredPassing,
        passingGrade: s.quiz.passingGrade,
        feedbackMode: s.quiz.feedbackMode,
        questions: s.quiz.questions.map((q) => ({
          id: q.id,
          questionText: q.questionText,
          questionType: q.questionType,
          // Per-type redaction: never send isCorrect / acceptedAnswers / value
          // / tolerance to the candidate. The grader compares server-side.
          options: redactOptionsForCandidate(q.questionType, q.options),
        })),
      } : null,
    })),
  })

  // Emit once per request so we can see in LogHub whether candidate-reported
  // "training loading slowly" is the API (DB / token / enrollment / cold start)
  // or just the video buffering from Blob. Keep at info level so the production
  // log volume stays readable; flip to debug if it gets noisy.
  logger.info('public_training_get', {
    slug: params.slug,
    trainingId: training.id,
    accessMode: training.accessMode,
    isOwnerPreview,
    tokenPresent: !!token,
    totalMs: Date.now() - tStart,
    ...timings,
  })

  return response
}

// Submit quiz answers — returns score
export async function POST(request: NextRequest, { params }: { params: { slug: string } }) {
  const training = await prisma.training.findUnique({
    where: { slug: params.slug },
    include: {
      sections: {
        include: {
          quiz: { include: { questions: true } },
        },
      },
    },
  })

  if (!training || !training.isPublished) {
    return NextResponse.json({ error: 'Training not found' }, { status: 404 })
  }

  const { quizId, answers, enrollmentId } = await request.json() as {
    quizId: string
    answers: Record<string, unknown>
    enrollmentId?: string
  }

  // Find the quiz
  const quiz = training.sections.flatMap(s => s.quiz ? [s.quiz] : []).find(q => q.id === quizId)
  if (!quiz) return NextResponse.json({ error: 'Quiz not found' }, { status: 404 })

  const allResults: GradeResult[] = quiz.questions.map((q) => {
    const given = answers[q.id]
    if (isChoiceType(q.questionType)) {
      return gradeChoice(q, Array.isArray(given) ? (given as number[]) : [])
    }
    if (q.questionType === 'text') {
      return gradeText(q, typeof given === 'string' ? given : '')
    }
    if (q.questionType === 'number') {
      const n = typeof given === 'number' ? given : Number(given)
      return gradeNumber(q, n)
    }
    if (q.questionType === 'file') {
      return gradeFile(q, (given as { url?: string; mimeType?: string; sizeBytes?: number } | null) ?? null)
    }
    // Unknown type: fail closed.
    return { questionId: q.id, isCorrect: false, hints: [] }
  })

  const correct = allResults.filter((r) => r.isCorrect).length
  const score = quiz.questions.length > 0 ? Math.round((correct / quiz.questions.length) * 100) : 0
  const passed = score >= quiz.passingGrade

  // Apply feedbackMode redaction. The grader always computes full results
  // (the score depends on it), but what we hand back to the candidate depends
  // on the quiz config:
  //   none         → return only score+passed; no per-question results
  //   correctness  → per-question isCorrect + correctIndices, no hints / canonical answer
  //   explanation  → full results with hints + canonical answer
  const feedbackMode = quiz.feedbackMode || 'correctness'
  const results = (() => {
    if (feedbackMode === 'none') return []
    if (feedbackMode === 'correctness') {
      return allResults.map((r) => ({
        questionId: r.questionId,
        isCorrect: r.isCorrect,
        correctIndices: r.correctIndices,
      }))
    }
    return allResults
  })()

  // Update enrollment progress if enrollmentId provided. Wrapped in a
  // transaction with a per-enrollment advisory lock so a concurrent
  // section-completion PATCH (from /progress) can't race the quiz score
  // write — same fix as the /progress route.
  if (enrollmentId) {
    try {
      const sessionId = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${enrollmentId}::text, 0))`
        const enrollment = await tx.trainingEnrollment.findUnique({ where: { id: enrollmentId } })
        if (!enrollment) return null
        const progress = (enrollment.progress as { completedSections: string[]; quizScores: { sectionId: string; score: number }[]; sectionTimestamps?: Record<string, string> }) || { completedSections: [], quizScores: [] }
        // Older enrollments were created before these fields existed on the
        // progress blob. Default them so the findIndex/push below can't throw —
        // the surrounding try/catch would swallow the error and the score would
        // silently never be saved (a resubmit keeps showing the stale result).
        if (!Array.isArray(progress.completedSections)) progress.completedSections = []
        if (!Array.isArray(progress.quizScores)) progress.quizScores = []
        // Find which section this quiz belongs to
        const section = training.sections.find(s => s.quiz?.id === quizId)
        if (section) {
          // Update quiz score
          const existingIdx = progress.quizScores.findIndex((qs: { sectionId: string }) => qs.sectionId === section.id)
          if (existingIdx >= 0) {
            progress.quizScores[existingIdx].score = score
          } else {
            progress.quizScores.push({ sectionId: section.id, score })
          }
          // Mark section as completed if passed, stamping the timestamp on
          // first transition so the recruiter timeline gets a real moment
          // ("Section 2 quiz passed @ 14:32") instead of falling back to the
          // enrollment.startedAt.
          if (passed && !progress.completedSections.includes(section.id)) {
            progress.completedSections.push(section.id)
            const stamps = { ...(progress.sectionTimestamps || {}) }
            if (!stamps[section.id]) stamps[section.id] = new Date().toISOString()
            progress.sectionTimestamps = stamps
          }
          await tx.trainingEnrollment.update({
            where: { id: enrollmentId },
            data: { progress },
          })
        }
        return enrollment.sessionId
      })
      if (sessionId !== null) await bumpSessionActivity(sessionId)
    } catch (err) {
      console.error('[Training] Failed to update enrollment progress:', err)
    }
  }

  return NextResponse.json({ score, correct, total: quiz.questions.length, passed, results })
}
