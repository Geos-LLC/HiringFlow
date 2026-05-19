/**
 * One-off remediation for Kateryna's 2026-05-18 12:00pm meeting where the
 * HF Meet Tracker fired meeting_no_show at scheduledStart+4min (the host had
 * closed/switched the tracked tab) while the candidate was about to join.
 *
 *   1. Deletes the bogus meeting_no_show SchedulingEvent.
 *   2. Resets Session.status='active', clears dispositionReason / rejectionReason
 *      / lostAt / automationsHaltedAt.
 *   3. Reverts pipelineStatus to her pre-no_show stage (stage_5).
 *   4. Clears InterviewMeeting.meetApiSyncedAt + driveRecordingFileId so the
 *      next /api/candidates/[id]/interview-meetings request re-runs the Drive
 *      scan (now with no candidate-name filter) and re-picks the longest
 *      recording in the meeting window — recovering the actual conversation
 *      mp4 if Meet generated one.
 *
 * Idempotent (re-runs that find nothing to clean up are no-ops).
 */

import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const sessionId = '9b985e9c-4668-4424-b76d-b225c9bdec61'
  const meetingId = '8730c3c0-bc6f-4216-804b-a29dba782811'

  // 1. Delete the spurious meeting_no_show event for this meeting.
  const noShowEvents = await prisma.schedulingEvent.findMany({
    where: {
      sessionId,
      eventType: 'meeting_no_show',
      metadata: { path: ['interviewMeetingId'], equals: meetingId },
    },
    select: { id: true, eventAt: true, metadata: true },
  })
  console.log(`Found ${noShowEvents.length} meeting_no_show events for this meeting`)
  for (const ev of noShowEvents) {
    console.log(`  deleting ${ev.id} (${ev.eventAt.toISOString()}) source=${(ev.metadata as any)?.source}`)
  }
  if (noShowEvents.length > 0) {
    await prisma.schedulingEvent.deleteMany({
      where: { id: { in: noShowEvents.map((e) => e.id) } },
    })
  }

  // 2 + 3. Reset Session lifecycle.
  const before = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { status: true, dispositionReason: true, rejectionReason: true, lostAt: true, pipelineStatus: true, automationsHaltedAt: true, automationsHaltedReason: true },
  })
  console.log('\nBefore:', JSON.stringify(before, null, 2))

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      status: 'active',
      dispositionReason: null,
      rejectionReason: null,
      rejectionReasonAt: null,
      lostAt: null,
      pipelineStatus: 'stage_5',
      automationsHaltedAt: null,
      automationsHaltedReason: null,
    },
  })

  // Audit the manual reset in PipelineStatusChange so the candidate-detail
  // timeline reflects it.
  await prisma.pipelineStatusChange.create({
    data: {
      sessionId,
      fromStatus: 'rejected',
      toStatus: 'stage_5',
      source: 'manual:remediation:bogus_no_show',
      metadata: {
        reason: 'meeting_no_show fired before candidate joined; meeting actually happened',
        interviewMeetingId: meetingId,
      } as any,
    },
  })

  // 4. Force re-sync to re-pick the recording with the wider Drive search.
  await prisma.interviewMeeting.update({
    where: { id: meetingId },
    data: {
      meetApiSyncedAt: null,
      // Clear the primary pointer so the next sync's pickPrimaryRecording
      // result writes through (otherwise the 1.5× size guard governs; this
      // gives the next sync a clean slate).
      driveRecordingFileId: null,
      recordingState: 'processing',
    },
  })

  const after = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { status: true, dispositionReason: true, rejectionReason: true, lostAt: true, pipelineStatus: true },
  })
  console.log('\nAfter:', JSON.stringify(after, null, 2))
  console.log('\nDone. Reload Kateryna\'s candidate page in the dashboard to trigger a fresh Drive scan and re-link the recording.')

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
