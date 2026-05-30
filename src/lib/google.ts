import { google } from 'googleapis'
import { randomBytes } from 'crypto'
import { prisma } from './prisma'
import { encrypt, decrypt } from './crypto'

// Legacy read-only scopes used by the pre-Meet-v2 Calendar sync path. Kept as
// the minimum consent set so existing connected workspaces keep working.
// `userinfo.profile` is required for `name` to come back from oauth2.userinfo —
// without it personal-Gmail integrations end up with googleDisplayName=null,
// which breaks the displayName tier of host detection in attendance posts.
const BASE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

// Scopes required by the Meet integration v2 flow. Additive to the base set —
// requested via incremental consent. Drive access uses drive.meet.readonly as
// the primary, scope-minimal choice; drive.readonly is held as a verified
// fallback behind DRIVE_ARTIFACT_SCOPE_ESCALATION env var.
const MEET_SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/meetings.space.settings',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.meet.readonly',
]

const DRIVE_READONLY_FALLBACK = 'https://www.googleapis.com/auth/drive.readonly'

export function getScopes(): string[] {
  const scopes = [...BASE_SCOPES, ...MEET_SCOPES]
  if (process.env.DRIVE_ARTIFACT_SCOPE_ESCALATION === '1') {
    scopes.push(DRIVE_READONLY_FALLBACK)
  }
  return scopes
}

// Scopes required for the Meet v2 flow to be operational — used by hasMeetScopes.
export const REQUIRED_MEET_SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/meetings.space.settings',
  'https://www.googleapis.com/auth/calendar.events',
]

export function hasMeetScopes(grantedScopes: string | null | undefined): boolean {
  if (!grantedScopes) return false
  const granted = new Set(grantedScopes.split(/\s+/).filter(Boolean))
  return REQUIRED_MEET_SCOPES.every((s) => granted.has(s))
}

export function getAppUrl(): string {
  return process.env.APP_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || process.env.NEXTAUTH_URL
    || 'https://www.hirefunnel.app'
}

function getRedirectUri(): string {
  return process.env.GOOGLE_REDIRECT_URI || `${getAppUrl()}/api/integrations/google/callback`
}

export function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured')
  }
  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri())
}

export function buildConsentUrl(stateToken: string): string {
  return getOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: getScopes(),
    state: stateToken,
    include_granted_scopes: true,
  })
}

export async function exchangeCode(code: string) {
  const client = getOAuthClient()
  const { tokens } = await client.getToken(code)
  if (!tokens.refresh_token) {
    throw new Error('No refresh token returned — user may need to revoke access and re-consent')
  }
  client.setCredentials(tokens)
  // userinfo.get returns { id, email, hd, ... }. 'hd' is present for Google
  // Workspace accounts (hosted domain), absent for free @gmail.com. 'id' is the
  // Google account ID — Workspace Events Meet sends signed-in participants as
  // `users/{id}`, so we capture this here for host detection in no-show eval.
  const { data: userInfo } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get()
  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token || null,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    email: userInfo.email || '',
    userId: userInfo.id || null,
    displayName: (userInfo as { name?: string }).name || null,
    hostedDomain: (userInfo as { hd?: string }).hd || null,
    grantedScopes: tokens.scope || null,
  }
}

/**
 * Lightweight userinfo fetch using an already-authed OAuth2 client. Returns
 * the Google account id + display name so callers can backfill the matching
 * GoogleIntegration columns. Used by the self-heal path on integrations
 * connected before those columns existed.
 */
export async function fetchUserInfo(client: InstanceType<typeof google.auth.OAuth2>): Promise<{ id: string | null; displayName: string | null }> {
  try {
    const { data } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get()
    return {
      id: data.id || null,
      displayName: (data as { name?: string }).name || null,
    }
  } catch (err) {
    console.error('[Google] fetchUserInfo failed:', (err as Error).message)
    return { id: null, displayName: null }
  }
}

/** @deprecated Use fetchUserInfo. Kept for backward compatibility. */
export async function fetchUserId(client: InstanceType<typeof google.auth.OAuth2>): Promise<string | null> {
  const info = await fetchUserInfo(client)
  return info.id
}

export async function getAuthedClientForWorkspace(workspaceId: string) {
  const integration = await prisma.googleIntegration.findUnique({ where: { workspaceId } })
  if (!integration) return null
  const client = getOAuthClient()
  client.setCredentials({
    refresh_token: decrypt(integration.refreshToken),
    access_token: integration.accessToken ? decrypt(integration.accessToken) : undefined,
    expiry_date: integration.accessExpiresAt?.getTime(),
  })
  // googleapis handles refresh automatically when access token expired
  client.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await prisma.googleIntegration.update({
        where: { workspaceId },
        data: {
          accessToken: encrypt(tokens.access_token),
          accessExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        },
      }).catch(() => {})
    }
  })
  return { client, integration }
}

