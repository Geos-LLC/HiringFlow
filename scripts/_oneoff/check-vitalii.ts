/**
 * Investigate why Vitalii Cheliadnik did not receive the meeting link
 * Email: vitaliicheliadnik@gmail.com
 * Phone: +380634231626
 * Flow: Dispatcher Flow with speaking test
 */
import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  // Find all sessions for this candidate
  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { candidateEmail: { equals: 'vitaliicheliadnik@gmail.com', mode: 'insensitive' } },
        { candidatePhone: { contains: '380634231626' } },
      ],
    },
    select: {
      id: true,
      candidateEmail: true,
      candidatePhone: true,
      candidateName: true,
      status: true,
      startedAt: true,
      lastActivityAt: true,
      pipelineStatus: true,
      flowId: true,
      workspaceId: true,
      flow: { select: { name: true } },
    },
    orderBy: { startedAt: 'desc' },
  })

  console.log(`Found ${sessions.length} session(s) for Vitalii Cheliadnik:\n`)
  for (const s of sessions) {
    console.log(`Session ID: ${s.id}`)
    console.log(`  Flow: ${s.flow?.name ?? '(none)'}`)
    console.log(`  Email: ${s.candidateEmail}  Phone: ${s.candidatePhone}`)
    console.log(`  Status: ${s.status}  pipelineStatus: ${s.pipelineStatus ?? '-'}`)
    console.log(`  Started: ${s.startedAt.toISOString()}  LastActivity: ${s.lastActivityAt?.toISOString() ?? '-'}`)
    console.log(`  workspaceId: ${s.workspaceId}\n`)

    // Capture responses
    const captures = await prisma.captureResponse.findMany({
      where: { sessionId: s.id },
      orderBy: { id: 'asc' },
    })
    console.log(`  CaptureResponses (${captures.length}):`)
    for (const c of captures) {
      console.log(`    ${JSON.stringify({ id: (c as any).id, mode: (c as any).mode, status: (c as any).status, createdAt: (c as any).createdAt, completedAt: (c as any).completedAt, finalizedAt: (c as any).finalizedAt })}`)
    }

    // Candidate submissions (legacy video flow)
    const subs = await prisma.candidateSubmission.findMany({
      where: { sessionId: s.id },
    })
    console.log(`  CandidateSubmissions (${subs.length}):`)
    for (const c of subs) {
      console.log(`    ${JSON.stringify({ id: (c as any).id, videoStorageKey: (c as any).videoStorageKey ? 'YES' : 'NO' })}`)
    }

    // Automation executions
    const executions = await prisma.automationExecution.findMany({
      where: { sessionId: s.id },
      include: {
        automationRule: { select: { id: true, name: true, triggerType: true, isActive: true } },
        step: true,
      },
    })
    console.log(`  AutomationExecutions (${executions.length}):`)
    for (const e of executions as any[]) {
      console.log(`    ${JSON.stringify({
        rule: e.automationRule?.name, trigger: e.automationRule?.triggerType, isActive: e.automationRule?.isActive,
        stepOrder: e.step?.order, stepType: e.step?.nextStepType, delayMinutes: e.step?.delayMinutes, schedulingConfigId: e.step?.schedulingConfigId,
        channel: e.channel, status: e.status, skipReason: e.skipReason, errorMessage: e.errorMessage,
        createdAt: e.createdAt, sentAt: e.sentAt, deliveryStatus: e.deliveryStatus,
      })}`)
    }

    // Interview meetings
    const meetings = await prisma.interviewMeeting.findMany({
      where: { sessionId: s.id },
    })
    console.log(`  InterviewMeetings (${meetings.length}):`)
    for (const m of meetings as any[]) {
      console.log(`    ${JSON.stringify({ id: m.id, status: m.status, scheduledStart: m.scheduledStart, meetUri: m.meetUri, recordingState: m.recordingState })}`)
    }

    // Training enrollments
    const enrollments = await prisma.trainingEnrollment.findMany({
      where: { sessionId: s.id },
      include: { training: { select: { title: true } } },
    })
    console.log(`  TrainingEnrollments (${enrollments.length}):`)
    for (const t of enrollments as any[]) {
      console.log(`    "${t.training?.title}" completed=${t.completedAt ?? '-'}`)
    }
    console.log('')
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
