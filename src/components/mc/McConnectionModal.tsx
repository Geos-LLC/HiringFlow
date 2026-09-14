/**
 * Connect MockCustomer modal — two paths:
 *
 *   default: auto-provision a fresh MC org for this workspace.
 *            One click, ~3s, done. For users new to MC.
 *
 *   login:   authenticate with an existing MC email + password (Chrome
 *            autofills), pick which of the user's MC orgs to link, HF
 *            mints a fresh api key on that org. For users who already
 *            have MC and want to see their existing AI Customers +
 *            past recordings.
 *
 * The two branches use different backends:
 *   default → POST /api/mc-connection/connect
 *   login   → POST /api/mc-connection/authenticate  (step 1)
 *             POST /api/mc-connection/authenticate  (step 2 with grantToken)
 *
 * The login branch has two sub-states: 'credentials' (email+pw form)
 * and 'pick-org' (radio list of orgs the user belongs to). If the user
 * has exactly one org we skip 'pick-org' and complete immediately.
 */

'use client'

import { useCallback, useState } from 'react'

export interface McConnectionStatus {
  connected: boolean
  mcOrganizationSlug: string | null
  mcEnvironment: 'test' | 'live' | null
}

type Branch = 'default' | 'login'
type LoginStep = 'credentials' | 'pick-org'

interface Props {
  onClose: () => void
  onConnected: (status: McConnectionStatus) => void
  /**
   * Which branch the modal opens on. Defaults to 'default' (auto-provision) —
   * appropriate for first-time Connect. Callers who are switching an existing
   * connection should pass 'login' since a switch by definition means the user
   * already has an MC account.
   */
  initialBranch?: Branch
}

interface McOrg {
  id: string
  slug: string
  name: string
}