export async function startWatch(workspaceId: string) {
  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) throw new Error('No integration for workspace')
  const { client, integration } = authed

  const calendar = google.calendar({ version: 'v3', auth: client })
  const channelId = randomBytes(16).toString('hex')
  const watchToken = randomBytes(24).toString('hex')
  const webhookUrl = `${getAppUrl()}/api/webhooks/google`

  const res = await calendar.events.watch({
    calendarId: integration.calendarId,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: webhookUrl,
      token: watchToken,
    },
  })

  // Do a proper initial sync — paginate through all events to get a nextSyncToken.
  // Google only returns nextSyncToken on the last page of a full listing.
  let pageToken: string | undefined = undefined
  let nextSyncToken: string | null = null
  const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  for (let i = 0; i < 20; i++) {
    const page: any = await calendar.events.list({
      calendarId: integration.calendarId,
      timeMin,
      showDeleted: true,
      singleEvents: true,
      maxResults: 250,
      pageToken,
    })
    if (page.data.nextSyncToken) { nextSyncToken = page.data.nextSyncToken; break }
    if (!page.data.nextPageToken) break
    pageToken = page.data.nextPageToken
  }

  await prisma.googleIntegration.update({
    where: { workspaceId },
    data: {
      watchChannelId: channelId,
      watchResourceId: res.data.resourceId || null,
      watchToken,
      watchExpiresAt: res.data.expiration ? new Date(Number(res.data.expiration)) : null,
      syncToken: nextSyncToken,
      lastSyncedAt: new Date(),
    },
  })
}

export async function stopWatch(workspaceId: string) {
  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) return
  const { client, integration } = authed
  if (!integration.watchChannelId || !integration.watchResourceId) return

  const calendar = google.calendar({ version: 'v3', auth: client })
  await calendar.channels.stop({
    requestBody: {
      id: integration.watchChannelId,
      resourceId: integration.watchResourceId,
    },
  }).catch((err) => {
    console.error('[Google] stopWatch failed (channel may already be expired):', err?.message)
  })

  await prisma.googleIntegration.update({
    where: { workspaceId },
    data: {
      watchChannelId: null,
      watchResourceId: null,
      watchToken: null,
      watchExpiresAt: null,
    },
  })
}

/**
 * Delete a calendar event by id. Used when a candidate cancels their
 * interview via SMS reply — we delete the recruiter's calendar event so
 * the slot frees up and the recruiter sees the cancellation in Google.
 *
 * Best-effort: 404 / 410 from Google (event already gone) is treated as
 * success. Other errors propagate so the caller can log them.
 */
export async function deleteCalendarEvent(
  workspaceId: string,
  googleCalendarEventId: string,
): Promise<{ deleted: boolean; alreadyGone?: boolean }> {
  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) return { deleted: false }
  if (!hasMeetScopes(authed.integration.grantedScopes)) {
    // No calendar.events scope — older read-only consent. Surface explicitly
    // rather than silently no-oping, so the caller knows the cancel was not
    // mirrored to Google.
    throw new Error('Workspace lacks calendar.events scope; reconnect required to delete events')
  }
  const calendar = google.calendar({ version: 'v3', auth: authed.client })
  try {
    await calendar.events.delete({
      calendarId: authed.integration.calendarId,
      eventId: googleCalendarEventId,
      // Notify attendees so the candidate sees the cancellation in their
      // own Google account too.
      sendUpdates: 'all',
    })
    return { deleted: true }
  } catch (err: unknown) {
    const e = err as { code?: number; status?: number; message?: string }
    if (e.code === 404 || e.code === 410 || e.status === 404 || e.status === 410) {
      return { deleted: false, alreadyGone: true }
    }
    throw err
  }
}

export async function pullChangedEvents(workspaceId: string) {
  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) return { events: [], newSyncToken: null }
  const { client, integration } = authed

  const calendar = google.calendar({ version: 'v3', auth: client })

  // Build the list params. Prefer syncToken (incremental); fall back to
  // timeMin (recent window) if we don't have a syncToken yet. Google
  // disallows passing timeMin + syncToken together.
  const listParams: any = {
    calendarId: integration.calendarId,
    showDeleted: true,
    singleEvents: true,
    maxResults: 250,
  }
  if (integration.syncToken) {
    listParams.syncToken = integration.syncToken
  } else {
    // 7 days back is enough for bookings we care about
    listParams.timeMin = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    listParams.updatedMin = (integration.lastSyncedAt || new Date(Date.now() - 10 * 60_000)).toISOString()
  }

  const runList = async (params: any) => {
    const all: any[] = []
    let pageToken: string | undefined
    let nextSyncToken: string | null = null
    for (let i = 0; i < 20; i++) {
      const page: any = await calendar.events.list({ ...params, pageToken })
      if (page.data.items) all.push(...page.data.items)
      if (page.data.nextSyncToken) { nextSyncToken = page.data.nextSyncToken; break }
      if (!page.data.nextPageToken) break
      pageToken = page.data.nextPageToken
    }
    return { items: all, nextSyncToken }
  }

  console.log(`[Google] pullChangedEvents ws=${workspaceId} mode=${integration.syncToken ? 'incremental' : 'timeMin'}`)

  try {
    const { items, nextSyncToken } = await runList(listParams)
    await prisma.googleIntegration.update({
      where: { workspaceId },
      data: {
        syncToken: nextSyncToken || integration.syncToken,
        lastSyncedAt: new Date(),
      },
    })
    console.log(`[Google] Pulled ${items.length} events ws=${workspaceId}`)
    return { events: items, newSyncToken: nextSyncToken }
  } catch (err: any) {
    // 410 GONE — syncToken invalid, do a full re-sync
    if (err?.code === 410) {
      console.warn('[Google] syncToken invalid — falling back to timeMin re-sync')
      const { items, nextSyncToken } = await runList({
        ...listParams,
        syncToken: undefined,
        timeMin: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        updatedMin: undefined,
      })
      await prisma.googleIntegration.update({
        where: { workspaceId },
        data: { syncToken: nextSyncToken, lastSyncedAt: new Date() },
      })
      return { events: items, newSyncToken: nextSyncToken }
    }
    console.error('[Google] pullChangedEvents failed:', err?.message || err)
    throw err
  }
}

export { encrypt, decrypt }
