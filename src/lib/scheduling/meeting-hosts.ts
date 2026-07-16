/**
 * Helpers for the "assigned team member hosts" model.
 *
 * A host is a WorkspaceMember who is (a) added to the Google Calendar event
 * as an attendee so they get Google's native invite + reminders and can join
 * the (RESTRICTED) Meet room, and (b) receives HF's own recruiter-side
 * notifications for the meeting (SMS confirm/cancel, no-show alerts, etc.).
 *
 * Assignment flows top-down:
 *   SchedulingConfig.assignedMemberIds  →  seeds  →  InterviewMeetingHost[]
 * Per-meeting overrides live on the InterviewMeetingHost table so a member
 * can be added/removed for one meeting without touching the config default.
 *
 * The workspace's connected Google account is NOT a member — it always owns
 * the calendar + Meet space. We never add its email as an attendee (Google
 * would treat "self" attendees oddly, and it doesn't need an invite for its
 * own calendar).
 */

import type { OAuth2Client } from 'google-auth-library'
import { prisma } from '../prisma'
import { sendEmail } from '../email'
import {
  createSpaceMember,
  deleteSpaceMember,
  listSpaceMembers,
  MeetApiError,
} from '../meet/google-meet'

export interface HostMemberInfo {
  memberId: string
  userId: string
  email: string
  name: string | null
}

/**
 * Resolve a set of WorkspaceMember ids to (memberId, userId, email, name)
 * tuples. Filters out:
 *   - members not in the given workspace (defence against cross-workspace ids)
 *   - members whose user has no email (shouldn't happen — email is required
 *     on User — but we defensively drop them)
 *   - members whose user email equals the workspace's connected Google
 *     account email (adding self as an attendee is a no-op at best and
 *     rejected by Google Calendar at worst)
 */
export async function resolveHostMembers(
  workspaceId: string,
  memberIds: string[],
): Promise<HostMemberInfo[]> {
  const uniqueIds = Array.from(new Set(memberIds.filter((id) => typeof id === 'string' && id.length > 0)))
  if (uniqueIds.length === 0) return []

  const [members, integration] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { id: { in: uniqueIds }, workspaceId },
      select: {
        id: true,
        userId: true,
        user: { select: { email: true, name: true } },
      },
    }),
    prisma.googleIntegration.findUnique({
      where: { workspaceId },
      select: { googleEmail: true },
    }),
  ])

  const connectedEmail = integration?.googleEmail?.toLowerCase() ?? null

  return members
    .filter((m) => !!m.user?.email && (!connectedEmail || m.user.email.toLowerCase() !== connectedEmail))
    .map((m) => ({
      memberId: m.id,
      userId: m.userId,
      email: m.user!.email,
      name: m.user!.name,
    }))
}

/**
 * Look up hosts for a specific InterviewMeeting (per-meeting overrides
 * applied). Used by notification fanout at meeting time.
 */
export async function getMeetingHosts(interviewMeetingId: string): Promise<HostMemberInfo[]> {
  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: interviewMeetingId },
    select: {
      workspaceId: true,
      hosts: {
        select: {
          workspaceMember: {
            select: {
              id: true,
              userId: true,
              user: { select: { email: true, name: true } },
            },
          },
        },
      },
    },
  })
  if (!meeting) return []
  const memberIds = meeting.hosts.map((h) => h.workspaceMember.id)
  return resolveHostMembers(meeting.workspaceId, memberIds)
}

/**
 * Convert a set of resolved hosts to `attendees` entries for
 * `calendar.events.insert` / `events.patch`. Returns undefined when the list
 * is empty so callers can spread it into the requestBody without emitting an
 * `attendees: []` (which Google would treat as "clear all attendees" on
 * events.patch).
 */
