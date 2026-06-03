import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { logSchedulingEvent, updatePipelineStatus } from '@/lib/scheduling'
import { fireMeetingScheduledAutomations } from '@/lib/automation'
import { emitAutomationEvent } from '@/lib/automation-emit'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const session = await prisma.session.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { scheduledAt, meetingUrl, notes, schedulingConfigId } = await request.json()
  if (!scheduledAt || isNaN(new Date(scheduledAt).getTime())) {
    return NextResponse.json({ error: 'Valid scheduledAt (ISO string) required' }, { status: 400 })
  }

  let configId: string | null = schedulingConfigId || null
  if (!configId) {
    const defaultConfig = await prisma.schedulingConfig.findFirst({
      where: { workspaceId: ws.workspaceId, isActive: true, isDefault: true },
      select: { id: true },
    })
    configId = defaultConfig?.id || null
  }

  await logSchedulingEvent({
    sessionId: params.id,
    schedulingConfigId: configId,
    eventType: 'meeting_scheduled',
    metadata: {
      scheduledAt: new Date(scheduledAt).toISOString(),
      meetingUrl: meetingUrl || null,
      notes: notes || null,
      source: 'manual',
      loggedBy: ws.userId,
    },
  })

  await updatePipelineStatus(params.id, 'scheduled').catch(() => {})

  // Fire any meeting_scheduled automations (e.g., send candidate a confirmation).
  // This manual log-only path doesn't create an InterviewMeeting, so we key
  // off (sessionId, scheduledAt) — re-logging the same schedule time is a
  // no-op, but a recruiter manually re-logging a NEW time produces a new
  // event (and re-fires reminders).
  const scheduledAtIso = new Date(scheduledAt).toISOString()
  await emitAutomationEvent({
    workspaceId: ws.workspaceId,
    sessionId: params.id,
    triggerType: 'meeting_scheduled',
    eventKey: `meeting_scheduled:manual:${params.id}:${scheduledAtIso}`,
    source: 'manual',
    payload: { source: 'manual', scheduledAt: scheduledAtIso, schedulingConfigId: configId, loggedBy: ws.userId },
    dispatch: () => fireMeetingScheduledAutomations(params.id),
  }).catch((err) => {
    console.error('[Schedule-meeting] meeting_scheduled emit failed:', err)
  })

  return NextResponse.json({ success: true })
}
