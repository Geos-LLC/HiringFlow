'use client'

import { useEffect, useState } from 'react'

/**
 * Telegram publishing (via Sigcore → TelePorter).
 *
 * Two dispatch modes:
 *   bot     — workspace bot, recruiter adds channels where the bot is admin
 *   account — linked Telegram user account, recruiter adds channels they're a member of
 *
 * The mode is picked at "Not enabled" time; switching after-the-fact is a
 * one-click toggle below the channel list. The bot path is preserved as a
 * secondary option for businesses running their own job channels.
 */

type Mode = 'bot' | 'account'
type LinkStatus = 'code_requested' | 'password_required' | 'linked' | 'revoked'

interface Subscription {
  status: 'not_initialized' | 'provisioning' | 'ready' | 'retired'
  mode: Mode
  botUsername?: string | null
  inviteHint?: string | null
  tgUserId?: string | null
  tgUsername?: string | null
  linkAccountId?: string | null
  linkStatus?: LinkStatus | null
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
  const [accountModeEnabled, setAccountModeEnabled] = useState(false)
  const [subscription, setSubscription] = useState<Subscription>({ status: 'not_initialized', mode: 'bot' })
  const [channels, setChannels] = useState<Channel[]>([])
  const [banner, setBanner] = useState<Banner | null>(null)

  // Mode selection (when status === 'not_initialized' or user wants to switch)
  const [pendingMode, setPendingMode] = useState<Mode>('bot')
  const [subscribing, setSubscribing] = useState(false)
  const [switchingMode, setSwitchingMode] = useState(false)

  // Account-mode wizard state
  const [acceptedDisclosure, setAcceptedDisclosure] = useState(false)
  const [phoneInput, setPhoneInput] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [wizardBusy, setWizardBusy] = useState(false)
  const [wizardError, setWizardError] = useState<string | null>(null)
  const [unlinkBusy, setUnlinkBusy] = useState(false)

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