export function hostsAsCalendarAttendees(
  hosts: HostMemberInfo[],
  candidateEmail?: string | null,
): Array<{ email: string; displayName?: string }> | undefined {
  const attendees: Array<{ email: string; displayName?: string }> = []
  if (candidateEmail) attendees.push({ email: candidateEmail })
  for (const h of hosts) {
    // De-dup against the candidate slot in case a workspace member has the
    // same email as the candidate (edge case — recruiter testing their own
    // flow).
    if (candidateEmail && h.email.toLowerCase() === candidateEmail.toLowerCase()) continue
    attendees.push({ email: h.email, ...(h.name ? { displayName: h.name } : {}) })
  }
  return attendees.length ? attendees : undefined
}

/**
 * Send an HF-controlled "you've been assigned to an interview" email to each
 * host. Belt-and-suspenders alongside Google Calendar's native invite:
 *   - Google Calendar's `sendUpdates:'all'` reliably sends invites when the
 *     calendar owner is a Google Workspace account. Personal `@gmail.com`
 *     calendar owners frequently get the invite delivery skipped or spam-
 *     filtered — we ran into exactly that gap on 2026-07-14.
 *   - This HF-side email goes through SendGrid (clean deliverability
 *     reputation) and always lands, so the host reliably knows they're on
 *     the meeting even if Google's invite never shows up.
 *
 * Signature is meeting-scoped so we can pull the workspace, session, and
 * meeting fields once and reuse them for every host.
 */
export async function sendHostAssignmentInvites(
  meetingId: string,
  hosts: HostMemberInfo[],
): Promise<void> {
  if (hosts.length === 0) return

  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true,
      meetingUri: true,
      scheduledStart: true,
      scheduledEnd: true,
      workspace: {
        select: {
          id: true,
          name: true,
          timezone: true,
          senderName: true,
          senderEmail: true,
          senderDomain: true,
          senderDomainValidatedAt: true,
          senderVerifiedAt: true,
        },
      },
      session: {
        select: {
          id: true,
          candidateName: true,
          candidateEmail: true,
        },
      },
    },
  })
  if (!meeting) return

  const ws = meeting.workspace
  const tz = ws.timezone || 'America/New_York'
  const meetingTime = meeting.scheduledStart.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: tz, timeZoneName: 'short',
  })

  const candidateLabel = meeting.session.candidateName
    ? `${meeting.session.candidateName}${meeting.session.candidateEmail ? ` <${meeting.session.candidateEmail}>` : ''}`
    : (meeting.session.candidateEmail || 'A candidate')

  const appUrl = process.env.APP_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || process.env.NEXTAUTH_URL
    || 'https://www.hirefunnel.app'
  const candidateLink = `${appUrl}/dashboard/candidates/${meeting.session.id}`
  const brandName = ws.senderName || ws.name || 'HireFunnel'

  // Match executeStep from-selection: only use the workspace sender when it's
  // actually authorized. Otherwise fall through to the platform default so
  // SendGrid still delivers.
  const domainOk = !!(ws.senderDomainValidatedAt && ws.senderDomain && ws.senderEmail && ws.senderEmail.toLowerCase().endsWith('@' + ws.senderDomain.toLowerCase()))
  const singleOk = !!ws.senderVerifiedAt
  const from = (domainOk || singleOk) && ws.senderName && ws.senderEmail
    ? { email: ws.senderEmail, name: ws.senderName }
    : null

  await Promise.all(hosts.map(async (h) => {
    const firstName = (h.name || h.email).split(/[\s@]/)[0]
    const subject = `You've been added to an interview — ${meeting.session.candidateName || 'candidate'} on ${meetingTime}`
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #15171a; max-width: 560px; padding: 24px;">
        <p style="margin: 0 0 12px 0;">Hi ${escapeHtml(firstName)},</p>
        <p style="margin: 0 0 16px 0;">You've been assigned to host an interview with <strong>${escapeHtml(candidateLabel)}</strong>.</p>
        <div style="margin: 0 0 20px 0; padding: 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;">
          <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; margin-bottom: 6px;">When</div>
          <div style="font-size: 15px; margin-bottom: 14px;">${escapeHtml(meetingTime)}</div>
          <a href="${meeting.meetingUri}" style="display: inline-block; padding: 10px 18px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">Join Google Meet</a>
        </div>
        <p style="margin: 0 0 8px 0;">
          <a href="${candidateLink}" style="color: #FF9500; text-decoration: none; font-weight: 500;">Open candidate in HireFunnel →</a>
        </p>
        <p style="margin: 24px 0 0 0; color: #94a3b8; font-size: 12px;">You'll also get Google's calendar invite. This email is HireFunnel's own reminder — some Google accounts skip calendar-invite emails for external attendees, so we send this too.</p>
      </div>
    `.trim()
    const text = [
      `Hi ${firstName},`,
      '',
      `You've been assigned to host an interview with ${candidateLabel}.`,
      '',
      `When: ${meetingTime}`,
      `Join: ${meeting.meetingUri}`,
      '',
      `Candidate in HireFunnel: ${candidateLink}`,
    ].join('\n')

    await sendEmail({
      to: h.email,
      subject,
      html,
      text,
      from,
      workspaceId: ws.id,
    }).catch((err) => console.error('[meeting-hosts] host invite to', h.email, 'failed:', (err as Error).message))
  }))
}

