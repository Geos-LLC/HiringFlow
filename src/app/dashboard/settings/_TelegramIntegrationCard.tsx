'use client'

import { useEffect, useState } from 'react'

/**
 * Telegram publishing (via Sigcore → TelePorter).
 *
 * Three states:
 *   not_initialized → "Enable" button calls POST /subscribe
 *   provisioning    → bot allocated but BotFather profile setup in progress;
 *                     auto-polls /api/integrations/telegram?sync=1
 *   ready           → bot username + invite hint + channel management
 *
 * Channel management: chatRef input → POST /channels (server normalizes +
 * verifies); per-row Re-verify and Delete actions.
 */

interface Subscription {
  status: 'not_initialized' | 'provisioning' | 'ready' | 'retired'
  botUsername?: string | null
  inviteHint?: string | null
  lastSyncedAt?: string | null
}

interface VerifyVerdict {
  status?: string
  warnings?: string[]
  blockers?: string[]
  [k: string]: unknown
}

interface Channel {
  id: string
  chatRef: string
  displayName: string | null
  verifyStatus: 'unverified' | 'ready' | 'warning' | 'blocked'
  verifyVerdict: VerifyVerdict | null
  verifiedAt: string | null
  lastVerifyError: string | null
  createdAt: string
}

type Banner = { type: 'success' | 'error' | 'info'; text: string }

