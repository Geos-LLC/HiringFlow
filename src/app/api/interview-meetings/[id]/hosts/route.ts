/**
 * PUT /api/interview-meetings/[id]/hosts
 *
 * Replace the set of assigned host WorkspaceMembers on a specific meeting.
 * Called from the candidate-detail InterviewPanel when the recruiter adds or
 * removes a team member from a booked meeting.
 *
 * Body: { memberIds: string[] } — full desired set; anything not in this
 * array is removed. Empty array is valid (drop everyone).
 *
 * Side effects:
 *   - Reconciles Google Calendar event attendees so newly-added hosts get an
 *     invite and removed hosts are dropped. Preserves attendees NOT in the
 *     workspace's host set (candidate, Calendly organizer, other Google
 *     accounts the host manually added on Google's side).
 *   - No-op on the Meet space itself (still RESTRICTED — the attendee list
 *     is what decides join permission).
 *
 * Silently drops member ids that don't belong to the workspace, so a stale
 * picker doesn't fail the save.
 */

import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getAuthedClientForWorkspace } from '@/lib/google'
import {
  resolveHostMembers,
  sendHostAssignmentInvites,
  promoteHostsToCohosts,
  demoteCohosts,
} from '@/lib/scheduling/meeting-hosts'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const meeting = await prisma.interviewMeeting.findFirst({
    where: { id: params.id, workspaceId: ws.workspaceId },
    select: {
      id: true,
      googleCalendarEventId: true,
      meetSpaceName: true,
      hosts: {
        select: {
          workspaceMember: {
            select: { id: true, user: { select: { email: true } } },
          },
        },
      },
    },
  })
  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({})) as { memberIds?: unknown }
  const raw = Array.isArray(body.memberIds) ? body.memberIds : []
  const cleanIds = Array.from(new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0)))

  // Validate: keep only members that actually belong to this workspace.
  const validRows = cleanIds.length > 0
    ? await prisma.workspaceMember.findMany({
        where: { workspaceId: ws.workspaceId, id: { in: cleanIds } },
        select: { id: true },
      })
    : []
  const validIdSet = new Set(validRows.map((r) => r.id))
  const nextIds = cleanIds.filter((id) => validIdSet.has(id))

  // Diff current vs next
  const previousMembers = meeting.hosts.map((h) => h.workspaceMember)
  const previousIds = new Set(previousMembers.map((m) => m.id))
  const previousEmails = new Set(
    previousMembers.map((m) => m.user?.email?.toLowerCase()).filter((v): v is string => !!v),
  )
  const additions = nextIds.filter((id) => !previousIds.has(id))
  const removals = previousMembers.filter((m) => !nextIds.includes(m.id))

  // Replace host rows in a single transaction.
  await prisma.$transaction([
    prisma.interviewMeetingHost.deleteMany({
      where: { interviewMeetingId: meeting.id },
    }),
    ...(nextIds.length > 0
      ? [
          prisma.interviewMeetingHost.createMany({
            data: nextIds.map((memberId) => ({
              interviewMeetingId: meeting.id,
              workspaceMemberId: memberId,
            })),
          }),
        ]
      : []),
  ])

  // Send the HF-controlled "you've been assigned" email to newly-added
  // hosts only (skip existing hosts on repeat saves so they don't get
  // spammed). Runs before the Calendar reconcile — even if Google's API
  // hiccups, the host still knows they're on the meeting.
  if (additions.length > 0) {
    const newHosts = await resolveHostMembers(ws.workspaceId, additions)
    if (newHosts.length > 0) {
      await sendHostAssignmentInvites(meeting.id, newHosts).catch((err) => {
        console.error('[meeting-hosts] sendHostAssignmentInvites failed:', (err as Error).message)
      })
    }
  }

  // Reconcile Google Calendar event attendees + Meet space cohost roles.
  // Failures are non-fatal — the HF host list is what drives notifications
  // regardless; calendar + Meet sync are best-effort.
  try {
    const authed = await getAuthedClientForWorkspace(ws.workspaceId)
    if (authed) {
      const removedEmails = new Set(
        removals.map((m) => m.user?.email?.toLowerCase()).filter((v): v is string => !!v),
      )
      const addedHosts = additions.length > 0
        ? await resolveHostMembers(ws.workspaceId, additions)
        : []

      if (meeting.googleCalendarEventId) {
        const calendar = google.calendar({ version: 'v3', auth: authed.client })
        const existing = await calendar.events.get({
          calendarId: authed.integration.calendarId,
          eventId: meeting.googleCalendarEventId,
        })
        const currentAttendees = existing.data.attendees ?? []
        // Drop the removed hosts (by email) but keep everyone else Google shows
        // on the event (candidate, Calendly organizer, ad-hoc external guests).
        const filtered = currentAttendees.filter((a) => {
          const e = (a.email ?? '').toLowerCase()
          return !e || !removedEmails.has(e)
        })
        const filteredEmails = new Set(
          filtered.map((a) => (a.email ?? '').toLowerCase()).filter(Boolean),
        )
        for (const h of addedHosts) {
          if (!filteredEmails.has(h.email.toLowerCase()) && !previousEmails.has(h.email.toLowerCase())) {
            filtered.push({ email: h.email, ...(h.name ? { displayName: h.name } : {}) })
          }
        }
        await calendar.events.patch({
          calendarId: authed.integration.calendarId,
          eventId: meeting.googleCalendarEventId,
          sendUpdates: 'all',
          requestBody: { attendees: filtered },
        })
      }

      // Sync COHOST role on the Meet space so newly-added hosts can start the
      // meeting and removed hosts lose that authority. Requires meetSpaceName
      // — meetings adopted from external calendars sometimes lack it. Runs
      // independent of the calendar patch above so a calendar API hiccup
      // doesn't block the cohost sync.
      if (meeting.meetSpaceName) {
        if (addedHosts.length > 0) {
          await promoteHostsToCohosts(authed.client, meeting.meetSpaceName, addedHosts)
        }
        if (removedEmails.size > 0) {
          await demoteCohosts(authed.client, meeting.meetSpaceName, Array.from(removedEmails))
        }
      }
    }
  } catch (err) {
    console.warn('[meeting-hosts] calendar reconcile failed (non-fatal):', (err as Error).message)
  }

  return NextResponse.json({ ok: true, memberIds: nextIds })
}
