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

import { prisma } from '../prisma'

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