export function McConnectionModal({ onClose, onConnected, initialBranch = 'default' }: Props) {
  const [branch, setBranch] = useState<Branch>(initialBranch)
  const [loginStep, setLoginStep] = useState<LoginStep>('credentials')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Login-branch state.
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [grantToken, setGrantToken] = useState<string | null>(null)
  const [orgs, setOrgs] = useState<McOrg[]>([])
  const [pickedOrgId, setPickedOrgId] = useState<string | null>(null)

  const complete = useCallback(
    async (organizationId: string, token: string) => {
      const res = await fetch('/api/mc-connection/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantToken: token, organizationId }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        connected?: boolean
        mcOrganizationSlug?: string | null
        mcEnvironment?: 'test' | 'live' | null
        error?: string
        reason?: string
      }
      if (!res.ok || !data.connected) {
        setError(data.error ?? `Failed to link account (${res.status})`)
        // If grant expired, kick user back to credentials step.
        if (data.reason === 'grant_invalid') {
          setLoginStep('credentials')
          setGrantToken(null)
        }
        return
      }
      onConnected({
        connected: true,
        mcOrganizationSlug: data.mcOrganizationSlug ?? null,
        mcEnvironment: data.mcEnvironment ?? null,
      })
    },
    [onConnected],
  )

  const submitLoginStep1 = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/mc-connection/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        userId?: string
        orgs?: McOrg[]
        grantToken?: string | null
        error?: string
        reason?: string
      }
      if (!res.ok || !data.grantToken || !data.orgs) {
        setError(data.error ?? `Login failed (${res.status})`)
        return
      }
      setGrantToken(data.grantToken)
      setOrgs(data.orgs)
      // Wipe password from state as soon as we have the grant — narrows
      // the window it lives in browser memory. Email stays for the
      // "logged in as: X" display.
      setPassword('')
      if (data.orgs.length === 1) {
        // Only one org — skip picker + complete immediately.
        setPickedOrgId(data.orgs[0].id)
        await complete(data.orgs[0].id, data.grantToken)
      } else {
        setPickedOrgId(data.orgs[0]?.id ?? null)
        setLoginStep('pick-org')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }, [email, password, complete])

  const submitLoginStep2 = useCallback(async () => {
    if (!grantToken || !pickedOrgId) return
    setSubmitting(true)
    setError(null)
    try {
      await complete(pickedOrgId, grantToken)
    } finally {
      setSubmitting(false)
    }
  }, [grantToken, pickedOrgId, complete])

  const submitDefault = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/mc-connection/connect', { method: 'POST' })
      const data = (await res.json().catch(() => ({}))) as {
        connected?: boolean
        mcOrganizationSlug?: string | null
        mcEnvironment?: 'test' | 'live' | null
        error?: string
      }
      if (!res.ok || !data.connected) {
        setError(data.error ?? `Failed to connect (${res.status})`)
        return
      }
      onConnected({
        connected: true,
        mcOrganizationSlug: data.mcOrganizationSlug ?? null,
        mcEnvironment: data.mcEnvironment ?? null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setSubmitting(false)
    }
  }, [onConnected])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose()
      }}
    >
      <div className="w-full max-w-md rounded-[14px] bg-white shadow-xl border border-surface-border">
        <div className="px-5 py-4 border-b border-surface-divider flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink">Connect MockCustomer</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="w-7 h-7 flex items-center justify-center rounded-md text-grey-50 hover:text-ink hover:bg-surface-light disabled:opacity-50"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4">
          {branch === 'default' ? (
            <>
              <p className="text-[13px] text-grey-15">
                Create a fresh MockCustomer workspace for HireFunnel. Ready in ~3 seconds. Free during beta.
              </p>
              <ul className="mt-3 space-y-1.5 text-[12px] text-grey-35">
                <li>• No credit card required</li>
                <li>• Comes with a default AI Customer to run test calls immediately</li>
                <li>• You can create more AI Customers in MockCustomer later</li>
              </ul>
              {error && (
                <div className="mt-3 text-[12px] px-3 py-2 rounded-[8px] bg-[color:var(--danger-bg)] text-[color:var(--danger-fg)]">
                  {error}
                </div>
              )}
            </>
          ) : loginStep === 'credentials' ? (
            <>
              <p className="text-[12px] text-grey-35 mb-3">
                Log in with your existing MockCustomer account. HireFunnel will link to your account and read
                your AI Customers + past recordings.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!submitting && email.trim() && password) void submitLoginStep1()
                }}
                className="space-y-3"
                // Standard email/password inputs so Chrome/1Password/etc autofill.
                autoComplete="on"
              >
                <div>
                  <label htmlFor="mc-email" className="block text-[12px] font-medium text-ink mb-1">
                    Email
                  </label>
                  <input
                    id="mc-email"
                    type="email"
                    name="username"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    autoFocus
                    required
                  />
                </div>
                <div>
                  <label htmlFor="mc-password" className="block text-[12px] font-medium text-ink mb-1">
                    Password
                  </label>
                  <input
                    id="mc-password"
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    required
                  />
                </div>
                {/* Hidden submit so pressing Enter in either field submits. */}
                <button type="submit" hidden />
              </form>
              {error && (
                <div className="mt-3 text-[12px] px-3 py-2 rounded-[8px] bg-[color:var(--danger-bg)] text-[color:var(--danger-fg)]">
                  {error}
                </div>
              )}
            </>
          ) : (
            <>
              <p className="text-[12px] text-grey-35 mb-3">
                Logged in as <span className="font-mono text-grey-15">{email}</span>. Pick which organization to
                link to this HireFunnel workspace.
              </p>
              <ul className="space-y-1">
                {orgs.map((o) => (
                  <li key={o.id}>
                    <label
                      className={`flex items-center gap-2 p-2 rounded-[8px] border cursor-pointer transition-colors ${
                        pickedOrgId === o.id
                          ? 'border-brand-500 bg-brand-50/40'
                          : 'border-surface-border hover:bg-surface-light'
                      }`}
                    >
                      <input
                        type="radio"
                        name="mc-org"
                        value={o.id}
                        checked={pickedOrgId === o.id}
                        onChange={() => setPickedOrgId(o.id)}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-ink truncate">{o.name}</div>
                        <div className="text-[11px] text-grey-50 font-mono">{o.slug}</div>
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
              {error && (
                <div className="mt-3 text-[12px] px-3 py-2 rounded-[8px] bg-[color:var(--danger-bg)] text-[color:var(--danger-fg)]">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-divider flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              if (submitting) return
              setError(null)
              if (branch === 'default') {
                setBranch('login')
                setLoginStep('credentials')
              } else {
                setBranch('default')
                setLoginStep('credentials')
                setGrantToken(null)
                setOrgs([])
                setPassword('')
              }
            }}
            disabled={submitting}
            className="text-[12px] text-grey-50 hover:text-ink disabled:opacity-50"
          >
            {branch === 'default' ? 'I already have an account →' : '← Back to new account'}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-2 rounded-[8px] border border-surface-border text-[12px] text-grey-35 hover:text-ink transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={
                branch === 'default'
                  ? submitDefault
                  : loginStep === 'credentials'
                    ? submitLoginStep1
                    : submitLoginStep2
              }
              disabled={
                submitting ||
                (branch === 'login' &&
                  loginStep === 'credentials' &&
                  (!email.trim() || !password)) ||
                (branch === 'login' && loginStep === 'pick-org' && !pickedOrgId)
              }
              className="px-3 py-2 rounded-[8px] bg-ink text-white text-[12px] font-semibold disabled:opacity-50 hover:bg-grey-15 transition-colors"
            >
              {submitting
                ? branch === 'default'
                  ? 'Connecting…'
                  : loginStep === 'credentials'
                    ? 'Signing in…'
                    : 'Linking…'
                : branch === 'default'
                  ? 'Connect'
                  : loginStep === 'credentials'
                    ? 'Sign in'
                    : 'Link this organization'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
