/**
 * Find candidates in the Cleaner pipeline who clicked a scheduling link but
 * never scheduled a meeting. Pulls integration health signals (oauth markers,
 * recent free_busy_failed notifications) so we can tell "candidate ghosted"
 * from "scheduling page was broken at the time".
 */
import { PrismaClient } from '@prisma/client'

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'
const CLEANER_PIPELINE_ID = '418cac55-be00-4412-bf57-1412bf54218a'

async function main() {
  const prisma = new PrismaClient()

  // ── 1. Pull all flows in the Cleaner pipeline ─────────────────────────
  const flows = await prisma.flow.findMany({
    where: { workspaceId: WORKSPACE_ID, pipelineId: CLEANER_PIPELINE_ID },
    select: { id: true, name: true, slug: true, isPublished: true },
  })
  console.log(`Cleaner pipeline has ${flows.length} flow(s):`)
  for (const f of flows) console.log(`  ${f.id}  "${f.name}" (slug=${f.slug}) published=${f.isPublished}`)
  console.log()

  const flowIds = flows.map((f) => f.id)
  if (flowIds.length === 0) {
    console.log('No flows in Cleaner pipeline. Bailing out.')
    await prisma.$disconnect()
    return
  }

  // ── 2. SchedulingEvents in Cleaner pipeline (last 30 days) ────────────
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const events = await prisma.schedulingEvent.findMany({
    where: {
      eventAt: { gte: since },
      session: { flowId: { in: flowIds } },
    },
    select: {
      sessionId: true, eventType: true, eventAt: true, metadata: true,
    },
    orderBy: { eventAt: 'asc' },
  })

  // Bucket by session
  type Bucket = {
    sessionId: string
    clicks: typeof events
    scheduled: typeof events
    rescheduled: typeof events
    cancelled: typeof events
    other: typeof events
  }
  const bySession = new Map<string, Bucket>()
  for (const e of events) {
    let b = bySession.get(e.sessionId)
    if (!b) {
      b = { sessionId: e.sessionId, clicks: [], scheduled: [], rescheduled: [], cancelled: [], other: [] }
      bySession.set(e.sessionId, b)
    }
    if (e.eventType === 'link_clicked') b.clicks.push(e)
    else if (e.eventType === 'meeting_scheduled') b.scheduled.push(e)
    else if (e.eventType === 'meeting_rescheduled') b.rescheduled.push(e)
    else if (e.eventType === 'meeting_cancelled') b.cancelled.push(e)
    else b.other.push(e)
  }

  // ── 3. Classify ────────────────────────────────────────────────────────
  const clickedButNoMeeting: Bucket[] = []
  const clickedAndScheduled: Bucket[] = []
  for (const b of bySession.values()) {
    if (b.clicks.length === 0) continue
    if (b.scheduled.length === 0 && b.rescheduled.length === 0) clickedButNoMeeting.push(b)
    else clickedAndScheduled.push(b)
  }

  console.log(`Last 30 days, Cleaner pipeline:`)
  console.log(`  Sessions with ≥1 link_clicked: ${bySession.size}`)
  console.log(`  Clicked AND scheduled: ${clickedAndScheduled.length}`)
  console.log(`  Clicked but NO meeting: ${clickedButNoMeeting.length}`)
  console.log()

  // ── 4. Detail on those who clicked but never scheduled ────────────────
  console.log('=== CLICKED BUT NEVER SCHEDULED ===')
  clickedButNoMeeting.sort((a, b) => b.clicks[b.clicks.length - 1].eventAt.getTime() - a.clicks[a.clicks.length - 1].eventAt.getTime())
  for (const b of clickedButNoMeeting) {
    const session = await prisma.session.findUnique({
      where: { id: b.sessionId },
      select: { candidateName: true, candidateEmail: true, candidatePhone: true, pipelineStatus: true, status: true, dispositionReason: true, finishedAt: true, automationsHaltedAt: true, automationsHaltedReason: true },
    })
    const lastClick = b.clicks[b.clicks.length - 1].eventAt
    const ageHours = (Date.now() - lastClick.getTime()) / 36e5
    console.log(`\n  ${b.sessionId}`)
    console.log(`    ${session?.candidateName} <${session?.candidateEmail}> ${session?.candidatePhone ?? ''}`)
    console.log(`    pipelineStatus=${session?.pipelineStatus} status=${session?.status} dispo=${session?.dispositionReason ?? '-'}`)
    console.log(`    halted=${session?.automationsHaltedAt?.toISOString() ?? '-'} reason=${session?.automationsHaltedReason ?? '-'}`)
    console.log(`    clicks=${b.clicks.length} (latest ${lastClick.toISOString()}, ${ageHours.toFixed(1)}h ago) other_events=${b.other.length}`)
    if (b.other.length > 0) {
      for (const o of b.other.slice(-5)) {
        console.log(`      ${o.eventAt.toISOString()} ${o.eventType}${o.metadata ? ' ' + JSON.stringify(o.metadata).slice(0, 140) : ''}`)
      }
    }
  }

  // ── 5. Workspace integration health markers ───────────────────────────
  console.log()
  console.log('=== WORKSPACE INTEGRATION HEALTH ===')
  const integrations = await prisma.workspaceIntegration.findMany({
    where: { workspaceId: WORKSPACE_ID },
    select: { provider: true, accountEmail: true, scopes: true, lastError: true, lastErrorAt: true, lastSyncedAt: true, status: true, refreshTokenRevokedAt: true },
  })
  for (const i of integrations) {
    console.log(`  ${i.provider} <${i.accountEmail ?? '-'}>`)
    console.log(`    status=${i.status} lastSyncedAt=${(i as any).lastSyncedAt?.toISOString() ?? '-'} refreshTokenRevokedAt=${(i as any).refreshTokenRevokedAt?.toISOString() ?? '-'}`)
    console.log(`    lastError=${i.lastError ?? '-'} at=${i.lastErrorAt?.toISOString() ?? '-'}`)
  }

  // ── 6. Recent admin notifications for booking failures ────────────────
  const notifs = await prisma.adminNotification.findMany({
    where: {
      workspaceId: WORKSPACE_ID,
      createdAt: { gte: since },
      OR: [
        { kind: { contains: 'free_busy' } },
        { kind: { contains: 'oauth' } },
        { kind: { contains: 'booking' } },
        { kind: { contains: 'integration' } },
      ],
    },
    select: { kind: true, createdAt: true, payload: true, resolvedAt: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  }).catch(() => [])
  console.log()
  console.log(`=== RECENT BOOKING/AUTH NOTIFICATIONS (${notifs.length}) ===`)
  for (const n of notifs) {
    console.log(`  ${n.createdAt.toISOString()} ${n.kind} resolved=${n.resolvedAt?.toISOString() ?? '-'}`)
    console.log(`    ${JSON.stringify(n.payload).slice(0, 200)}`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
