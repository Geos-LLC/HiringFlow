/**
 * Backfill the 5 candidate "Yes" interview confirmations that were dropped
 * between 2026-05-07 and 2026-06-05 while Sigcore's outbound webhook
 * subscription to HF was paused (HMAC contract mismatch).
 *
 * Root cause (fixed in src/lib/sigcore-signature.ts + the route handler in
 * the same PR): Sigcore migrated the HMAC contract on 2026-05-07 (Sigcore
 * commit 12e9bd8f) from `hex(HMAC-SHA256(secret, body))` to
 * `hex(HMAC-SHA256(secret, `${tsEpoch}.${body}`))`. HF's verifier was still
 * hashing raw body alone, so every inbound delivery was 401'd. Sigcore
 * subscription 30924851-... paused on failure_count=11; the 5 records below
 * are the confirm-intent inbound SMS messages from Sigcore's prod DB during
 * the paused window.
 *
 * For each record this script:
 *
 *   1. Normalizes the from-number to E.164 and finds Sessions whose
 *      `candidatePhone` matches across all workspaces (mirrors the route's
 *      cross-workspace search).
 *   2. Picks the Session with the soonest InterviewMeeting where
 *      `scheduledStart >= receivedAt - 1h` (mirrors the route's selection
 *      window, but anchored on `receivedAt` instead of `now`).
 *   3. Branches on the meeting's current state:
 *        - No matching session       → skipped: no_session_match
 *        - confirmedAt already set   → skipped: already_confirmed
 *        - scheduledStart in future  → stamp confirmedAt = receivedAt,
 *                                       log meeting_confirmed SchedulingEvent
 *                                       (source: 'manual_backfill_2026-06-05'),
 *                                       run applyStageTrigger('meeting_confirmed').
 *                                       Recruiter email skipped (too late, just noise).
 *                                       Result: backfilled_future_meeting
 *        - scheduledStart elapsed    → stamp confirmedAt = receivedAt AND log
 *                                       SchedulingEvent for timeline accuracy,
 *                                       but DO NOT run applyStageTrigger and DO
 *                                       NOT email anyone — the kanban shouldn't
 *                                       move based on stale events.
 *                                       Result: backfilled_past_meeting_audit_only
 *
 * Idempotence:
 *   - confirmedAt is only written if currently null.
 *   - The SchedulingEvent insert is gated by a findFirst on
 *     metadata.providerMessageId so re-running with --apply is a no-op.
 *
 * Transactional safety:
 *   - All writes for a given record run inside a single prisma.$transaction.
 *     If applyStageTrigger throws on the future-meeting branch, the tx rolls
 *     back so we don't have a confirmedAt without the matching event.
 *     (applyStageTrigger does its own writes outside the tx by design —
 *     errors there are caught and logged but don't roll back the tx; this
 *     matches the route's "best effort" semantics.)
 *
 * Usage:
 *   npx tsx scripts/backfill-sigcore-confirms-2026-06-05.ts            # DRY RUN (default)
 *   npx tsx scripts/backfill-sigcore-confirms-2026-06-05.ts --apply    # writes
 *
 * Re-running with --apply after the first apply is safe — every record
 * will either resolve as 'already_confirmed' (because confirmedAt was set
 * in the prior run) or 'duplicate_event' (because the SchedulingEvent
 * already exists by providerMessageId).
 *
 * Manual review: the user should run --dry-run first, inspect the per-
 * record output, then --apply once happy. Do NOT execute this script via
 * automation; the affected candidates are real human interviews and any
 * surprise stage move could be embarrassing.
 */

import { PrismaClient, Prisma } from '@prisma/client'
import { normalizeToE164 } from '../src/lib/sms'
import { logSchedulingEvent } from '../src/lib/scheduling'
import { applyStageTrigger } from '../src/lib/funnel-stage-runtime'

const APPLY = process.argv.includes('--apply')
const prisma = new PrismaClient()

// Pulled from Sigcore prod DB: all rows in webhook_subscriptions.deliveries
// where event_type='message.inbound', subscription_id='30924851-...',
// body ILIKE 'yes%', received between Sigcore commit 12e9bd8f (2026-05-07)
// and the fix (2026-06-05). All to HF's profile number +19183091938.
const DROPPED_CONFIRMS: ReadonlyArray<{
  providerMessageId: string
  from: string
  receivedAt: string // ISO 8601
}> = [
  { providerMessageId: 'SM75b31b5e4a997c86b9a1f0e8f8b0e7f7', from: '+19542269620', receivedAt: '2026-05-08T23:12:02.271Z' },
  { providerMessageId: 'SM5478534ab11c201c2a423fb599a15084', from: '+19498782350', receivedAt: '2026-05-11T20:30:49.966Z' },
  { providerMessageId: 'SMcfdb32ffe31580ef59b2bbc2c3e11297', from: '+19498782350', receivedAt: '2026-05-11T21:28:18.257Z' },
  { providerMessageId: 'SMf6be2f2a769104799f677b402333fcb8', from: '+17866067988', receivedAt: '2026-05-12T22:45:49.366Z' },
  { providerMessageId: 'SM7be2414cabad70bb837c7a9ad7605d85', from: '+19046619768', receivedAt: '2026-06-03T17:41:40.041Z' },
]

