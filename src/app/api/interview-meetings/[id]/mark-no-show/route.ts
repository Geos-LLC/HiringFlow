/**
 * POST /api/interview-meetings/[id]/mark-no-show
 *
 * Manual fallback for tenants where automatic attendance detection isn't
 * available (personal Gmail / Workspace Individual). Recruiter clicks
 * "Mark as no-show" on the candidate detail page; we run the same downstream
 * pipeline the automated path runs:
 *   - log a meeting_no_show SchedulingEvent (with metadata.source='manual')
 *   - applyStageTrigger('meeting_no_show', legacyStatus='rejected')
 *     → moves to Rejected stage (or builtIn rejected fallback)
 *   - stamp Session.rejectionReason='No-show' + rejectionReasonAt
 *   - fire the workspace's no-show automation rules (follow-up email/SMS)
 *
 * Idempotent: returns success with `alreadyMarked: true` if a meeting_no_show
 * event already exists for this meeting.
 */

import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { logSchedulingEvent } from '@/lib/scheduling'
import { fireMeetingLifecycleAutomations } from '@/lib/automation'
import { emitAutomationEvent, eventKeys } from '@/lib/automation-emit'

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const meeting = await prisma.interviewMeeting.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: { id: true, sessionId: true, workspaceId: true },
  })
  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const existing = await prisma.schedulingEvent.findFirst({
    where: {
      sessionId: meeting.sessionId,
      eventType: 'meeting_no_show',
      metadata: { path: ['interviewMeetingId'], equals: meeting.id },
    },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json({ ok: true, alreadyMarked: true })
  }

  await logSchedulingEvent({
    sessionId: meeting.sessionId,
    eventType: 'meeting_no_show',
    metadata: {
      interviewMeetingId: meeting.id,
      at: new Date().toISOString(),
      source: 'manual',
    },
  })
  await emitAutomationEvent({
    workspaceId: meeting.workspaceId,
    sessionId: meeting.sessionId,
    triggerType: 'meeting_no_show',
    eventKey: eventKeys.meetingNoShow(meeting.id),
    source: 'manual',
    payload: { interviewMeetingId: meeting.id, source: 'manual' },
    dispatch: () => fireMeetingLifecycleAutomations(meeting.sessionId, 'meeting_no_show'),
  }).catch((err) =>
    console.error('[mark-no-show] automation emit failed:', err),
  )

  return NextResponse.json({ ok: true, alreadyMarked: false })
}