export function TelegramIntegrationCard() {
  const [loading, setLoading] = useState(true)
  const [configured, setConfigured] = useState(true)
  const [subscription, setSubscription] = useState<Subscription>({ status: 'not_initialized' })
  const [channels, setChannels] = useState<Channel[]>([])
  const [banner, setBanner] = useState<Banner | null>(null)
  const [subscribing, setSubscribing] = useState(false)

  // Add-channel form
  const [chatRefInput, setChatRefInput] = useState('')
  const [displayNameInput, setDisplayNameInput] = useState('')
  const [probeOnAdd, setProbeOnAdd] = useState(false)
  const [adding, setAdding] = useState(false)

  // Per-row UI state
  const [busyRow, setBusyRow] = useState<string | null>(null)

  useEffect(() => {
    loadAll()
  }, [])

  // Auto-poll while provisioning. Stops once status flips off 'provisioning'.
  useEffect(() => {
    if (subscription.status !== 'provisioning') return
    const t = setInterval(() => loadStatus(true), 4000)
    return () => clearInterval(t)
  }, [subscription.status])

  async function loadAll() {
    setLoading(true)
    try {
      await Promise.all([loadStatus(false), loadChannels()])
    } finally {
      setLoading(false)
    }
  }

  async function loadStatus(forceSync: boolean) {
    const r = await fetch(`/api/integrations/telegram${forceSync ? '?sync=1' : ''}`)
    if (!r.ok) return
    const d = (await r.json()) as { configured: boolean; subscription: Subscription }
    setConfigured(d.configured)
    setSubscription(d.subscription)
  }

  async function loadChannels() {
    const r = await fetch('/api/integrations/telegram/channels')
    if (!r.ok) return
    const d = (await r.json()) as { channels: Channel[] }
    setChannels(d.channels)
  }

  async function subscribe() {
    setBanner(null)
    setSubscribing(true)
    try {
      const r = await fetch('/api/integrations/telegram/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const d = await r.json()
      if (!r.ok) {
        setBanner({ type: 'error', text: d.error || `Subscribe failed (HTTP ${r.status})` })
      } else {
        setSubscription(d.subscription)
        setBanner({
          type: 'success',
          text:
            d.subscription.status === 'ready'
              ? `Bot @${d.subscription.botUsername} allocated.`
              : 'Bot allocated — provisioning in progress.',
        })
      }
    } finally {
      setSubscribing(false)
    }
  }

  async function addChannel() {
    if (!chatRefInput.trim()) return
    setBanner(null)
    setAdding(true)
    try {
      const r = await fetch('/api/integrations/telegram/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatRef: chatRefInput.trim(),
          displayName: displayNameInput.trim() || undefined,
          probe: probeOnAdd,
        }),
      })
      const d = await r.json()
      if (!r.ok && r.status !== 502) {
        setBanner({ type: 'error', text: d.error || `Add failed (HTTP ${r.status})` })
      } else {
        // 502 means verify failed but row was persisted so the recruiter can fix + retry.
        if (r.status === 502) {
          setBanner({ type: 'error', text: `Verify failed: ${d.verifyError || 'unknown error'}` })
        } else {
          setBanner({ type: 'success', text: `Channel ${d.channel.chatRef} added.` })
        }
        setChatRefInput('')
        setDisplayNameInput('')
        await loadChannels()
      }
    } finally {
      setAdding(false)
    }
  }

  async function reverify(channel: Channel, probe: boolean) {
    setBusyRow(channel.id)
    setBanner(null)
    try {
      const r = await fetch(`/api/integrations/telegram/channels/${channel.id}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ probe }),
      })
      const d = await r.json()
      if (!r.ok && r.status !== 502) {
        setBanner({ type: 'error', text: d.error || `Re-verify failed (HTTP ${r.status})` })
      }
      await loadChannels()
    } finally {
      setBusyRow(null)
    }
  }

  async function deleteChannel(channel: Channel) {
    if (!confirm(`Remove ${channel.chatRef} from this workspace's Telegram channels?`)) return
    setBusyRow(channel.id)
    setBanner(null)
    try {
      const r = await fetch(`/api/integrations/telegram/channels/${channel.id}`, { method: 'DELETE' })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setBanner({ type: 'error', text: d.error || `Remove failed (HTTP ${r.status})` })
      }
      await loadChannels()
    } finally {
      setBusyRow(null)
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-[12px] border border-surface-border p-6">
        <h3 className="text-lg font-semibold text-grey-15">Telegram Publishing</h3>
        <p className="text-sm text-grey-40 mt-2">Loading…</p>
      </div>
    )
  }

  if (!configured) {
    return (
      <div className="bg-white rounded-[12px] border border-surface-border p-6">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-semibold text-grey-15">Telegram Publishing</h3>
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-grey-40 font-medium">Not configured</span>
        </div>
        <p className="text-sm text-grey-40">
          Telegram publishing requires Sigcore credentials. Ask a platform admin to set
          <code className="px-1 mx-1 bg-surface rounded text-[12px]">SIGCORE_API_URL</code>
          and
          <code className="px-1 mx-1 bg-surface rounded text-[12px]">SIGCORE_API_KEY</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-[12px] border border-surface-border p-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold text-grey-15">Telegram Publishing</h3>
        <StatusBadge status={subscription.status} />
      </div>
      <p className="text-sm text-grey-40 mb-4">
        Post ads directly to Telegram channels your workspace owns. One dedicated bot per workspace; channels
        you add stay attached to this workspace only.
      </p>

      {banner && (
        <div
          className={`mb-4 px-3 py-2 rounded-[8px] text-sm ${
            banner.type === 'success' ? 'bg-green-50 text-green-700' : banner.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'
          }`}
        >
          {banner.text}
        </div>
      )}

      {subscription.status === 'not_initialized' && (
        <div>
          <button onClick={subscribe} disabled={subscribing} className="btn-primary text-sm disabled:opacity-50">
            {subscribing ? 'Enabling…' : 'Enable Telegram Publishing'}
          </button>
          <p className="text-xs text-grey-50 mt-2">Allocates a dedicated bot from the TelePorter pool.</p>
        </div>
      )}

      {subscription.status === 'provisioning' && (
        <div className="text-sm text-grey-40">
          Bot allocated — finishing setup. This usually takes under a minute.
          <button onClick={() => loadStatus(true)} className="ml-3 text-brand-500 hover:text-brand-600 text-xs font-medium">
            Refresh
          </button>
        </div>
      )}

      {subscription.status === 'retired' && (
        <div className="text-sm text-grey-40">
          This workspace's Telegram bot has been retired. Contact support to provision a new one.
        </div>
      )}

      {subscription.status === 'ready' && (
        <>
          {/* Bot details */}
          <div className="bg-surface rounded-[8px] p-3 mb-5">
            <div className="text-xs text-grey-40">Workspace bot</div>
            <div className="text-sm font-mono text-grey-15 mt-0.5">@{subscription.botUsername}</div>
            {subscription.inviteHint && (
              <div className="text-xs text-grey-40 mt-2 whitespace-pre-line">{subscription.inviteHint}</div>
            )}
          </div>

          {/* Add channel form */}
          <div className="border border-surface-border rounded-[8px] p-4 mb-5">
            <div className="text-sm font-medium text-grey-15 mb-2">Add a channel</div>
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={chatRefInput}
                onChange={(e) => setChatRefInput(e.target.value)}
                placeholder="@channel_username or numeric chat id"
                className="flex-1 min-w-[200px] px-3 py-2 border border-surface-border rounded-[6px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <input
                type="text"
                value={displayNameInput}
                onChange={(e) => setDisplayNameInput(e.target.value)}
                placeholder="Display name (optional)"
                className="w-44 px-3 py-2 border border-surface-border rounded-[6px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <label className="flex items-center gap-1.5 text-xs text-grey-40 select-none">
                <input type="checkbox" checked={probeOnAdd} onChange={(e) => setProbeOnAdd(e.target.checked)} />
                Probe-test
              </label>
              <button
                onClick={addChannel}
                disabled={adding || !chatRefInput.trim()}
                className="btn-primary text-sm px-4 disabled:opacity-50"
              >
                {adding ? 'Adding…' : 'Add'}
              </button>
            </div>
            <p className="text-xs text-grey-50 mt-2">
              Make sure <code className="px-1 bg-surface rounded text-[11px]">@{subscription.botUsername}</code> is
              added as an admin on the channel with permission to post. Probe sends + deletes a zero-width test
              message — use it on public channels to confirm posting permission.
            </p>
          </div>

          {/* Channel list */}
          {channels.length === 0 ? (
            <div className="text-sm text-grey-40 text-center py-6">No channels added yet.</div>
          ) : (
            <div className="border border-surface-border rounded-[8px] overflow-hidden">
              <div className="px-4 py-2 bg-surface text-xs uppercase tracking-wide text-grey-40">
                Channels ({channels.length})
              </div>
              <div className="divide-y divide-surface-border">
                {channels.map((c) => (
                  <ChannelRow
                    key={c.id}
                    channel={c}
                    busy={busyRow === c.id}
                    onReverify={(probe) => reverify(c, probe)}
                    onDelete={() => deleteChannel(c)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: Subscription['status'] }) {
  const map: Record<Subscription['status'], { label: string; cls: string }> = {
    not_initialized: { label: 'Not enabled', cls: 'bg-gray-100 text-grey-40' },
    provisioning: { label: 'Provisioning', cls: 'bg-amber-50 text-amber-700' },
    ready: { label: 'Ready', cls: 'bg-green-100 text-green-700' },
    retired: { label: 'Retired', cls: 'bg-red-50 text-red-700' },
  }
  const { label, cls } = map[status]
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>
}

function ChannelRow({
  channel,
  busy,
  onReverify,
  onDelete,
}: {
  channel: Channel
  busy: boolean
  onReverify: (probe: boolean) => void
  onDelete: () => void
}) {
  const warnings = channel.verifyVerdict?.warnings ?? []
  const blockers = channel.verifyVerdict?.blockers ?? []

  return (
    <div className="px-4 py-3 flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono text-grey-15">{channel.chatRef}</code>
          <VerifyBadge status={channel.verifyStatus} />
          {channel.displayName && <span className="text-xs text-grey-40">· {channel.displayName}</span>}
        </div>
        {channel.lastVerifyError && (
          <div className="text-xs text-red-600 mt-1">{channel.lastVerifyError}</div>
        )}
        {blockers.length > 0 && (
          <div className="text-xs text-red-600 mt-1">Blockers: {blockers.join(', ')}</div>
        )}
        {warnings.length > 0 && (
          <div className="text-xs text-amber-700 mt-1">Warnings: {warnings.join(', ')}</div>
        )}
        {channel.verifiedAt && (
          <div className="text-xs text-grey-50 mt-1">Verified {new Date(channel.verifiedAt).toLocaleString()}</div>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onReverify(false)}
          disabled={busy}
          className="text-xs px-2 py-1 border border-surface-border rounded-[6px] text-grey-35 hover:text-ink disabled:opacity-50"
          title="Re-verify (cached for 1h)"
        >
          Re-verify
        </button>
        <button
          onClick={() => onReverify(true)}
          disabled={busy}
          className="text-xs px-2 py-1 border border-surface-border rounded-[6px] text-grey-35 hover:text-ink disabled:opacity-50"
          title="Bypass cache — sends + deletes a test message"
        >
          Probe
        </button>
        <button
          onClick={onDelete}
          disabled={busy}
          className="text-xs px-2 py-1 text-red-500 hover:text-red-700 disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    </div>
  )
}

function VerifyBadge({ status }: { status: Channel['verifyStatus'] }) {
  const map: Record<Channel['verifyStatus'], { label: string; cls: string }> = {
    unverified: { label: 'Unverified', cls: 'bg-gray-100 text-grey-40' },
    ready: { label: 'Ready', cls: 'bg-green-100 text-green-700' },
    warning: { label: 'Ready · warnings', cls: 'bg-amber-50 text-amber-700' },
    blocked: { label: 'Blocked', cls: 'bg-red-50 text-red-700' },
  }
  const { label, cls } = map[status]
  return <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>
}
