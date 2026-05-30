import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const sid = '17546143-875e-416e-a2c5-74ee215b4c66'
  const mid = 'fe2e4822-f6ab-42bb-bd5e-d4dc493e1ba1'

  const session = await prisma.session.findUnique({
    where: { id: sid },
    select: {
      pipelineStatus: true, status: true, dispositionReason: true,
      stalledAt: true, lostAt: true, hiredAt: true,
      workspaceId: true, workspace: { select: { name: true, settings: true } },
    },
  })
  console.log('=== Session status ===')
  console.log(`  pipelineStatus=${session?.pipelineStatus} status=${session?.status} disposition=${session?.dispositionReason ?? '-'}`)

  const stagesRaw = (session?.workspace?.settings as any)?.funnelStages
  console.log(`\n=== Workspace funnel stages (${session?.workspace?.name}) ===`)
  if (Array.isArray(stagesRaw)) {
    for (const s of stagesRaw) {
      console.log(`  id=${s.id}  label="${s.label}"  triggers=${JSON.stringify(s.triggers ?? [])}`)
    }
  } else { console.log('  (no funnelStages configured)') }

  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: mid },
    select: {
      scheduledStart: true, scheduledEnd: true, actualStart: true, actualEnd: true,
      confirmedAt: true, recordingState: true, rawEvents: true,
      meetingUri: true, googleCalendarEventId: true,
      meetApiSyncedAt: true, workspaceEventsSubName: true,
      workspaceEventsSubExpiresAt: true, spaceAdoptedFromReschedule: true,
    },
  })
  console.log('\n=== InterviewMeeting ===')
  console.log(`  start=${meeting?.scheduledStart.toISOString()} end=${meeting?.scheduledEnd.toISOString()}`)
  console.log(`  actualStart=${meeting?.actualStart?.toISOString() ?? '-'} actualEnd=${meeting?.actualEnd?.toISOString() ?? '-'}`)
  console.log(`  confirmedAt=${meeting?.confirmedAt?.toISOString() ?? '-'} recordingState=${meeting?.recordingState}`)
  console.log(`  googleCalendarEventId=${meeting?.googleCalendarEventId}`)
  console.log(`  workspaceEventsSubName=${meeting?.workspaceEventsSubName} expires=${meeting?.workspaceEventsSubExpiresAt?.toISOString() ?? '-'}`)
  console.log(`  meetApiSyncedAt=${meeting?.meetApiSyncedAt?.toISOString() ?? '-'} adoptedFromReschedule=${meeting?.spaceAdoptedFromReschedule}`)
  const raw = meeting?.rawEvents as any[] | null
  console.log(`  rawEvents count=${Array.isArray(raw) ? raw.length : 0}`)
  if (Array.isArray(raw)) {
    for (const ev of raw.slice(-15)) {
      console.log(`    ${ev.eventType ?? ev.type ?? '?'} t=${ev.eventTime ?? ev.timestamp ?? '?'} ${ev.source ? 'src='+ev.source : ''}`)
    }
  }

  console.log('\n=== Automation rules in this workspace ===')
  const rules = await prisma.automationRule.findMany({
    where: { workspaceId: session?.workspaceId },
    select: {
      id: true, name: true, triggerType: true, minutesBefore: true, isActive: true,
      flow: { select: { name: true } },
      steps: {
        orderBy: { order: 'asc' },
        select: {
          order: true, timingMode: true, delayMinutes: true, channel: true,
          emailDestination: true, smsDestination: true,
          emailTemplate: { select: { name: true, subject: true } },
          smsBody: true,
        },
      },
    },
  })
  for (const r of rules) {
    const flow = r.flow?.name ?? '(any)'
    console.log(`\n  Rule "${r.name}" [trig=${r.triggerType}${r.minutesBefore != null ? ` minutesBefore=${r.minutesBefore}` : ''}] flow=${flow} active=${r.isActive}`)
    for (const st of r.steps) {
      console.log(`    step ${st.order} (${st.timingMode}=${st.delayMinutes}m, ${st.channel})`)
      if (st.channel === 'email' || st.channel === 'both') {
        console.log(`      email "${st.emailTemplate?.name}" subj="${st.emailTemplate?.subject}" dest=${st.emailDestination}`)
      }
      if (st.channel === 'sms' || st.channel === 'both') {
        console.log(`      sms dest=${st.smsDestination} body="${(st.smsBody ?? '').slice(0, 100)}..."`)
      }
    }
  }

  await prisma.$disconnect()
}
main().catch(console.error).finally(() => process.exit(0))
