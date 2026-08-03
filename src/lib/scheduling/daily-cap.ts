/**
 * Per-day booking-count helper for the `maxPerDay` cap in BookingRules.
 *
 * Counts NON-CANCELLED InterviewMeeting rows for a given SchedulingConfig,
 * bucketed by `scheduledStart` interpreted in the recruiter's (workspace)
 * timezone. Timezone matters: a workspace whose recruiter is in America/
 * New_York running interviews at 22:00 EST gets +1 to that day's count,
 * not to the next UTC day.
 *
 * The output map is keyed `YYYY-MM-DD` (workspace-local date). Callers pass
 * it into `computeAvailableSlots` which skips days at or above the cap.
 */

import { prisma } from '../prisma'
import { zonedFromUtc } from './slot-computer'

export interface CountBookingsPerDayOpts {
  schedulingConfigId: string
  timezone: string
  fromUtc: Date
  toUtc: Date
  /** Optional interview meeting id to exclude — used by the reschedule flow
   * so a candidate moving their own booking doesn't count themselves out. */
  excludeInterviewMeetingId?: string
}

export async function countBookingsPerDay(
  opts: CountBookingsPerDayOpts,
): Promise<Record<string, number>> {
  const meetings = await prisma.interviewMeeting.findMany({
    where: {
      schedulingConfigId: opts.schedulingConfigId,
      cancelledAt: null,
      scheduledStart: { gte: opts.fromUtc, lt: opts.toUtc },
      ...(opts.excludeInterviewMeetingId
        ? { NOT: { id: opts.excludeInterviewMeetingId } }
        : {}),
    },
    select: { scheduledStart: true },
  })
  const counts: Record<string, number> = {}
  for (const m of meetings) {
    const z = zonedFromUtc(m.scheduledStart, opts.timezone)
    const key = `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * Day-bucket key for a UTC instant in the given timezone. Same shape as
 * countBookingsPerDay's keys. Extracted so booking-submit paths can compute
 * the key for a single slot without materialising a whole day map.
 */
export function dayKeyForUtc(utc: Date, timezone: string): string {
  const z = zonedFromUtc(utc, timezone)
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`
}
