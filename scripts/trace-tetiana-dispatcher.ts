/**
 * Diagnose: Tetiana (ianatma@ukr.net / 0685152770) on "Dispatcher Flow with
 * speaking test" — 0s recording, Recall bot reportedly not in the meeting.
 *
 * Checks:
 *  - session(s), workspace recallBotEnabled
 *  - InterviewMeeting: recallBotId, attendanceSource, recordingProvider, state
 *  - SchedulingEvents (meeting_started / ended / no_show / recording_ready)
 *  - InterviewMeetingArtifact rows
 *  - AutomationExecution history for the session
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const EMAIL = 'ianatma@ukr.net'
const PHONE = '0685152770'

async function main() {
  const phoneVariants = [PHONE, `+38${PHONE}`, `38${PHONE}`, `+380${PHONE.replace(/^0/, '')}`]
  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { candidateEmail: { equals: EMAIL, mode: 'insensitive' } },
        { candidatePhone: { in: phoneVariants } },
        { candidateName: { contains: 'Tetiana', mode: 'insensitive' } },
      ],
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, workspaceId: true, flowId: true,
      candidateName: true, candidateEmail: true, candidatePhone: true,
      pipelineStatus: true, status: true, dispositionReason: true,
      startedAt: true, finishedAt: true, lastActivityAt: true,
      flow: { select: { id: true, name: true, slug: true } },
      workspace: { select: { id: true, name: true, recallBotEnabled: true, timezone: true } },
    },
  })

  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`Sessions matching ${EMAIL} OR phone variants OR name~"Tetiana": ${sessions.length}\n`)

  const target = sessions.filter(s => s.candidateEmail?.toLowerCase() === EMAIL && /dispatcher/i.test(s.flow?.name ?? '') && /speaking/i.test(s.flow?.name ?? ''))
  const consider = target.length ? target : sessions.filter(s => s.candidateEmail?.toLowerCase() === EMAIL)

  for (const s of consider) {
    console.log('='.repeat(80))
    console.log(`Session ${s.id}`)
    console.log(`  ${s.candidateName} <${s.candidateEmail}>  phone=${s.candidatePhone ?? '-'}`)
    console.log(`  workspace: ${s.workspace?.name} (${s.workspaceId})  recallBotEnabled=${s.workspace?.recallBotEnabled}  tz=${s.workspace?.timezone}`)
    console.log(`  flow="${s.flow?.name}" slug=${s.flow?.slug}`)
    console.log(`  pipelineStatus=${s.pipelineStatus}  status=${s.status}  dispo=${s.dispositionReason ?? '-'}`)
    console.log(`  startedAt=${s.startedAt.toISOString()}  finishedAt=${s.finishedAt?.toISOString() ?? '-'}  lastActivity=${s.lastActivityAt?.toISOString() ?? '-'}`)

    const meetings = await prisma.interviewMeeting.findMany({
      where: { sessionId: s.id },
      orderBy: { scheduledStart: 'asc' },
    })
    console.log(`\nInterviewMeetings (${meetings.length}):`)
    for (const m of meetings) {
      console.log(`  ${m.id}`)
      console.log(`    scheduled=${m.scheduledStart.toISOString()} → ${m.scheduledEnd.toISOString()}`)
      console.log(`    actual=${m.actualStart?.toISOString() ?? '-'} → ${m.actualEnd?.toISOString() ?? '-'}`)
      console.log(`    confirmed=${m.confirmedAt?.toISOString() ?? '-'}  createdAt=${m.createdAt.toISOString()}`)
      console.log(`    meetingUri=${m.meetingUri}`)
      console.log(`    meetSpaceName=${m.meetSpaceName ?? '-'}  meetingCode=${m.meetingCode ?? '-'}`)
      console.log(`    attendanceSource=${(m as any).attendanceSource ?? '-'}`)
      console.log(`    recallBotId=${(m as any).recallBotId ?? '-'}`)
      console.log(`    recordingProvider=${(m as any).recordingProvider ?? '-'}  recordingState=${(m as any).recordingState ?? '-'}`)
      console.log(`    transcriptState=${(m as any).transcriptState ?? '-'}`)
      console.log(`    driveRecordingFileId=${(m as any).driveRecordingFileId ?? '-'}`)
      console.log(`    driveGeminiNotesFileId=${(m as any).driveGeminiNotesFileId ?? '-'}`)
      console.log(`    attendanceSheetFileId=${(m as any).attendanceSheetFileId ?? '-'}`)
      console.log(`    cancelledAt=${(m as any).cancelledAt?.toISOString() ?? '-'}`)
      const arts = await prisma.interviewMeetingArtifact.findMany({
        where: { interviewMeetingId: m.id },
        orderBy: { discoveredAt: 'asc' },
      })
      console.log(`    artifacts (${arts.length}):`)
      for (const a of arts) {
        console.log(`      - ${a.kind} drive=${a.driveFileId ?? '-'} discovered=${a.discoveredAt.toISOString()} driveCreated=${a.driveCreatedTime?.toISOString() ?? '-'}`)
      }
    }

    const events = await prisma.schedulingEvent.findMany({
      where: { sessionId: s.id },
      orderBy: { eventAt: 'asc' },
      select: { id: true, eventType: true, eventAt: true, metadata: true },
    })
    console.log(`\nSchedulingEvents (${events.length}):`)
    for (const e of events) {
      const meta = e.metadata as Record<string, unknown> | null
      const metaStr = meta ? ` meta=${JSON.stringify(meta).slice(0, 400)}` : ''
      console.log(`  ${e.eventAt.toISOString()}  ${e.eventType}${metaStr}`)
    }

    const execs = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
      include: {
        automationRule: { select: { name: true, triggerType: true, isActive: true } },
        step: { select: { order: true, channel: true, emailDestination: true, emailTemplate: { select: { name: true } } } },
      },
    })
    console.log(`\nAutomationExecutions (${execs.length}):`)
    for (const e of execs) {
      const tmpl = e.step?.channel === 'email' ? (e.step?.emailTemplate?.name ?? '-') : 'sms'
      console.log(`  ${e.createdAt.toISOString()}  rule="${e.automationRule?.name}" trig=${e.automationRule?.triggerType}`)
      console.log(`    step.order=${e.step?.order} ch=${e.channel} tmpl="${tmpl}" status=${e.status} skip=${(e as any).skipReason ?? '-'} err=${e.errorMessage ?? '-'}`)
    }
    console.log()
  }

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