/**
 * Grant each host the Meet COHOST role on the space so they can start the
 * meeting, admit knockers, and end for all — the powers Meet reserves for
 * the space owner by default. Being a calendar attendee only grants
 * "can join"; without cohost promotion the space owner (workspace's
 * connected Google account) is the only one who can actually run the call.
 *
 * Best-effort. Meet returns 403 in two situations we must swallow:
 *   - Personal Gmail owner: the members API is Workspace-only. Same
 *     limitation that already downgrades accessType to TRUSTED for these
 *     accounts (see book-interview.ts).
 *   - Admin policy: the owner's Workspace admin has host-management disabled
 *     for external users. Nothing HireFunnel can do; recruiter must flip the
 *     Google Admin Console setting.
 * 409 = already a member; treat as success.
 *
 * Any failure is logged and dropped — Kate not being a cohost is a
 * degradation, not a booking-blocker.
 */
export async function promoteHostsToCohosts(
  client: OAuth2Client,
  spaceName: string,
  hosts: HostMemberInfo[],
): Promise<void> {
  if (hosts.length === 0) return
  await Promise.all(hosts.map(async (h) => {
    try {
      await createSpaceMember(client, spaceName, h.email, 'COHOST')
    } catch (err) {
      const status = err instanceof MeetApiError ? err.status : 0
      if (status === 409) return
      console.warn('[meeting-hosts] cohost promotion failed for', h.email, ':', (err as Error).message)
    }
  }))
}

/**
 * Revoke COHOST role for the given emails on a Meet space. Used by the
 * per-meeting hosts reconcile route when a host is removed. We look up the
 * member resource by listing the space's members and matching on email
 * (case-insensitive) because HF doesn't store the Meet-side member id.
 *
 * Best-effort — a lingering cohost who's been removed from the calendar
 * attendee list can't join the RESTRICTED meeting anyway, so the worst-case
 * of a failed demotion is harmless.
 */
export async function demoteCohosts(
  client: OAuth2Client,
  spaceName: string,
  emails: string[],
): Promise<void> {
  if (emails.length === 0) return
  const targets = new Set(emails.map((e) => e.toLowerCase()))
  let members: Awaited<ReturnType<typeof listSpaceMembers>>
  try {
    members = await listSpaceMembers(client, spaceName)
  } catch (err) {
    console.warn('[meeting-hosts] listSpaceMembers failed:', (err as Error).message)
    return
  }
  await Promise.all(
    members
      .filter((m) => !!m.email && targets.has(m.email.toLowerCase()))
      .map(async (m) => {
        try {
          await deleteSpaceMember(client, m.name)
        } catch (err) {
          console.warn('[meeting-hosts] cohost demotion failed for', m.email, ':', (err as Error).message)
        }
      }),
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
