'use client'

/**
 * Modal: publish an Ad to one or more Telegram channels.
 *
 * Renders inside the per-ad preview page. Channel list comes from
 * /api/integrations/telegram/channels (only `ready` / `warning` channels are
 * selectable — unverified/blocked are listed but disabled with a tooltip).
 *
 * Text defaults to the rendered ad copy passed in via `defaultText` so the
 * preview shown to the recruiter is identical to what the server will send
 * unless they override it. parseMode optional; defaults to plain text.
 *
 * Scheduling: omitted → send now; populated → ISO-8601 UTC sent to Sigcore.
 * The datetime-local input is treated as the recruiter's local timezone.
 */

import { useEffect, useState } from 'react'

interface Channel {
  id: string
  chatRef: string
  displayName: string | null
  verifyStatus: 'unverified' | 'ready' | 'warning' | 'blocked'
}

interface DispatchResult {
  channelId: string
  chatRef: string
  placementId: string
  status: string
  error?: string
}

interface Props {
  adId: string
  defaultText: string
  defaultImageUrl: string | null
  onClose: () => void
  onDispatched: () => void
}

export function TelegramPublishModal({ adId, defaultText, defaultImageUrl, onClose, onDispatched }: Props) {
  const [loading, setLoading] = useState(true)
  const [channels, setChannels] = useState<Channel[]>([])
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>('unknown')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [text, setText] = useState(defaultText)
  const [imageUrl, setImageUrl] = useState(defaultImageUrl || '')
  const [parseMode, setParseMode] = useState<'' | 'Markdown' | 'MarkdownV2' | 'HTML'>('')
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduledLocal, setScheduledLocal] = useState('')
  const [sending, setSending] = useState(false)
  const [results, setResults] = useState<DispatchResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/integrations/telegram').then((r) => r.json()).catch(() => null),
      fetch('/api/integrations/telegram/channels').then((r) => r.json()).catch(() => null),
    ]).then(([s, c]) => {
      if (s?.subscription?.status) setSubscriptionStatus(s.subscription.status)
      if (Array.isArray(c?.channels)) setChannels(c.channels)
      setLoading(false)
    })
  }, [])

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = async () => {
    setError(null)
    setResults(null)
    if (selectedIds.size === 0) {
      setError('Pick at least one channel.')
      return
    }
    if (!text.trim()) {
      setError('Text is empty.')
      return
    }
    let scheduledAtIso: string | undefined
    if (scheduleEnabled) {
      if (!scheduledLocal) {
        setError('Pick a schedule time or untoggle scheduling.')
        return
      }
      const d = new Date(scheduledLocal) // datetime-local → local timezone
      if (!Number.isFinite(d.getTime())) {
        setError('Invalid schedule time.')
        return
      }
      if (d.getTime() < Date.now() - 60_000) {
        setError('Schedule time is in the past.')
        return
      }
      scheduledAtIso = d.toISOString()
    }

    setSending(true)
    try {
      const r = await fetch(`/api/ads/${adId}/telegram-publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelIds: Array.from(selectedIds),
          text,
          imageUrl: imageUrl.trim() || undefined,
          parseMode: parseMode || undefined,
          scheduledAt: scheduledAtIso,
        }),
      })
      const d = await r.json()
      if (!r.ok && !d.results) {
        setError(d.error || `Dispatch failed (HTTP ${r.status})`)
      } else {
        setResults(d.results as DispatchResult[])
        onDispatched()
      }
    } finally {
      setSending(false)
    }
  }

  // Subscription not ready — short-circuit to a help message.
  const subscriptionReady = subscriptionStatus === 'ready'

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-white rounded-[12px] shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-surface-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-grey-15">Publish to Telegram</h2>
          <button onClick={onClose} className="text-grey-40 hover:text-grey-15 text-2xl leading-none">&times;</button>
        </div>

        <div className="p-6 space-y-5">
          {loading ? (
            <div className="text-sm text-grey-40">Loading channels…</div>
          ) : !subscriptionReady ? (
            <div className="bg-amber-50 text-amber-700 rounded-[8px] p-4 text-sm">
              Telegram publishing isn't ready for this workspace. Enable it from{' '}
              <a href="/dashboard/settings?tab=integrations" className="underline">Settings → Integrations</a>.
            </div>
          ) : channels.length === 0 ? (
            <div className="bg-blue-50 text-blue-700 rounded-[8px] p-4 text-sm">
              No channels added yet. Add channels from{' '}
              <a href="/dashboard/settings?tab=integrations" className="underline">Settings → Integrations</a>.
            </div>
          ) : (
            <>
              {/* Channel picker */}
              <div>
                <div className="text-sm font-medium text-grey-15 mb-2">Channels</div>
                <div className="border border-surface-border rounded-[8px] divide-y divide-surface-border max-h-48 overflow-y-auto">
                  {channels.map((c) => {
                    const disabled = c.verifyStatus === 'blocked' || c.verifyStatus === 'unverified'
                    return (
                      <label
                        key={c.id}
                        className={`flex items-center gap-3 px-3 py-2 text-sm ${
                          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface'
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={disabled}
                          checked={selectedIds.has(c.id)}
                          onChange={() => !disabled && toggle(c.id)}
                        />
                        <code className="font-mono text-grey-15">{c.chatRef}</code>
                        {c.displayName && <span className="text-xs text-grey-40">· {c.displayName}</span>}
                        <span className="ml-auto text-[11px] uppercase tracking-wide text-grey-40">{c.verifyStatus}</span>
                      </label>
                    )
                  })}
                </div>
                <p className="text-xs text-grey-50 mt-1">
                  Only verified channels can be selected. Re-verify failed channels from Settings.
                </p>
              </div>

              {/* Text override */}
              <div>
                <label className="block text-sm font-medium text-grey-15 mb-1.5">Message text</label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                  className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <p className="text-xs text-grey-50 mt-1">
                  Pre-filled from the ad's saved copy. Edits here apply to this dispatch only.
                </p>
              </div>

              {/* Image override */}
              <div>
                <label className="block text-sm font-medium text-grey-15 mb-1.5">Image URL (optional)</label>
                <input
                  type="url"
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="https://…"
                  className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              {/* Parse mode + schedule */}
              <div className="flex flex-wrap gap-4">
                <div>
                  <label className="block text-sm font-medium text-grey-15 mb-1.5">Parse mode</label>
                  <select
                    value={parseMode}
                    onChange={(e) => setParseMode(e.target.value as any)}
                    className="px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15"
                  >
                    <option value="">Plain text</option>
                    <option value="Markdown">Markdown</option>
                    <option value="MarkdownV2">MarkdownV2</option>
                    <option value="HTML">HTML</option>
                  </select>
                </div>
                <div className="flex-1 min-w-[240px]">
                  <label className="flex items-center gap-2 text-sm font-medium text-grey-15 mb-1.5">
                    <input
                      type="checkbox"
                      checked={scheduleEnabled}
                      onChange={(e) => setScheduleEnabled(e.target.checked)}
                    />
                    Schedule for later
                  </label>
                  <input
                    type="datetime-local"
                    value={scheduledLocal}
                    onChange={(e) => setScheduledLocal(e.target.value)}
                    disabled={!scheduleEnabled}
                    className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface disabled:cursor-not-allowed"
                  />
                </div>
              </div>

              {error && (
                <div className="bg-red-50 text-red-700 rounded-[8px] px-3 py-2 text-sm">{error}</div>
              )}

              {results && (
                <div className="border border-surface-border rounded-[8px] overflow-hidden">
                  <div className="px-3 py-2 bg-surface text-xs uppercase tracking-wide text-grey-40">Dispatch results</div>
                  <div className="divide-y divide-surface-border">
                    {results.map((r) => (
                      <div key={r.placementId} className="px-3 py-2 text-sm flex items-center justify-between">
                        <code className="font-mono text-grey-15">{r.chatRef}</code>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            r.status === 'failed'
                              ? 'bg-red-100 text-red-700'
                              : r.status === 'scheduled'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-green-100 text-green-700'
                          }`}
                        >
                          {r.status}
                        </span>
                        {r.error && <span className="text-xs text-red-600 ml-2 truncate max-w-[260px]">{r.error}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-surface-border flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-grey-35 hover:text-ink">
            {results ? 'Close' : 'Cancel'}
          </button>
          {!results && subscriptionReady && channels.length > 0 && (
            <button
              onClick={submit}
              disabled={sending || selectedIds.size === 0}
              className="btn-primary text-sm px-4 disabled:opacity-50"
            >
              {sending ? 'Dispatching…' : scheduleEnabled ? 'Schedule' : `Send to ${selectedIds.size} channel${selectedIds.size === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