  // Auto-poll while provisioning (bot mode bootstrap). Account-mode link is
  // driven by user input so it doesn't need polling — but the post-linked
  // refresh is handled via the explicit reload after each wizard step.
  useEffect(() => {
    if (subscription.status !== 'provisioning' || subscription.mode !== 'bot') return
    const t = setInterval(() => loadStatus(true), 4000)
    return () => clearInterval(t)
  }, [subscription.status, subscription.mode])

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
    const d = (await r.json()) as {
      configured: boolean
      accountModeEnabled?: boolean
      subscription: Subscription
    }
    setConfigured(d.configured)
    setAccountModeEnabled(d.accountModeEnabled === true)
    setSubscription(d.subscription)
    if (d.subscription.status !== 'not_initialized') {
      setPendingMode(d.subscription.mode)
    }
  }

  async function loadChannels() {
    const r = await fetch('/api/integrations/telegram/channels')
    if (!r.ok) return
    const d = (await r.json()) as { channels: Channel[] }
    setChannels(d.channels)
  }

  async function enable(mode: Mode) {
    setBanner(null)
    setWizardError(null)
    setSubscribing(true)
    try {
      const r = await fetch(`/api/integrations/telegram/subscribe?mode=${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const d = await r.json()
      if (!r.ok) {
        setBanner({ type: 'error', text: d.error || `Enable failed (HTTP ${r.status})` })
        return
      }
      setSubscription(d.subscription)
      if (mode === 'bot') {
        setBanner({
          type: 'success',
          text:
            d.subscription.status === 'ready'
              ? `Bot @${d.subscription.botUsername} allocated.`
              : 'Bot allocated — provisioning in progress.',
        })
      } else {
        setAcceptedDisclosure(false)
        setPhoneInput('')
        setCodeInput('')
        setPasswordInput('')
      }
    } finally {
      setSubscribing(false)
    }
  }

  async function switchMode(targetMode: Mode) {
    if (subscription.mode === targetMode) return
    if (!confirm(
      targetMode === 'bot'
        ? 'Switch to bot mode? Your linked Telegram account will be unlinked and the workspace bot will be allocated.'
        : "Switch to account mode? The workspace bot will be retired and you'll need to link your personal Telegram account.",
    )) {
      return
    }
    setSwitchingMode(true)
    setBanner(null)
    try {
      if (subscription.mode === 'account' && subscription.linkStatus === 'linked') {
        await fetch('/api/integrations/telegram/account', { method: 'DELETE' })
      }
      const r = await fetch(`/api/integrations/telegram/subscribe?mode=${targetMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const d = await r.json()
      if (!r.ok) {
        setBanner({ type: 'error', text: d.error || `Switch failed (HTTP ${r.status})` })
        return
      }
      setSubscription(d.subscription)
      setPendingMode(targetMode)
      setAcceptedDisclosure(false)
      setPhoneInput('')
      setCodeInput('')
      setPasswordInput('')
    } finally {
      setSwitchingMode(false)
    }
  }

  async function postWizardStep(path: string, body: Record<string, string>) {
    setWizardBusy(true)
    setWizardError(null)
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) {
        setWizardError(d.error || `Step failed (HTTP ${r.status})`)
        return null
      }
      setSubscription(d.subscription)
      return d as { subscription: Subscription; nextStep: string; message?: string }
    } finally {
      setWizardBusy(false)
    }
  }

  async function submitPhone() {
    if (!phoneInput.trim()) return
    const result = await postWizardStep('/api/integrations/telegram/account/start', { phoneNumber: phoneInput.trim() })
    if (result?.nextStep === 'linked') {
      setBanner({ type: 'success', text: `Linked as @${result.subscription.tgUsername}` })
    }
  }

  async function submitCode() {
    if (!codeInput.trim()) return
    const result = await postWizardStep('/api/integrations/telegram/account/code', { code: codeInput.trim() })
    if (result?.nextStep === 'linked') {
      setBanner({ type: 'success', text: `Linked as @${result.subscription.tgUsername}` })
      setCodeInput('')
    } else if (result?.nextStep === 'password') {
      setCodeInput('')
    }
  }

  async function submitPassword() {
    if (!passwordInput) return
    const result = await postWizardStep('/api/integrations/telegram/account/password', { password: passwordInput })
    if (result?.nextStep === 'linked') {
      setBanner({ type: 'success', text: `Linked as @${result.subscription.tgUsername}` })
      setPasswordInput('')
    }
  }

  async function unlink() {
    if (!confirm("Unlink your Telegram account? You'll need to re-link to publish.")) return
    setUnlinkBusy(true)
    setBanner(null)
    try {
      const r = await fetch('/api/integrations/telegram/account', { method: 'DELETE' })
      const d = await r.json()
      if (!r.ok) {
        setBanner({ type: 'error', text: d.error || `Unlink failed (HTTP ${r.status})` })
        return
      }
      if (d.subscription) setSubscription(d.subscription)
      setBanner({ type: 'info', text: 'Account unlinked.' })
    } finally {
      setUnlinkBusy(false)
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

  const showRevokedBanner =
    subscription.mode === 'account' && subscription.linkStatus === 'revoked'

  return (
    <div className="bg-white rounded-[12px] border border-surface-border p-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold text-grey-15">Telegram Publishing</h3>
        <StatusBadge subscription={subscription} />
      </div>
      <p className="text-sm text-grey-40 mb-4">
        Post ads directly to Telegram channels.
        {subscription.status === 'ready' && subscription.mode === 'bot' &&
          ' Using a workspace bot — recruiter adds channels where the bot is an admin.'}
        {subscription.status === 'ready' && subscription.mode === 'account' &&
          ' Using a linked Telegram account — recruiter adds channels the linked user is a member of.'}
      </p>

      {showRevokedBanner && (
        <div className="mb-4 px-3 py-2 rounded-[8px] text-sm bg-red-50 text-red-700">
          Your Telegram account
          {subscription.tgUsername ? ` (@${subscription.tgUsername})` : ''}
          {' '}was logged out. Re-link to keep publishing.
        </div>
      )}

      {banner && (
        <div
          className={`mb-4 px-3 py-2 rounded-[8px] text-sm ${
            banner.type === 'success' ? 'bg-green-50 text-green-700' : banner.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'
          }`}
        >
          {banner.text}
        </div>
      )}

      {subscription.status === 'not_initialized' && accountModeEnabled && (
        <div className="mb-4">
          <div className="text-sm font-medium text-grey-15 mb-2">Pick a dispatch mode</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <ModeOption
              active={pendingMode === 'bot'}
              title="Workspace bot"
              desc="For channels you (or your workspace) admin. Faster (≈30 msgs/sec), no personal credentials."
              onClick={() => setPendingMode('bot')}
            />
            <ModeOption
              active={pendingMode === 'account'}
              title="Your Telegram account"
              desc="For any channel you're a member of. Requires linking your Telegram account. Slower (≈20 msgs/min)."
              onClick={() => setPendingMode('account')}
            />
          </div>
          <button
            onClick={() => enable(pendingMode)}
            disabled={subscribing}
            className="btn-primary text-sm mt-3 disabled:opacity-50"
          >
            {subscribing
              ? 'Enabling…'
              : pendingMode === 'bot'
              ? 'Enable workspace bot'
              : 'Continue with account mode'}
          </button>
        </div>
      )}

      {subscription.status === 'not_initialized' && !accountModeEnabled && (
        <div>
          <button onClick={() => enable('bot')} disabled={subscribing} className="btn-primary text-sm disabled:opacity-50">
            {subscribing ? 'Enabling…' : 'Enable Telegram Publishing'}
          </button>
          <p className="text-xs text-grey-50 mt-2">Allocates a dedicated bot from the TelePorter pool.</p>
        </div>
      )}

      {subscription.mode === 'bot' && subscription.status === 'provisioning' && (
        <div className="text-sm text-grey-40">
          Bot allocated — finishing setup. This usually takes under a minute.
          <button onClick={() => loadStatus(true)} className="ml-3 text-brand-500 hover:text-brand-600 text-xs font-medium">
            Refresh
          </button>
        </div>
      )}

      {subscription.mode === 'bot' && subscription.status === 'retired' && (
        <div className="text-sm text-grey-40">
          This workspace's Telegram bot has been retired. Contact support to provision a new one.
        </div>
      )}

      {subscription.mode === 'account' && subscription.status === 'provisioning' && (
        <AccountWizard
          subscription={subscription}
          acceptedDisclosure={acceptedDisclosure}
          onAcceptDisclosure={() => setAcceptedDisclosure(true)}
          phoneInput={phoneInput}
          codeInput={codeInput}
          passwordInput={passwordInput}
          onPhoneChange={setPhoneInput}
          onCodeChange={setCodeInput}
          onPasswordChange={setPasswordInput}
          onSubmitPhone={submitPhone}
          onSubmitCode={submitCode}
          onSubmitPassword={submitPassword}
          busy={wizardBusy}
          error={wizardError}
        />
      )}

      {subscription.mode === 'account' && subscription.status === 'retired' && (
        <div className="mb-5">
          <button
            onClick={() => enable('account')}
            disabled={subscribing}
            className="btn-primary text-sm disabled:opacity-50"
          >
            {subscribing ? 'Preparing…' : 'Re-link Telegram account'}
          </button>
        </div>
      )}

      {subscription.status === 'ready' && (
        <>
          <div className="bg-surface rounded-[8px] p-3 mb-5">
            {subscription.mode === 'bot' ? (
              <>
                <div className="text-xs text-grey-40">Workspace bot</div>
                <div className="text-sm font-mono text-grey-15 mt-0.5">@{subscription.botUsername}</div>
                {subscription.inviteHint && (
                  <div className="text-xs text-grey-40 mt-2 whitespace-pre-line">{subscription.inviteHint}</div>
                )}
              </>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-grey-40">Linked Telegram account</div>
                  <div className="text-sm font-mono text-grey-15 mt-0.5">
                    {subscription.tgUsername ? `@${subscription.tgUsername}` : 'Linked'}
                    {subscription.tgUserId && (
                      <span className="text-xs text-grey-50 ml-2">id {subscription.tgUserId}</span>
                    )}
                  </div>
                  <div className="text-xs text-grey-40 mt-2">
                    Publishing rate: ≈20 messages/minute. Plan ahead for large channel batches.
                  </div>
                </div>
                <button
                  onClick={unlink}
                  disabled={unlinkBusy}
                  className="text-xs px-2 py-1 text-red-500 hover:text-red-700 disabled:opacity-50"
                >
                  {unlinkBusy ? 'Unlinking…' : 'Unlink'}
                </button>
              </div>
            )}
          </div>

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
              {subscription.mode === 'bot' ? (
                <>
                  Make sure <code className="px-1 bg-surface rounded text-[11px]">@{subscription.botUsername}</code> is
                  added as an admin on the channel with permission to post.
                </>
              ) : (
                <>
                  Make sure
                  {subscription.tgUsername ? (
                    <> <code className="px-1 bg-surface rounded text-[11px]">@{subscription.tgUsername}</code> </>
                  ) : (
                    ' your linked account '
                  )}
                  is a member of the channel and has post permission.
                </>
              )}{' '}
              Probe sends + deletes a zero-width test message — use it to confirm posting permission.
            </p>
          </div>

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
                    mode={subscription.mode}
                    channel={c}
                    busy={busyRow === c.id}
                    onReverify={(probe) => reverify(c, probe)}
                    onDelete={() => deleteChannel(c)}
                  />
                ))}
              </div>
            </div>
          )}

          {accountModeEnabled && (
            <div className="mt-5 pt-4 border-t border-surface-border text-xs text-grey-40">
              <button
                onClick={() => switchMode(subscription.mode === 'bot' ? 'account' : 'bot')}
                disabled={switchingMode}
                className="text-brand-500 hover:text-brand-600 font-medium disabled:opacity-50"
              >
                {switchingMode
                  ? 'Switching…'
                  : subscription.mode === 'bot'
                  ? 'Switch to account mode'
                  : 'Switch to bot mode'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ModeOption({
  active,
  title,
  desc,
  onClick,
}: {
  active: boolean
  title: string
  desc: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left p-3 rounded-[8px] border ${
        active ? 'border-brand-500 bg-brand-50' : 'border-surface-border hover:border-grey-30'
      }`}
    >
      <div className="text-sm font-medium text-grey-15">{title}</div>
      <div className="text-xs text-grey-40 mt-1">{desc}</div>
    </button>
  )
}

function AccountWizard({
  subscription,
  acceptedDisclosure,
  onAcceptDisclosure,
  phoneInput,
  codeInput,
  passwordInput,
  onPhoneChange,
  onCodeChange,
  onPasswordChange,
  onSubmitPhone,
  onSubmitCode,
  onSubmitPassword,
  busy,
  error,
}: {
  subscription: Subscription
  acceptedDisclosure: boolean
  onAcceptDisclosure: () => void
  phoneInput: string
  codeInput: string
  passwordInput: string
  onPhoneChange: (v: string) => void
  onCodeChange: (v: string) => void
  onPasswordChange: (v: string) => void
  onSubmitPhone: () => void
  onSubmitCode: () => void
  onSubmitPassword: () => void
  busy: boolean
  error: string | null
}) {
  // Disclosure gates the phone step on the first attempt. Once accepted
  // in-memory the user proceeds. We don't persist acceptance — disclosure
  // shows again on a fresh link attempt.
  if (!acceptedDisclosure && !subscription.linkStatus) {
    return (
      <div className="border border-surface-border rounded-[8px] p-4 mb-4 bg-surface">
        <div className="text-sm font-medium text-grey-15 mb-2">Before you link your Telegram account</div>
        <ul className="text-xs text-grey-40 list-disc pl-4 space-y-1.5">
          <li>You'll enter your phone number, the SMS code Telegram sends, and (if enabled) your 2FA password.</li>
          <li>
            These credentials are forwarded to TelePorter (our Telegram gateway). The resulting GramJS session
            is encrypted at rest in Secret Manager and used only to publish ads from your workspace.
          </li>
          <li>Telegram may show a notification on your other devices that a new session was authorized.</li>
          <li>You can unlink at any time from this page; that wipes the session.</li>
        </ul>
        <label className="flex items-center gap-2 mt-3 text-xs text-grey-15">
          <input type="checkbox" onChange={(e) => e.target.checked && onAcceptDisclosure()} />
          I understand and want to continue.
        </label>
      </div>
    )
  }

  return (
    <div className="border border-surface-border rounded-[8px] p-4 mb-4">
      <WizardSteps current={subscription.linkStatus ?? 'phone'} />

      {(!subscription.linkStatus || subscription.linkStatus === 'revoked') && (
        <div>
          <label className="block text-sm font-medium text-grey-15 mb-1.5">Phone number</label>
          <div className="flex gap-2">
            <input
              type="tel"
              value={phoneInput}
              onChange={(e) => onPhoneChange(e.target.value)}
              placeholder="+15551234567"
              className="flex-1 px-3 py-2 border border-surface-border rounded-[6px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <button
              onClick={onSubmitPhone}
              disabled={busy || !phoneInput.trim()}
              className="btn-primary text-sm px-4 disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </div>
          <p className="text-xs text-grey-50 mt-2">E.164 format with leading <code className="px-1 bg-surface rounded">+</code>.</p>
        </div>
      )}

      {subscription.linkStatus === 'code_requested' && (
        <div>
          <label className="block text-sm font-medium text-grey-15 mb-1.5">Code from Telegram</label>
          <div className="flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={codeInput}
              onChange={(e) => onCodeChange(e.target.value)}
              placeholder="12345"
              autoFocus
              className="flex-1 px-3 py-2 border border-surface-border rounded-[6px] text-sm text-grey-15 font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <button
              onClick={onSubmitCode}
              disabled={busy || !codeInput.trim()}
              className="btn-primary text-sm px-4 disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </div>
          <p className="text-xs text-grey-50 mt-2">Check the Telegram app on a device where you're already logged in.</p>
        </div>
      )}

      {subscription.linkStatus === 'password_required' && (
        <div>
          <label className="block text-sm font-medium text-grey-15 mb-1.5">Two-factor password</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder="Your Telegram cloud password"
              autoFocus
              className="flex-1 px-3 py-2 border border-surface-border rounded-[6px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <button
              onClick={onSubmitPassword}
              disabled={busy || !passwordInput}
              className="btn-primary text-sm px-4 disabled:opacity-50"
            >
              {busy ? 'Submitting…' : 'Submit'}
            </button>
          </div>
          <p className="text-xs text-grey-50 mt-2">This is the Telegram cloud password used for 2FA, not your device PIN.</p>
        </div>
      )}

      {error && (
        <div className="mt-3 text-xs text-red-600">{error}</div>
      )}
    </div>
  )
}

function WizardSteps({ current }: { current: LinkStatus | 'phone' }) {
  const steps: { key: LinkStatus | 'phone'; label: string }[] = [
    { key: 'phone', label: 'Phone' },
    { key: 'code_requested', label: 'Code' },
    { key: 'password_required', label: '2FA' },
  ]
  const activeIndex =
    current === 'phone' || current === 'revoked' ? 0 :
    current === 'code_requested' ? 1 :
    current === 'password_required' ? 2 :
    3
  return (
    <div className="flex items-center gap-2 mb-4 text-xs text-grey-40">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          <span
            className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium ${
              i <= activeIndex ? 'bg-brand-500 text-white' : 'bg-gray-100 text-grey-40'
            }`}
          >
            {i + 1}
          </span>
          <span className={i === activeIndex ? 'text-grey-15 font-medium' : ''}>{s.label}</span>
          {i < steps.length - 1 && <span className="text-grey-30">›</span>}
        </div>
      ))}
    </div>
  )
}

