import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { stopWatch, hasMeetScopes } from '@/lib/google'
import { capabilityMessage } from '@/lib/meet/recording-capability'
import type { RecordingCapabilityReason } from '@/lib/meet/recording-capability'
import { globalKillswitchActive } from '@/lib/meet/feature-flag'

export async function GET() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const integration = await prisma.googleIntegration.findUnique({
    where: { workspaceId: ws.workspaceId },
    select: {
      googleEmail: true,
      calendarId: true,
      watchExpiresAt: true,
      lastSyncedAt: true,
      createdAt: true,
      grantedScopes: true,
      hostedDomain: true,
      recordingCapable: true,
      recordingCapabilityReason: true,
      recordingCapabilityCheckedAt: true,
      transcriptionCapable: true,
      transcriptionCapabilityReason: true,
      transcriptionCapabilityCheckedAt: true,
    },
  })

  const workspace = await prisma.workspace.findUnique({
    where: { id: ws.workspaceId },
    select: { meetIntegrationV2Enabled: true },
  })

  const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)

  const meetV2 = integration
    ? {
        flagEnabled: !!workspace?.meetIntegrationV2Enabled && !globalKillswitchActive(),
        scopesGranted: hasMeetScopes(integration.grantedScopes),
        hostedDomain: integration.hostedDomain,
        recordingCapable: integration.recordingCapable,
        recordingCapabilityReason: integration.recordingCapabilityReason as RecordingCapabilityReason | null,
        recordingCapabilityMessage: capabilityMessage(integration.recordingCapabilityReason as RecordingCapabilityReason | null),
        recordingCapabilityCheckedAt: integration.recordingCapabilityCheckedAt,
        transcriptionCapable: integration.transcriptionCapable,
        transcriptionCapabilityReason: integration.transcriptionCapabilityReason as RecordingCapabilityReason | null,
        transcriptionCapabilityMessage: capabilityMessage(integration.transcriptionCapabilityReason as RecordingCapabilityReason | null),
        transcriptionCapabilityCheckedAt: integration.transcriptionCapabilityCheckedAt,
      }
    : null

  return NextResponse.json({
    configured,
    connected: !!integration,
    integration: integration && {
      googleEmail: integration.googleEmail,
      calendarId: integration.calendarId,
      watchExpiresAt: integration.watchExpiresAt,
      lastSyncedAt: integration.lastSyncedAt,
      createdAt: integration.createdAt,
    },
    meetV2,
  })
}

export async function DELETE() {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  await stopWatch(ws.workspaceId).catch(() => {})
  await prisma.googleIntegration.delete({ where: { workspaceId: ws.workspaceId } }).catch(() => {})

  return NextResponse.json({ success: true })
}
