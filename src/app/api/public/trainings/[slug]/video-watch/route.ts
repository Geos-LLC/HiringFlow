import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Per-lesson watch telemetry from the training LessonVideo player. Mirrors
// /api/public/sessions/[id]/video-watch but scoped to training lessons —
// same coverage %, seek log, and skip counters, just written to
// TrainingVideoWatch keyed by (sessionId, contentId).
//
// Auth: enrollmentId + accessToken (the same handshake /progress uses).
// enrollments without an accessTokenId are always public-mode, so no token
// is required. All derived counters are recomputed here from raw events +
// watchedRanges so the client can't inflate them.

interface SeekEvent {
  t: number
  from: number
  to: number
  // When true, the user attempted to skip forward but the requiredWatch
  // enforcer snapped them back. Playback never actually moved — but the
  // recruiter view still shows the intent.
  blocked?: boolean
}

type Range = [number, number]

const MAX_EVENTS = 500
const MAX_RANGES = 200

function coerceNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function normalizeEvents(raw: unknown): SeekEvent[] {
  if (!Array.isArray(raw)) return []
  const out: SeekEvent[] = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const from = coerceNumber((e as Record<string, unknown>).from, -1)
    const to = coerceNumber((e as Record<string, unknown>).to, -1)
    const t = coerceNumber((e as Record<string, unknown>).t, 0)
    const blocked = (e as Record<string, unknown>).blocked === true
    if (from < 0 || to < 0) continue
    if (Math.abs(to - from) < 0.5) continue
    out.push(blocked ? { t, from, to, blocked: true } : { t, from, to })
    if (out.length >= MAX_EVENTS) break
  }
  return out
}

function normalizeRanges(raw: unknown, durationSec: number): Range[] {
  if (!Array.isArray(raw)) return []
  const clamped: Range[] = []
  for (const r of raw) {
    if (!Array.isArray(r) || r.length < 2) continue
    let start = coerceNumber(r[0], -1)
    let end = coerceNumber(r[1], -1)
    if (start < 0 || end < 0) continue
    if (end < start) [start, end] = [end, start]
    if (durationSec > 0) {
      start = Math.max(0, Math.min(start, durationSec))
      end = Math.max(0, Math.min(end, durationSec))
    }
    if (end - start < 0.25) continue
    clamped.push([start, end])
    if (clamped.length >= MAX_RANGES) break
  }
  clamped.sort((a, b) => a[0] - b[0])
  const merged: Range[] = []
  for (const [s, e] of clamped) {
    const last = merged[merged.length - 1]
    if (last && s <= last[1] + 0.25) {
      if (e > last[1]) last[1] = e
    } else {
      merged.push([s, e])
    }
  }
  return merged
}

