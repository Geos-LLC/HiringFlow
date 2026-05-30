/**
 * Audit the scheduling funnel for Spotless Homes workspace:
 *   1. link_clicked SchedulingEvents in the last 30 days
 *   2. classify per session: clicked + scheduled vs clicked + no meeting
 *   3. for the no-meeting cohort, surface details — last-click age, status,
 *      and any free_busy_failed / oauth signal on the workspace
 *   4. dump workspace integration health
 */
import { PrismaClient } from '@prisma/client'

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'

async function main() {
  const prisma = new PrismaClient()
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  // 1. link_clicked events in the last 30 days, scoped to this workspace
  const clicks = await prisma.schedulingEvent.findMany({
    where: {
      eventType: 'link_clicked',
      eventAt: { gte: since },
      session: { workspaceId: WORKSPACE_ID },
    },
    select: {
      sessionId: true, eventAt: true, metadata: true, schedulingConfigId: true,
    },
    orderBy: { eventAt: 'asc' },
  })
  console.log(`link_clicked events (last 30d, workspace): ${clicks.length}`)

  // 2. For each clicker session, check whether a meeting got scheduled
  const sessionIds = [...new Set(clicks.map((c) => c.sessionId))]
  console.log(`Unique clicker sessions: ${sessionIds.length}\n`)

  const scheduledEvents = await prisma.schedulingEvent.findMany({
    where: {
      sessionId: { in: sessionIds },
      eventType: { in: ['meeting_scheduled', 'meeting_rescheduled'] },
    },
    select: { sessionId: true },
  })
  const scheduledSet = new Set(scheduledEvents.map((e) => e.sessionId))

  const meetings = await prisma.interviewMeeting.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { sessionId: true },
  })
  const hasMeetingSet = new Set(meetings.map((m) => m.sessionId))

  const noMeetingSessions = sessionIds.filter((id) => !scheduledSet.has(id) && !hasMeetingSet.has(id))

  console.log(`Clicked + scheduled: ${sessionIds.length - noMeetingSessions.length}`)
  console.log(`Clicked + NO meeting: ${noMeetingSessions.length}\n`)

  // 3. Detail on no-meeting clickers
  console.log('=== CLICKED BUT NO MEETING ===')
  const clicksBySession = new Map<string, typeof clicks>()
  for (const c of clicks) {
    if (!clicksBySession.has(c.sessionId)) clicksBySession.set(c.sessionId, [])
    clicksBySession.get(c.sessionId)!.push(c)
  }

  // sort by most-recent click
  const sorted = noMeetingSessions
    .map((id) => ({ id, latestClick: clicksBySession.get(id)!.slice(-1)[0].eventAt }))
    .sort((a, b) => b.latestClick.getTime() - a.latestClick.getTime())

  for (const { id, latestClick } of sorted) {
    const session = await prisma.session.findUnique({
      where: { id },
      select: {
        candidateName: true, candidateEmail: true,
        pipelineStatus: true, status: true, dispositionReason: true,
        finishedAt: true,
        flow: { select: { name: true } },
      },
    })
    const clicksForSession = clicksBySession.get(id)!
    const ageHours = (Date.now() - latestClick.getTime()) / 36e5
    const schedulingConfigIds = [...new Set(clicksForSession.map((c) => c.schedulingConfigId).filter(Boolean))]
    console.log(`\n  ${id}  ${session?.candidateName} <${session?.candidateEmail}>`)
    console.log(`    flow="${session?.flow?.name}" pipelineStatus=${session?.pipelineStatus} status=${session?.status} dispo=${session?.dispositionReason ?? '-'}`)
    console.log(`    clicks=${clicksForSession.length} firstAt=${clicksForSession[0].eventAt.toISOString()} latestAt=${latestClick.toISOString()} (${ageHours.toFixed(1)}h ago)`)
    console.log(`    schedulingConfigs touched: ${schedulingConfigIds.join(', ') || '-'}`)

    // Look for any error-flavored SchedulingEvents on this session
    const errorish = await prisma.schedulingEvent.findMany({
      where: {
        sessionId: id,
        eventType: { in: ['free_busy_failed', 'booking_failed', 'oauth_revoked', 'no_slots'] },
      },
      select: { eventType: true, eventAt: true, metadata: true },
    }).catch(() => [])
    if (errorish.length > 0) {
      for (const e of errorish) {
        console.log(`    ⚠ ${e.eventAt.toISOString()} ${e.eventType} meta=${JSON.stringify(e.metadata).slice(0, 160)}`)
      }
    }
  }

  // 4. Workspace integration health
  console.log()
  console.log('=== WORKSPACE INTEGRATION HEALTH ===')
  const integrations = await prisma.workspaceIntegration.findMany({
    where: { workspaceId: WORKSPACE_ID },
  })
  for (const i of integrations) {
    const obj = i as Record<string, any>
    console.log(`  ${obj.provider} <${obj.accountEmail ?? '-'}>`)
    console.log(`    status=${obj.status ?? '-'}`)
    console.log(`    lastSyncedAt=${obj.lastSyncedAt?.toISOString() ?? '-'}`)
    console.log(`    refreshTokenRevokedAt=${obj.refreshTokenRevokedAt?.toISOString() ?? '-'}`)
    console.log(`    lastError=${obj.lastError ?? '-'} at=${obj.lastErrorAt?.toISOString() ?? '-'}`)
    console.log(`    lastCalendarError=${obj.lastCalendarError ?? '-'}`)
  }

  // 5. Recent admin notifications around booking
  const notifs = await prisma.adminNotification.findMany({
    where: {
      workspaceId: WORKSPACE_ID,
      createdAt: { gte: since },
    },
    select: { kind: true, createdAt: true, payload: true, resolvedAt: true },
    orderBy: { createdAt: 'desc' },
    take: 30,
  }).catch(() => null)
  if (notifs == null) {
    console.log('\n(no AdminNotification model — skipping)')
  } else {
    console.log(`\n=== ADMIN NOTIFICATIONS LAST 30D (${notifs.length}) ===`)
    for (const n of notifs) {
      console.log(`  ${n.createdAt.toISOString()} ${n.kind} resolved=${n.resolvedAt?.toISOString() ?? '-'}`)
      console.log(`    ${JSON.stringify(n.payload).slice(0, 200)}`)
    }
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
