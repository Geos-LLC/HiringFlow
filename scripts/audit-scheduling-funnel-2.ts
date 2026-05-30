/**
 * Wider scheduling-funnel audit: every session that had a scheduling
 * invite sent (or any scheduling-related automation) but never produced
 * a meeting. Distinguishes "ghosted" from "tried to click but failed".
 */
import { PrismaClient } from '@prisma/client'

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'

async function main() {
  const prisma = new PrismaClient()
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  // 1. All invite_sent events (scheduling automations dispatched to candidates)
  const invites = await prisma.schedulingEvent.findMany({
    where: {
      eventType: 'invite_sent',
      eventAt: { gte: since },
      session: { workspaceId: WORKSPACE_ID },
    },
    select: { sessionId: true, eventAt: true, metadata: true, schedulingConfigId: true },
    orderBy: { eventAt: 'desc' },
  })
  console.log(`invite_sent events (last 30d): ${invites.length}`)

  const inviteSessions = [...new Set(invites.map((i) => i.sessionId))]
  console.log(`Unique sessions invited to schedule: ${inviteSessions.length}\n`)

  // 2. Pull all SchedulingEvent activity for these sessions
  const allEvents = await prisma.schedulingEvent.findMany({
    where: { sessionId: { in: inviteSessions } },
    select: { sessionId: true, eventType: true, eventAt: true, metadata: true },
    orderBy: { eventAt: 'asc' },
  })

  // 3. Bucket per session
  type Bucket = Record<string, number>
  const counts = new Map<string, Bucket>()
  const latestInvite = new Map<string, Date>()
  for (const e of allEvents) {
    let c = counts.get(e.sessionId)
    if (!c) { c = {}; counts.set(e.sessionId, c) }
    c[e.eventType] = (c[e.eventType] ?? 0) + 1
    if (e.eventType === 'invite_sent') {
      const cur = latestInvite.get(e.sessionId)
      if (!cur || e.eventAt > cur) latestInvite.set(e.sessionId, e.eventAt)
    }
  }

  // 4. Pull interview meetings for these sessions (some bookings only land in
  // InterviewMeeting because the booking POST writes it directly and the
  // meeting_scheduled event runs via the same path).
  const meetings = await prisma.interviewMeeting.findMany({
    where: { sessionId: { in: inviteSessions } },
    select: { sessionId: true, scheduledStart: true, scheduledEnd: true },
  })
  const meetingsBySession = new Map<string, typeof meetings>()
  for (const m of meetings) {
    if (!meetingsBySession.has(m.sessionId)) meetingsBySession.set(m.sessionId, [])
    meetingsBySession.get(m.sessionId)!.push(m)
  }

  // 5. Classify per session
  let invited = 0, clicked = 0, scheduled = 0, noClick = 0, clickedNoMeeting = 0
  const ghosted: { sessionId: string; invitedAt: Date; latestInvite: Date }[] = []
  const clickedButNoMeeting: { sessionId: string; invitedAt: Date; clicks: number; latestInvite: Date }[] = []

  for (const sessionId of inviteSessions) {
    invited++
    const c = counts.get(sessionId) ?? {}
    const hasClick = (c['link_clicked'] ?? 0) > 0
    const hasScheduled = (c['meeting_scheduled'] ?? 0) > 0 || (meetingsBySession.get(sessionId)?.length ?? 0) > 0

    if (hasClick) clicked++
    if (hasScheduled) scheduled++

    const inv = latestInvite.get(sessionId) ?? since
    if (!hasScheduled && !hasClick) {
      noClick++
      ghosted.push({ sessionId, invitedAt: inv, latestInvite: inv })
    } else if (hasClick && !hasScheduled) {
      clickedNoMeeting++
      clickedButNoMeeting.push({ sessionId, invitedAt: inv, clicks: c['link_clicked'] ?? 0, latestInvite: inv })
    }
  }

  console.log(`Invited to schedule:       ${invited}`)
  console.log(`Of those, clicked:         ${clicked}`)
  console.log(`Of those, scheduled:       ${scheduled}`)
  console.log(`Ghosted (no click):        ${noClick}`)
  console.log(`Clicked but no meeting:    ${clickedNoMeeting}`)
  console.log()

  // 6. Detail the clicked-but-no-meeting cohort
  console.log('=== CLICKED BUT NO MEETING ===')
  clickedButNoMeeting.sort((a, b) => b.latestInvite.getTime() - a.latestInvite.getTime())
  for (const row of clickedButNoMeeting) {
    const s = await prisma.session.findUnique({
      where: { id: row.sessionId },
      select: { candidateName: true, candidateEmail: true, pipelineStatus: true, status: true, dispositionReason: true, flow: { select: { name: true } } },
    })
    const age = (Date.now() - row.latestInvite.getTime()) / 36e5
    console.log(`  ${row.sessionId}  ${s?.candidateName} <${s?.candidateEmail}>`)
    console.log(`    flow="${s?.flow?.name}" pipelineStatus=${s?.pipelineStatus} status=${s?.status} dispo=${s?.dispositionReason ?? '-'}`)
    console.log(`    clicks=${row.clicks} latest invite=${row.latestInvite.toISOString()} (${age.toFixed(1)}h ago)`)
  }

  console.log()
  console.log('=== GHOSTED (invited, never clicked) — last 20 ===')
  ghosted.sort((a, b) => b.latestInvite.getTime() - a.latestInvite.getTime())
  for (const row of ghosted.slice(0, 20)) {
    const s = await prisma.session.findUnique({
      where: { id: row.sessionId },
      select: { candidateName: true, candidateEmail: true, pipelineStatus: true, status: true, dispositionReason: true, flow: { select: { name: true } } },
    })
    const age = (Date.now() - row.latestInvite.getTime()) / 36e5
    console.log(`  ${row.sessionId}  ${s?.candidateName} <${s?.candidateEmail}>`)
    console.log(`    flow="${s?.flow?.name}" pipelineStatus=${s?.pipelineStatus} status=${s?.status} dispo=${s?.dispositionReason ?? '-'}`)
    console.log(`    invite=${row.latestInvite.toISOString()} (${age.toFixed(1)}h ago)`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