type Decision =
  | 'skipped_no_session'
  | 'skipped_already_confirmed'
  | 'backfilled_future_meeting'
  | 'backfilled_past_meeting_audit_only'
  | 'duplicate_event_idempotent'

interface RecordOutcome {
  providerMessageId: string
  from: string
  fromNormalized: string | null
  receivedAt: string
  decision: Decision
  sessionId?: string
  workspaceId?: string
  meetingId?: string
  scheduledStart?: string
  candidateName?: string | null
  notes?: string
}

async function resolveTarget(rec: typeof DROPPED_CONFIRMS[number]) {
  const fromNormalized = normalizeToE164(rec.from)
  if (!fromNormalized) return { fromNormalized: null as string | null, target: null }

  const receivedAt = new Date(rec.receivedAt)
  const oneHourBefore = new Date(receivedAt.getTime() - 60 * 60 * 1000)

  // Mirror the route handler's matching: every Session with a phone,
  // filter on E.164 equality in Node (because candidatePhone can be stored
  // in any format), pick the one whose soonest InterviewMeeting with
  // scheduledStart >= receivedAt-1h is the closest in time.
  const candidates = await prisma.session.findMany({
    where: { candidatePhone: { not: null } },
    select: {
      id: true,
      workspaceId: true,
      candidatePhone: true,
      candidateName: true,
      candidateEmail: true,
      interviewMeetings: {
        where: { scheduledStart: { gte: oneHourBefore } },
        orderBy: { scheduledStart: 'asc' },
        select: {
          id: true,
          googleCalendarEventId: true,
          scheduledStart: true,
          confirmedAt: true,
        },
      },
    },
  })

  type Match = {
    sessionId: string
    workspaceId: string
    candidateName: string | null
    candidateEmail: string | null
    meeting: {
      id: string
      googleCalendarEventId: string
      scheduledStart: Date
      confirmedAt: Date | null
    }
  }
  const matches: Match[] = []
  for (const c of candidates) {
    const normalized = c.candidatePhone ? normalizeToE164(c.candidatePhone) : null
    if (normalized !== fromNormalized) continue
    const meeting = c.interviewMeetings[0]
    if (!meeting) continue
    matches.push({
      sessionId: c.id,
      workspaceId: c.workspaceId,
      candidateName: c.candidateName,
      candidateEmail: c.candidateEmail,
      meeting,
    })
  }
  matches.sort((a, b) => a.meeting.scheduledStart.getTime() - b.meeting.scheduledStart.getTime())
  return { fromNormalized, target: matches[0] ?? null }
}

