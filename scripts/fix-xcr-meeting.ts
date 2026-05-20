/**
 * One-off cleanup for InterviewMeeting xcr-paay-dfi (2026-05-20):
 *  1. Backfill `GoogleIntegration.googleDisplayName` on the host workspace
 *     so future attendance posts have the displayName tier of host detection
 *     populated.
 *  2. Strip the `.ink-canvas-parent {` CSS-leak participant row.
 *  3. Merge the "KatKat" duplicate row into "Kat".
 *  4. Stamp `actualEnd` and emit a `meeting_ended` SchedulingEvent +
 *     fireMeetingLifecycleAutomations so the post-meeting automation chain
 *     finally fires (the live extension never sent isFinal=true).
 */
import { PrismaClient } from '@prisma/client'
import { logSchedulingEvent } from '../src/lib/scheduling'
import { fireMeetingLifecycleAutomations } from '../src/lib/automation'
import { ensureHostIdentity } from '../src/lib/meet/sync-on-read'

const prisma = new PrismaClient()
const MEETING_CODE = 'xcr-paay-dfi'

type StoredParticipant = {
  email: string | null
  displayName: string | null
  isSelf?: boolean
  joinTime?: string
  leaveTime?: string
  totalSecondsPresent?: number
  joinEvents?: string[]
  leaveEvents?: string[]
  source?: string
}

function isPlausibleName(name: string | null): boolean {
  if (!name) return false
  const trimmed = name.trim()
  if (trimmed.length === 0) return false
  if (/^[.{<>#/*]/.test(trimmed)) return false
  if (!new RegExp('[\\p{L}\\p{N}]', 'u').test(trimmed)) return false
  return true
}

function collapseDoubled(s: string): string {
  let out = s.trim()
  if (out.length < 4) return out
  for (let len = Math.floor(out.length / 2); len >= 2; len--) {
    const left = out.slice(0, len)
    const after = out.slice(len).trimStart()
    if (after.toLowerCase() === left.toLowerCase()) return left.trim()
  }
  return out
}

async function main() {
  const meeting = await prisma.interviewMeeting.findFirst({
    where: { meetingCode: MEETING_CODE },
  })
  if (!meeting) {
    console.log(`No meeting found for code ${MEETING_CODE}`)
    return
  }
  console.log('Found meeting', meeting.id, 'sessionId', meeting.sessionId)

  console.log('\n[1] Backfilling googleDisplayName via ensureHostIdentity...')
  await ensureHostIdentity(meeting.workspaceId)
  const integAfter = await prisma.googleIntegration.findUnique({
    where: { workspaceId: meeting.workspaceId },
    select: { googleEmail: true, googleDisplayName: true },
  })
  console.log('  integration now:', integAfter)

  console.log('\n[2-3] Cleaning participants[] ...')
  const existing: StoredParticipant[] = Array.isArray(meeting.participants)
    ? (meeting.participants as unknown as StoredParticipant[])
    : []
  console.log('  before:', existing.length, 'rows')
  for (const p of existing) console.log('   -', p.displayName, '/', p.email, '/', p.totalSecondsPresent + 's')

  // Drop garbage names, then merge by collapsed displayName key.
  const byKey = new Map<string, StoredParticipant>()
  for (const p of existing) {
    if (p.email) {
      const key = `e:${p.email.toLowerCase()}`
      byKey.set(key, p)
      continue
    }
    if (!isPlausibleName(p.displayName)) {
      console.log(`   ✗ dropping garbage row: "${p.displayName}"`)
      continue
    }
    const sanitized = collapseDoubled((p.displayName || '').trim()).toLowerCase()
    const key = `n:${sanitized}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, { ...p, displayName: collapseDoubled(p.displayName || '') })
      continue
    }
    console.log(`   ↣ merging "${p.displayName}" into "${prev.displayName}"`)
    byKey.set(key, {
      ...prev,
      joinTime: minIso(prev.joinTime, p.joinTime),
      leaveTime: maxIso(prev.leaveTime, p.leaveTime),
      totalSecondsPresent: Math.max(prev.totalSecondsPresent ?? 0, p.totalSecondsPresent ?? 0),
      joinEvents: dedupe([...(prev.joinEvents || []), ...(p.joinEvents || [])]),
      leaveEvents: dedupe([...(prev.leaveEvents || []), ...(p.leaveEvents || [])]),
    })
  }
  const cleaned = Array.from(byKey.values())
  console.log('  after:', cleaned.length, 'rows')
  for (const p of cleaned) console.log('   ✓', p.displayName, '/', p.email, '/', p.totalSecondsPresent + 's')

  const endAt = meeting.scheduledEnd
  await prisma.interviewMeeting.update({
    where: { id: meeting.id },
    data: {
      participants: cleaned as unknown as object,
      actualEnd: meeting.actualEnd ?? endAt,
    },
  })

  console.log('\n[4] Emitting meeting_ended + firing automations...')
  const alreadyEnded = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId: meeting.sessionId,
      eventType: 'meeting_ended',
      metadata: { path: ['interviewMeetingId'], equals: meeting.id },
    },
    select: { id: true },
  })
  if (alreadyEnded) {
    console.log('  meeting_ended already exists — skip')
  } else {
    await logSchedulingEvent({
      sessionId: meeting.sessionId,
      eventType: 'meeting_ended',
      metadata: {
        interviewMeetingId: meeting.id,
        meetingCode: meeting.meetingCode,
        source: 'cron_heartbeat_timeout',
        at: endAt.toISOString(),
        manual: 'fix-xcr-meeting.ts',
      },
    })
    await fireMeetingLifecycleAutomations(meeting.sessionId, 'meeting_ended')
    console.log('  ✓ meeting_ended fired')
  }

  console.log('\nDone.')
}

function minIso(a?: string, b?: string) {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}
function maxIso(a?: string, b?: string) {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}
function dedupe(xs: string[]) {
  return Array.from(new Set(xs.filter(Boolean))).sort()
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
