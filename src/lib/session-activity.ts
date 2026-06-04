import { prisma } from './prisma'

// Heartbeat for the candidate-facing flows. Bumped whenever the candidate
// does anything that proves they're still engaged: answers a flow step,
// progresses a training, submits a quiz. The recruiter UI surfaces this
// as "last active 4 min ago" so a stalled candidate is visually obvious
// from one that's still in the middle of the funnel.
//
// `lastActivityAt` is bumped on PASSIVE signals too (opening a training
// landing page, viewing a public link). For the stale-detection cron use
// `bumpSessionProgress` below, which has stricter callsite rules.
//
// Always non-blocking — a missed heartbeat must never break the candidate's
// progression. Callers don't await the failure path.
export async function bumpSessionActivity(sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) return
  try {
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastActivityAt: new Date() },
    })
  } catch {
    // swallow — heartbeat is best-effort
  }
}

// Forward-progress heartbeat — the inactivity clock the daily stale-detection
// cron reads. ONLY call this when the candidate has done something that
// demonstrably moves them through the funnel:
//   - submitted a flow answer
//   - completed the flow (finishedAt set)
//   - started or progressed a training step
//   - booked a meeting
//   - attended a meeting (actualStart set)
//   - submitted a background check
//   - completed any other required next action
//
// Do NOT call this on passive signals (opening a training landing page,
// clicking a tracking link, loading the public flow page) — those are what
// `bumpSessionActivity` is for. The whole point of the split is so the cron
// can trust this timestamp as the true inactivity clock.
//
// Also bumps `lastActivityAt` so the "last seen" display stays consistent —
// any real progress event is also activity. Best-effort; never blocks.
export async function bumpSessionProgress(sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) return
  try {
    const now = new Date()
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastProgressAt: now, lastActivityAt: now },
    })
  } catch {
    // swallow — heartbeat is best-effort
  }
}
