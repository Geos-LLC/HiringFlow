/**
 * Query the recruiter's connected Google Calendar for events that
 * mention Jacqueline / Daphney / Viktoryia, to determine whether they
 * actually booked through Calendly and the event simply failed to match
 * back to their HiringFlow Session.
 */
import { google } from 'googleapis'
import { getAuthedClientForWorkspace } from '../src/lib/google'

const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20'

const SUSPECTS: { name: string; email: string; clickedAt: Date }[] = [
  { name: 'Jacqueline Williams', email: 'williamsjacqueline2026@gmail.com', clickedAt: new Date('2026-04-30T22:52:54.240Z') },
  { name: 'Daphney Laloy',       email: 'damanshacleaningservices@gmail.com', clickedAt: new Date('2026-05-06T20:02:43.952Z') },
  { name: 'Viktoryia',           email: 'viktoryiavaleisha@gmail.com',        clickedAt: new Date('2026-05-10T01:26:48.981Z') },
]

async function main() {
  const authed = await getAuthedClientForWorkspace(WORKSPACE_ID)
  if (!authed) {
    console.error('No GoogleIntegration for workspace')
    process.exit(1)
  }
  const calendar = google.calendar({ version: 'v3', auth: authed.client })

  for (const s of SUSPECTS) {
    console.log('='.repeat(80))
    console.log(`Looking for ${s.name} <${s.email}>  clickedAt=${s.clickedAt.toISOString()}`)
    // Search a generous window — Calendly may have booked weeks out
    const timeMin = new Date(s.clickedAt.getTime() - 60 * 60_000).toISOString()
    const timeMax = new Date(s.clickedAt.getTime() + 90 * 24 * 60 * 60_000).toISOString()
    console.log(`  scanning ${timeMin} → ${timeMax}`)

    // Query by attendee email
    let byEmail: any[] = []
    try {
      const res: any = await calendar.events.list({
        calendarId: authed.integration.calendarId,
        timeMin,
        timeMax,
        q: s.email,
        singleEvents: true,
        maxResults: 50,
      })
      byEmail = res.data.items ?? []
    } catch (err) {
      console.error(`  events.list by email failed:`, (err as Error).message)
    }

    // Query by name
    let byName: any[] = []
    try {
      const res: any = await calendar.events.list({
        calendarId: authed.integration.calendarId,
        timeMin,
        timeMax,
        q: s.name,
        singleEvents: true,
        maxResults: 50,
      })
      byName = res.data.items ?? []
    } catch (err) {
      console.error(`  events.list by name failed:`, (err as Error).message)
    }

    // Dedupe
    const seen = new Set<string>()
    const all = [...byEmail, ...byName].filter((e) => {
      if (seen.has(e.id)) return false
      seen.add(e.id)
      return true
    })

    if (all.length === 0) {
      console.log(`  → NO matching events found. Candidate clicked but did not book on Calendly.`)
      continue
    }

    console.log(`  → Found ${all.length} matching event(s) — they DID book but HiringFlow missed it:`)
    for (const e of all) {
      console.log(`\n    event=${e.id}  status=${e.status}`)
      console.log(`    summary=${e.summary}`)
      console.log(`    start=${e.start?.dateTime ?? e.start?.date}  end=${e.end?.dateTime ?? e.end?.date}`)
      console.log(`    creator=${e.creator?.email}  organizer=${e.organizer?.email}`)
      console.log(`    attendees=${(e.attendees || []).map((a: any) => `${a.email}(${a.responseStatus})`).join(', ')}`)
      console.log(`    description excerpt: ${(e.description || '').slice(0, 400).replace(/\n/g, ' | ')}`)
      const hasUtm = /utm_content=([a-zA-Z0-9_-]+)/.exec([e.description, e.summary, e.location].filter(Boolean).join(' '))
      console.log(`    utm_content present: ${hasUtm ? hasUtm[1] : 'NO'}`)
      console.log(`    hangoutLink=${e.hangoutLink ?? '-'}`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
