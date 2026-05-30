import { PrismaClient } from '@prisma/client'

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'
const SCHED_CONFIG_ID = '688f70b6-450f-4163-9106-3d5fa937134f'

async function main() {
  const prisma = new PrismaClient()

  console.log('=== GOOGLE INTEGRATION ===')
  const gi = await prisma.googleIntegration.findUnique({ where: { workspaceId: WORKSPACE_ID } })
  if (!gi) {
    console.log('  (no GoogleIntegration row — workspace not connected to Google)')
  } else {
    const obj = gi as Record<string, any>
    console.log(`  googleEmail=${obj.googleEmail}`)
    console.log(`  calendarId=${obj.calendarId}`)
    console.log(`  lastSyncedAt=${obj.lastSyncedAt?.toISOString() ?? '-'}`)
    const ageDays = obj.lastSyncedAt ? (Date.now() - obj.lastSyncedAt.getTime()) / 86400000 : null
    if (ageDays != null) console.log(`    (${ageDays.toFixed(1)} days ago)`)
    console.log(`  accessExpiresAt=${obj.accessExpiresAt?.toISOString() ?? '-'}`)
    console.log(`  watchExpiresAt=${obj.watchExpiresAt?.toISOString() ?? '-'}`)
    console.log(`  grantedScopes=${obj.grantedScopes ?? '-'}`)
    console.log(`  recordingCapable=${obj.recordingCapable}  reason=${obj.recordingCapabilityReason}  at=${obj.recordingCapabilityCheckedAt?.toISOString() ?? '-'}`)
    console.log(`  transcriptionCapable=${obj.transcriptionCapable}  reason=${obj.transcriptionCapabilityReason}`)
    console.log(`  refreshTokenLen=${obj.refreshToken ? obj.refreshToken.length : 0} accessTokenLen=${obj.accessToken ? obj.accessToken.length : 0}`)
  }

  console.log()
  console.log('=== SCHEDULING CONFIG ===')
  const sc = await prisma.schedulingConfig.findUnique({ where: { id: SCHED_CONFIG_ID } })
  if (sc) {
    const obj = sc as Record<string, any>
    console.log(`  name=${obj.name}  active=${obj.isActive}  useBuiltIn=${obj.useBuiltInScheduler}`)
    console.log(`  durationMinutes=${obj.durationMinutes} timezone=${obj.timezone}`)
    console.log(`  schedulingUrl=${obj.schedulingUrl ?? '-'}`)
    console.log(`  freebusyCalendarIds=${JSON.stringify(obj.freebusyCalendarIds)}`)
    console.log(`  hostCalendarId=${obj.hostCalendarId ?? '-'}`)
    console.log(`  availabilityHours=${JSON.stringify(obj.availabilityHours).slice(0, 200)}`)
    console.log(`  minNoticeMinutes=${obj.minNoticeMinutes} maxDaysAhead=${obj.maxDaysAhead}`)
  } else {
    console.log('  (not found)')
  }

  // Recent SchedulingEvents tagged free_busy_failed / booking errors
  console.log()
  console.log('=== ANY free_busy_failed / oauth events in SchedulingEvents ===')
  const errs = await prisma.schedulingEvent.findMany({
    where: {
      eventType: { in: ['free_busy_failed', 'booking_failed', 'oauth_revoked'] },
      eventAt: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    },
    select: { sessionId: true, eventType: true, eventAt: true, metadata: true },
    orderBy: { eventAt: 'desc' },
    take: 20,
  }).catch((e) => { console.error('query err:', (e as Error).message); return [] })
  console.log(`  found ${errs.length} error events`)
  for (const e of errs) console.log(`  ${e.eventAt.toISOString()} session=${e.sessionId} ${e.eventType}`)

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
