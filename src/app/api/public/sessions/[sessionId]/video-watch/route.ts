import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Per-step video watch telemetry from the candidate-facing flow player.
// Called by CaptionedVideo whenever the candidate pauses / seeks / ends the
// video so recruiters can see how the video was actually consumed (skipped
// past, rewound, watched end-to-end).
//
// One row per (sessionId, stepId), upserted. Derived counters
// (watchedSec, coveragePct, seek/skip counts) are recomputed here from the
// events + watchedRanges arrays so the client can't inflate them.

interface SeekEvent {
  t: number // wallclock ms since firstPlay
  from: number
  to: number
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
    if (from < 0 || to < 0) continue
    if (Math.abs(to - from) < 0.5) continue // ignore trivial seeks
    out.push({ t, from, to })
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
  // Merge overlapping ranges so watchedSec is a union, not a sum.
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
  let seekCount = 0
  let forwardSkipCount = 0
  let backwardSeekCount = 0
  let maxForwardSkipSec = 0
  for (const e of events) {
    seekCount += 1
    const delta = e.to - e.from
    if (delta > 0.5) {
      forwardSkipCount += 1
      if (delta > maxForwardSkipSec) maxForwardSkipSec = delta
    } else if (delta < -0.5) {
      backwardSeekCount += 1
    }
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
  { params }: { params: { sessionId: string } }
) {
  try {
    const body = await request.json()
    const stepId = typeof body.stepId === 'string' ? body.stepId : null
    if (!stepId) {
      return NextResponse.json({ error: 'stepId is required' }, { status: 400 })
    }

    // Cheap FK check first — spares us the upsert cost when someone POSTs a
    // stale sessionId (candidate closed tab, reopened stale copy of app).
    const session = await prisma.session.findUnique({
      where: { id: params.sessionId },
      select: { id: true },
    })
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    const durationSec = body.durationSec != null ? Math.max(0, coerceNumber(body.durationSec, 0)) : null
    const events = normalizeEvents(body.events)
    const watchedRanges = normalizeRanges(body.watchedRanges, durationSec ?? 0)
    const completed = !!body.completed
    const counters = deriveCounters(events, watchedRanges, durationSec ?? 0)

    const now = new Date()
    const firstPlayAt = body.firstPlayAt ? new Date(body.firstPlayAt) : null

    await prisma.sessionVideoWatch.upsert({
      where: { sessionId_stepId: { sessionId: params.sessionId, stepId } },
      create: {
        sessionId: params.sessionId,
        stepId,
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
        // Once completed goes true, keep it true — a rewatch that stops
        // partway shouldn't erase the fact they saw the whole thing.
        completed: completed || undefined,
        events: events as unknown as object,
        watchedRanges: watchedRanges as unknown as object,
      },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[video-watch] failed', err)
    return NextResponse.json({ error: 'Failed to record watch' }, { status: 500 })
  }
}