function deriveCounters(events: SeekEvent[], ranges: Range[], durationSec: number) {
  // seekCount / forward / backward count *successful* seeks only — the
  // ones where playback actually moved. Blocked attempts sit in the events
  // array with `blocked: true` and get counted separately on the frontend
  // ("N blocked skip attempts") so the recruiter can distinguish "user
  // scrubbed and got away with it" from "user tried to scrub but got
  // rewound". maxForwardSkipSec reflects the largest magnitude across
  // both categories — a big blocked jump is still a strong intent signal.
  let seekCount = 0
  let forwardSkipCount = 0
  let backwardSeekCount = 0
  let maxForwardSkipSec = 0
  for (const e of events) {
    const delta = e.to - e.from
    if (delta > maxForwardSkipSec) maxForwardSkipSec = delta
    if (e.blocked) continue
    seekCount += 1
    if (delta > 0.5) forwardSkipCount += 1
    else if (delta < -0.5) backwardSeekCount += 1
  }
  let watchedSec = 0
  for (const [s, e] of ranges) watchedSec += Math.max(0, e - s)
  const coveragePct = durationSec > 0 ? Math.min(100, (watchedSec / durationSec) * 100) : 0
  return {
    seekCount,
    forwardSkipCount,
    backwardSeekCount,
    maxForwardSkipSec: Math.round(maxForwardSkipSec * 10) / 10,
    watchedSec: Math.round(watchedSec * 10) / 10,
    coveragePct: Math.round(coveragePct * 10) / 10,
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { slug: string } }
) {
  try {
    const body = await request.json()
    const enrollmentId = typeof body.enrollmentId === 'string' ? body.enrollmentId : null
    const accessToken = typeof body.accessToken === 'string' ? body.accessToken : null
    const contentId = typeof body.contentId === 'string' ? body.contentId : null

    if (!enrollmentId || !contentId) {
      return NextResponse.json({ error: 'enrollmentId and contentId required' }, { status: 400 })
    }

    const enrollment = await prisma.trainingEnrollment.findUnique({
      where: { id: enrollmentId },
      include: { training: { select: { id: true, slug: true } }, accessToken: true },
    })
    if (!enrollment) {
      return NextResponse.json({ error: 'Enrollment not found' }, { status: 404 })
    }
    if (enrollment.training.slug !== params.slug) {
      return NextResponse.json({ error: 'Enrollment does not match training' }, { status: 400 })
    }
    // Same auth handshake as /progress: candidate-facing enrollments MUST
    // present the same access token they were issued; public-mode enrollments
    // skip the check because they have no token in the first place.
    if (enrollment.accessTokenId) {
      if (!accessToken || !enrollment.accessToken || enrollment.accessToken.token !== accessToken) {
        return NextResponse.json({ error: 'invalid accessToken' }, { status: 401 })
      }
    }

    // Public-mode enrollments (no session) have no candidate to render this
    // against — skip telemetry silently rather than create orphan rows the
    // recruiter view can't reach.
    if (!enrollment.sessionId) {
      return NextResponse.json({ ok: true, skipped: 'no_session' })
    }

    // Verify the contentId belongs to this training so a rogue caller can't
    // spam rows against unrelated lessons.
    const content = await prisma.trainingContent.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        section: { select: { trainingId: true, title: true } },
        video: { select: { displayName: true, filename: true } },
      },
    })
    if (!content || content.section.trainingId !== enrollment.training.id) {
      return NextResponse.json({ error: 'Content does not belong to this training' }, { status: 400 })
    }
    const contentTitle = content.video?.displayName || content.video?.filename || content.section.title || null

    const durationSec = body.durationSec != null ? Math.max(0, coerceNumber(body.durationSec, 0)) : null
    const events = normalizeEvents(body.events)
    const watchedRanges = normalizeRanges(body.watchedRanges, durationSec ?? 0)
    const completed = !!body.completed
    const counters = deriveCounters(events, watchedRanges, durationSec ?? 0)

    const now = new Date()
    const firstPlayAt = body.firstPlayAt ? new Date(body.firstPlayAt) : null

    await prisma.trainingVideoWatch.upsert({
      where: { sessionId_contentId: { sessionId: enrollment.sessionId, contentId } },
      create: {
        sessionId: enrollment.sessionId,
        trainingId: enrollment.training.id,
        contentId,
        contentTitle,
        durationSec: durationSec ?? undefined,
        watchedSec: counters.watchedSec,
        coveragePct: counters.coveragePct,
        seekCount: counters.seekCount,
        forwardSkipCount: counters.forwardSkipCount,
        backwardSeekCount: counters.backwardSeekCount,
        maxForwardSkipSec: counters.maxForwardSkipSec,
        completed,
        events: events as unknown as object,
        watchedRanges: watchedRanges as unknown as object,
        firstPlayAt: firstPlayAt && !Number.isNaN(firstPlayAt.getTime()) ? firstPlayAt : now,
      },
      update: {
        durationSec: durationSec ?? undefined,
        watchedSec: counters.watchedSec,
        coveragePct: counters.coveragePct,
        seekCount: counters.seekCount,
        forwardSkipCount: counters.forwardSkipCount,
        backwardSeekCount: counters.backwardSeekCount,
        maxForwardSkipSec: counters.maxForwardSkipSec,
        completed: completed || undefined,
        events: events as unknown as object,
        watchedRanges: watchedRanges as unknown as object,
      },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[training-video-watch] failed', err)
    return NextResponse.json({ error: 'Failed to record watch' }, { status: 500 })
  }
}