function StatusBadge({ subscription }: { subscription: Subscription }) {
  const map: Record<Subscription['status'], { label: string; cls: string }> = {
    not_initialized: { label: 'Not enabled', cls: 'bg-gray-100 text-grey-40' },
    provisioning: { label: subscription.mode === 'account' ? 'Linking…' : 'Provisioning', cls: 'bg-amber-50 text-amber-700' },
    ready: { label: 'Ready', cls: 'bg-green-100 text-green-700' },
    retired: { label: subscription.mode === 'account' ? 'Unlinked' : 'Retired', cls: 'bg-red-50 text-red-700' },
  }
  const { label, cls } = map[subscription.status]
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>
}

function ChannelRow({
  mode,
  channel,
  busy,
  onReverify,
  onDelete,
}: {
  mode: Mode
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
          <VerifyBadge mode={mode} status={channel.verifyStatus} />
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

function VerifyBadge({ mode, status }: { mode: Mode; status: Channel['verifyStatus'] }) {
  // Labels swap semantics: in bot mode, "ready" = bot is admin; in account
  // mode, "ready" = linked account is a member. Same row state, different
  // human label per mode.
  const botMap: Record<Channel['verifyStatus'], { label: string; cls: string }> = {
    unverified: { label: 'Unverified', cls: 'bg-gray-100 text-grey-40' },
    ready: { label: 'Ready', cls: 'bg-green-100 text-green-700' },
    warning: { label: 'Ready · warnings', cls: 'bg-amber-50 text-amber-700' },
    blocked: { label: 'Bot not admin', cls: 'bg-red-50 text-red-700' },
  }
  const accountMap: Record<Channel['verifyStatus'], { label: string; cls: string }> = {
    unverified: { label: 'Unverified', cls: 'bg-gray-100 text-grey-40' },
    ready: { label: 'Member', cls: 'bg-green-100 text-green-700' },
    warning: { label: 'Member · warnings', cls: 'bg-amber-50 text-amber-700' },
    blocked: { label: 'Not a member', cls: 'bg-red-50 text-red-700' },
  }
  const { label, cls } = (mode === 'account' ? accountMap : botMap)[status]
  return <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>
}
