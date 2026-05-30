'use client'

import { useEffect, useState } from 'react'

interface MeetV2 {
  flagEnabled: boolean
  scopesGranted: boolean
  hostedDomain: string | null
  recordingCapable: boolean | null
  recordingCapabilityReason: string | null
  recordingCapabilityMessage: string
  recordingCapabilityCheckedAt: string | null
  transcriptionCapable: boolean | null
  transcriptionCapabilityReason: string | null
  transcriptionCapabilityMessage: string
  transcriptionCapabilityCheckedAt: string | null
}

interface Status {
  configured: boolean
  connected: boolean
  integration: {
    googleEmail: string
    calendarId: string
    watchExpiresAt: string | null
    lastSyncedAt: string | null
    createdAt: string
  } | null
  meetV2: MeetV2 | null
}

export function GoogleIntegrationCard() {
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    // Surface OAuth callback status from URL
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const integration = params.get('integration')
      const st = params.get('status')
      if (integration === 'google' && st) {
        const map: Record<string, { type: 'success' | 'error'; text: string }> = {
          connected: { type: 'success', text: 'Google Calendar connected. Sync starting in the background.' },
          cancelled: { type: 'error', text: 'Connection cancelled.' },
          invalid: { type: 'error', text: 'Invalid callback — please try again.' },
          expired: { type: 'error', text: 'Connection attempt expired — please try again.' },
          error: { type: 'error', text: `Error: ${params.get('msg') || 'Unknown'}` },
        }
        if (map[st]) setBanner(map[st])
        // Clean URL
        window.history.replaceState({}, '', window.location.pathname + '?tab=integrations')
      }
    }
    console.log('[google-integration] GET /api/integrations/google')
    fetch('/api/integrations/google')
      .then(async (r) => {
        if (!r.ok) {
          const txt = await r.text().catch(() => '')
          throw new Error(`HTTP ${r.status} ${r.statusText}${txt ? ` — ${txt.slice(0, 200)}` : ''}`)
        }
        return r.json()
      })
      .then((d) => {
        console.log('[google-integration] response ←', d)
        setStatus(d)
        setLoading(false)
      })
      .catch((err) => {
        console.error('[google-integration] fetch failed', err)
        setLoading(false)
        setBanner({ type: 'error', text: `Couldn't load Google integration status: ${err instanceof Error ? err.message : String(err)}` })
      })
  }, [])

  const disconnect = async () => {
    if (!confirm('Disconnect Google Calendar? We will stop syncing bookings automatically.')) return
    await fetch('/api/integrations/google', { method: 'DELETE' })
    const d = await fetch('/api/integrations/google').then(r => r.json())
    setStatus(d)
    setBanner({ type: 'success', text: 'Google Calendar disconnected.' })
  }

  const [syncing, setSyncing] = useState(false)
  const [authExpired, setAuthExpired] = useState(false)
  const [recheckingRecording, setRecheckingRecording] = useState(false)
  const recheckRecording = async () => {
    setRecheckingRecording(true)
    setBanner(null)
    try {
      const r = await fetch('/api/integrations/google/recheck-recording', { method: 'POST' })
      const d = await r.json()
      if (!r.ok) {
        setBanner({ type: 'error', text: d.error || 'Re-check failed' })
      } else if (d.capable === true) {
        setBanner({ type: 'success', text: 'Recording is available on this Google account.' })
      } else if (d.capable === false) {
        setBanner({ type: 'error', text: d.message || 'Recording is not available on this Google account.' })
      } else {
        setBanner({ type: 'error', text: d.message || "We couldn't verify recording support." })
      }
      const fresh = await fetch('/api/integrations/google').then(r => r.json())
      setStatus(fresh)
    } catch (e) {
      setBanner({ type: 'error', text: e instanceof Error ? e.message : 'Re-check failed' })
    } finally {
      setRecheckingRecording(false)
    }
  }
  const sync = async () => {
    setSyncing(true)
    setBanner(null)
    setAuthExpired(false)
    try {
      const r = await fetch('/api/integrations/google/sync', { method: 'POST' })
      const d = await r.json()
      if (d.needsReconnect) {
        setAuthExpired(true)
        setBanner({
          type: 'error',
          text: 'Google has revoked our access (the refresh token is dead). Click Reconnect to grant access again — your existing settings will be preserved.',
        })
      } else if (!r.ok) {
        setBanner({ type: 'error', text: d.error || 'Sync failed' })
      } else {
        const parts = [
          `Scanned ${d.processed ?? 0} calendar event${d.processed === 1 ? '' : 's'}`,
          `${d.matched ?? 0} matched a candidate`,
        ]
        if (d.backfillError) parts.push(`backfill error: ${d.backfillError}`)
        setBanner({
          type: d.watchOk && !d.backfillError ? 'success' : 'error',
          text: parts.join(' · '),
        })
      }
      const fresh = await fetch('/api/integrations/google').then(r => r.json())
      setStatus(fresh)
    } catch (e) {
      setBanner({ type: 'error', text: e instanceof Error ? e.message : 'Sync failed' })
    } finally {
      setSyncing(false)
    }
  }

  if (loading) return <div className="bg-white rounded-[12px] border border-surface-border p-6 text-sm text-grey-40">Loading…</div>

  const meetV2 = status?.meetV2
  const needsReconnect = !!status?.connected && !!meetV2 && meetV2.flagEnabled && !meetV2.scopesGranted
  type Tone = 'green' | 'amber' | 'gray' | 'red'
  type Step = { text: string; href?: string }
  type RecordingState = {
    tone: Tone
    text: string
    message: string
    help?: { title: string; steps: Step[]; cta?: { label: string; href: string } }
  }
  const recordingState: RecordingState | null = (() => {
    if (!status?.connected || !meetV2) return null
    if (!meetV2.flagEnabled) {
      return {
        tone: 'gray',
        text: 'Recording: not enabled',
        message: 'Meet recording is not enabled for this workspace yet. Contact support to enable it.',
      }
    }
    if (!meetV2.scopesGranted) {
      return {
        tone: 'red',
        text: 'Recording: reconnect required',
        message: 'Reconnect Google to grant the recording permissions.',
        help: {
          title: 'Reconnect Google to enable recording',
          steps: [
            { text: 'Click "Reconnect Google" below.' },
            { text: 'On the Google consent screen, allow all requested Calendar, Meet, and Drive permissions.' },
            { text: 'After returning, this card will show "Recording available" if your account qualifies.' },
          ],
          cta: { label: 'Reconnect Google', href: '/api/integrations/google/connect' },
        },
      }
    }
    if (meetV2.recordingCapable === true) {
      return { tone: 'green', text: 'Recording available', message: meetV2.recordingCapabilityMessage }
    }
    if (meetV2.recordingCapable === false) {
      const reason = meetV2.recordingCapabilityReason
      if (reason === 'permission_denied_admin_policy') {
        return {
          tone: 'red',
          text: 'Recording unavailable',
          message: 'Recording is disabled by your Google Workspace admin.',
          help: {
            title: 'Your Google Workspace admin has disabled Meet recording',
            steps: [
              { text: 'Ask your Google Workspace admin to enable recording for your account.' },
              { text: 'In Google Admin console: Apps → Google Workspace → Google Meet → Meet video settings → enable "Recording".', href: 'https://admin.google.com/ac/appsettings/2126039168/MEETUI' },
              { text: 'Once enabled, click "Reconnect Google" below to re-check.' },
            ],
            cta: { label: 'Reconnect Google', href: '/api/integrations/google/connect' },
          },
        }
      }
      if (reason === 'permission_denied_plan') {
        return {
          tone: 'red',
          text: 'Recording unavailable',
          message: 'Your Google plan does not include Meet recording.',
          help: {
            title: 'Recording requires a qualifying Google Workspace plan',
            steps: [
              { text: 'Free Gmail, Business Starter, and Education Fundamentals do NOT include recording.' },
              { text: 'Upgrade to Business Standard, Business Plus, Enterprise (any tier), Education Plus, Teaching & Learning Upgrade, or Workspace Individual.', href: 'https://workspace.google.com/pricing.html' },
              { text: 'After upgrading, click "Reconnect Google" below to re-check.' },
            ],
            cta: { label: 'Reconnect Google', href: '/api/integrations/google/connect' },
          },
        }
      }
      return {
        tone: 'amber',
        text: 'Recording unavailable',
        message: 'Recording is not available on this Google account. Contact support if you expected it to work.',
        help: {
          title: 'Recording is not available on this Google account',
          steps: [
            { text: 'This usually means your Google plan or admin policy does not allow Meet recording.' },
            { text: 'Contact support if you expected recording to work — we can help diagnose the exact cause.' },
            { text: 'After resolving, click "Reconnect Google" below to re-check.' },
          ],
          cta: { label: 'Reconnect Google', href: '/api/integrations/google/connect' },
        },
      }
    }
    if (meetV2.recordingCapabilityReason === 'probe_error') {
      return {
        tone: 'red',
        text: 'Recording: check failed',
        message: 'We could not verify recording support. Try reconnecting your Google account.',
        help: {
          title: "We couldn't verify recording support",
          steps: [
            { text: 'This is usually temporary. Click "Reconnect Google" below to re-run the check.' },
            { text: 'If it keeps failing, your Google account may be missing Meet API access — contact support.' },
          ],
          cta: { label: 'Reconnect Google', href: '/api/integrations/google/connect' },
        },
      }
    }
    return {
      tone: 'gray',
      text: 'Recording: not yet checked',
      message: 'We will verify recording support the next time you schedule an interview.',
    }
  })()
  const badgeClass = (tone: Tone) =>
    tone === 'green' ? 'bg-green-100 text-green-700'
    : tone === 'red' ? 'bg-red-100 text-red-700'
    : tone === 'amber' ? 'bg-amber-100 text-amber-700'
    : 'bg-gray-100 text-grey-40'
  const calloutClass = (tone: Tone) =>
    tone === 'red' ? 'bg-red-50 border-red-200 text-red-800'
    : tone === 'amber' ? 'bg-amber-50 border-amber-200 text-amber-800'
    : 'bg-gray-50 border-surface-border text-grey-15'

  return (
    <div className="bg-white rounded-[12px] border border-surface-border p-6">
      {banner && (
        <div className={`mb-4 px-3 py-2 rounded-[8px] text-sm ${banner.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {banner.text}
        </div>
      )}
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-[10px] bg-white border border-surface-border flex items-center justify-center">
            <svg viewBox="0 0 48 48" className="w-7 h-7"><path fill="#4285F4" d="M43 40h-7V22h7z"/><path fill="#EA4335" d="M12 40h7V22h-7z"/><path fill="#FBBC04" d="M36 40h-7V8h7z"/><path fill="#34A853" d="M19 8v8h-7V8z"/><path fill="#188038" d="M12 40V16h7v8h10v16z"/></svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-grey-15">Google Calendar &amp; Meet</h3>
            <p className="text-sm text-grey-40 mt-0.5 max-w-md">
              Auto-detect booked interviews and, when enabled, schedule Google Meet interviews directly from HiringFlow with recording support on qualifying Google plans.
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {!status?.configured ? (
            <span className="text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 font-medium">Not configured</span>
          ) : status.connected ? (
            <span className="text-xs px-2.5 py-1 rounded-full bg-green-100 text-green-700 font-medium">Connected</span>
          ) : (
            <span className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-grey-40 font-medium">Not connected</span>
          )}
          {recordingState && (
            <span
              title={recordingState.message}
              className={`text-xs px-2.5 py-1 rounded-full font-medium whitespace-nowrap ${badgeClass(recordingState.tone)}`}
            >
              {recordingState.text}
            </span>
          )}
        </div>
      </div>

      {!status?.configured && (
        <div className="mt-4 p-3 bg-amber-50 rounded-[8px] text-xs text-amber-800">
          Admin setup required: set <code className="bg-white px-1 rounded">GOOGLE_CLIENT_ID</code>, <code className="bg-white px-1 rounded">GOOGLE_CLIENT_SECRET</code>, and <code className="bg-white px-1 rounded">GOOGLE_REDIRECT_URI</code> in environment variables.
        </div>
      )}

      {recordingState?.help && (
        <div className={`mt-4 p-4 rounded-[8px] border text-sm ${calloutClass(recordingState.tone)}`}>
          <div className="flex items-start gap-3">
            <svg viewBox="0 0 20 20" className="w-5 h-5 mt-0.5 flex-shrink-0" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.94 6.94a1.5 1.5 0 112.121 2.121l-.53.53a3 3 0 00-.879 2.122V12a1 1 0 11-2 0v-.286a5 5 0 011.464-3.535l.53-.53a.5.5 0 10-.707-.708 1 1 0 11-1.414-1.414zM10 15a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="font-semibold leading-snug">{recordingState.help.title}</p>
              <ol className="list-decimal list-inside mt-2 space-y-1 marker:text-current">
                {recordingState.help.steps.map((step, i) => (
                  <li key={i} className="leading-snug">
                    {step.href ? (
                      <a href={step.href} target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">
                        {step.text}
                      </a>
                    ) : (
                      step.text
                    )}
                  </li>
                ))}
              </ol>
              <div className="mt-3 flex flex-wrap gap-2">
                {recordingState.help.cta && (
                  <a
                    href={recordingState.help.cta.href}
                    className="inline-block btn-primary text-xs whitespace-nowrap"
                  >
                    {recordingState.help.cta.label}
                  </a>
                )}
                {meetV2?.scopesGranted && (
                  <button
                    onClick={recheckRecording}
                    disabled={recheckingRecording}
                    className="inline-block btn-secondary text-xs whitespace-nowrap disabled:opacity-50"
                  >
                    {recheckingRecording ? 'Re-checking…' : 'Re-check now'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {status?.connected && status.integration && (
        <div className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between py-2 border-b border-surface-border">
            <span className="text-grey-40">Connected as</span>
            <span className="text-grey-15 font-medium">{status.integration.googleEmail}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-surface-border">
            <span className="text-grey-40">Calendar</span>
            <span className="text-grey-15">{status.integration.calendarId}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-surface-border">
            <span className="text-grey-40">Watch expires</span>
            <span className="text-grey-15">{status.integration.watchExpiresAt ? new Date(status.integration.watchExpiresAt).toLocaleString() : '—'}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-surface-border">
            <span className="text-grey-40">Last synced</span>
            <span className="text-grey-15">{status.integration.lastSyncedAt ? new Date(status.integration.lastSyncedAt).toLocaleString() : 'Never'}</span>
          </div>
          {recordingState && (
            <div className="flex justify-between items-start py-2">
              <span className="text-grey-40">Meet recording</span>
              <div className="text-right">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badgeClass(recordingState.tone)}`}>
                  {recordingState.text}
                </span>
                <p className="text-xs text-grey-40 mt-1 max-w-xs">{recordingState.message}</p>
                {meetV2?.scopesGranted && (
                  <button
                    onClick={recheckRecording}
                    disabled={recheckingRecording}
                    className="mt-2 text-xs text-grey-40 underline hover:no-underline disabled:opacity-50"
                  >
                    {recheckingRecording ? 'Re-checking…' : 'Re-check now'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-5 flex gap-3">
        {status?.connected ? (
          <>
            {authExpired || needsReconnect ? (
              <a href="/api/integrations/google/connect" className="btn-primary text-sm">
                Reconnect Google
              </a>
            ) : (
              <button onClick={sync} disabled={syncing} className="btn-primary text-sm disabled:opacity-50">
                {syncing ? 'Syncing…' : 'Sync calendar now'}
              </button>
            )}
            <button onClick={disconnect} className="btn-secondary text-sm">Disconnect</button>
          </>
        ) : (
          <a
            href="/api/integrations/google/connect"
            className={`btn-primary text-sm ${!status?.configured ? 'pointer-events-none opacity-50' : ''}`}
          >
            Connect Google
          </a>
        )}
      </div>
    </div>
  )
}