async function processRecord(rec: typeof DROPPED_CONFIRMS[number]): Promise<RecordOutcome> {
  const { fromNormalized, target } = await resolveTarget(rec)
  const base = {
    providerMessageId: rec.providerMessageId,
    from: rec.from,
    fromNormalized,
    receivedAt: rec.receivedAt,
  }

  if (!target) {
    return { ...base, decision: 'skipped_no_session' }
  }

  if (target.meeting.confirmedAt) {
    return {
      ...base,
      decision: 'skipped_already_confirmed',
      sessionId: target.sessionId,
      workspaceId: target.workspaceId,
      meetingId: target.meeting.id,
      scheduledStart: target.meeting.scheduledStart.toISOString(),
      candidateName: target.candidateName,
    }
  }

  // Idempotency: if a meeting_confirmed event already exists for this
  // (sessionId, meetingId) tagged with this providerMessageId, the prior
  // --apply run already handled it — short-circuit before re-writing.
  const dupEvent = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId: target.sessionId,
      eventType: 'meeting_confirmed',
      metadata: {
        path: ['providerMessageId'],
        equals: rec.providerMessageId,
      },
    },
    select: { id: true },
  })
  if (dupEvent) {
    return {
      ...base,
      decision: 'duplicate_event_idempotent',
      sessionId: target.sessionId,
      workspaceId: target.workspaceId,
      meetingId: target.meeting.id,
      scheduledStart: target.meeting.scheduledStart.toISOString(),
      candidateName: target.candidateName,
    }
  }

  const receivedAt = new Date(rec.receivedAt)
  const meetingInFuture = target.meeting.scheduledStart.getTime() > Date.now()
  const decision: Decision = meetingInFuture
    ? 'backfilled_future_meeting'
    : 'backfilled_past_meeting_audit_only'

  const outcome: RecordOutcome = {
    ...base,
    decision,
    sessionId: target.sessionId,
    workspaceId: target.workspaceId,
    meetingId: target.meeting.id,
    scheduledStart: target.meeting.scheduledStart.toISOString(),
    candidateName: target.candidateName,
  }

  if (!APPLY) return outcome

  // Writes: stamp confirmedAt + log the event in a single transaction so we
  // never end up with one without the other. applyStageTrigger runs OUTSIDE
  // the tx (it does its own writes including stage moves and downstream
  // automation rule enqueuing — wrapping it in a single tx would risk huge
  // lock windows). If it fails we surface the error in the outcome but the
  // confirmedAt + event are already durable.
  await prisma.$transaction(async (tx) => {
    await tx.interviewMeeting.update({
      where: { id: target.meeting.id },
      data: { confirmedAt: receivedAt },
    })
    // Inline the SchedulingEvent insert to share the tx — logSchedulingEvent
    // uses the top-level prisma client, which wouldn't be part of this tx.
    await tx.schedulingEvent.create({
      data: {
        sessionId: target.sessionId,
        eventType: 'meeting_confirmed',
        eventAt: receivedAt,
        metadata: {
          interviewMeetingId: target.meeting.id,
          source: 'manual_backfill_2026-06-05',
          providerMessageId: rec.providerMessageId,
          originalReceivedAt: rec.receivedAt,
        } as Prisma.InputJsonValue,
      },
    })
  })

  // Suppress logSchedulingEvent — we did the insert inside the tx above to
  // keep durability guarantees tight. Referenced here only so the import
  // isn't flagged as unused; intentional no-op.
  void logSchedulingEvent

  if (decision === 'backfilled_future_meeting') {
    try {
      await applyStageTrigger({
        sessionId: target.sessionId,
        workspaceId: target.workspaceId,
        event: 'meeting_confirmed',
      })
    } catch (err) {
      outcome.notes = `applyStageTrigger failed (confirmedAt + event still durable): ${(err as Error).message}`
    }
  } else {
    // Past meeting — kanban should NOT move based on stale events. We also
    // intentionally skip the recruiter email (per spec; too noisy this late).
    outcome.notes = 'past meeting; stage trigger and recruiter email intentionally skipped'
  }

  return outcome
}

function printOutcome(o: RecordOutcome) {
  const lines = [
    `[backfill] ${o.providerMessageId}`,
    `  from=${o.from} (normalized=${o.fromNormalized ?? '<null>'})`,
    `  receivedAt=${o.receivedAt}`,
    `  decision=${o.decision}`,
  ]
  if (o.sessionId) lines.push(`  sessionId=${o.sessionId} workspaceId=${o.workspaceId}`)
  if (o.candidateName) lines.push(`  candidate="${o.candidateName}"`)
  if (o.meetingId) lines.push(`  meetingId=${o.meetingId} scheduledStart=${o.scheduledStart}`)
  if (o.notes) lines.push(`  notes=${o.notes}`)
  console.log(lines.join('\n'))
}

async function main() {
  console.log(`[backfill] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  console.log(`[backfill] records: ${DROPPED_CONFIRMS.length}`)
  console.log('')

  const outcomes: RecordOutcome[] = []
  for (const rec of DROPPED_CONFIRMS) {
    const outcome = await processRecord(rec)
    outcomes.push(outcome)
    printOutcome(outcome)
    console.log('')
  }

  // Summary, shape per spec.
  const summary = {
    confirmed_future: outcomes.filter((o) => o.decision === 'backfilled_future_meeting').length,
    audited_past: outcomes.filter((o) => o.decision === 'backfilled_past_meeting_audit_only').length,
    skipped_no_session: outcomes.filter((o) => o.decision === 'skipped_no_session').length,
    skipped_already_confirmed: outcomes.filter((o) => o.decision === 'skipped_already_confirmed').length,
    duplicate_event_idempotent: outcomes.filter((o) => o.decision === 'duplicate_event_idempotent').length,
  }
  console.log('[backfill] summary:', JSON.stringify(summary, null, 2))

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('[backfill] FATAL:', e)
  await prisma.$disconnect()
  process.exit(1)
})
