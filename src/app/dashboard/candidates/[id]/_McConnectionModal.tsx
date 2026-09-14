/**
 * Modal that walks a workspace through connecting MockCustomer.
 *
 * Two branches:
 *   - Default ("Connect") — hits POST /api/mc-connection/connect which
 *     provisions an MC organization + api key server-side, no user
 *     input needed. This is the recommended path for the ~99% of
 *     workspaces who don't already have MC.
 *   - "I already have an account" — reveals a form for pasting an
 *     existing api key + webhook secret + slug. Hits
 *     POST /api/mc-connection/manual, which validates the key
 *     against MC before storing.
 *
 * On success either branch calls `onConnected(status)` and the parent
 * unmounts the modal.
 */

'use client'

import { useCallback, useState } from 'react'

export interface McConnectionStatus {
  connected: boolean
  mcOrganizationSlug: string | null
  mcEnvironment: 'test' | 'live' | null
}

interface Props {
  onClose: () => void
  onConnected: (status: McConnectionStatus) => void
}

type Branch = 'default' | 'manual'

export function McConnectionModal({ onClose, onConnected }: Props) {
  const [branch, setBranch] = useState<Branch>('default')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Manual-branch form state.
  const [apiKey, setApiKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [orgSlug, setOrgSlug] = useState('')

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

  const submitManual = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/mc-connection/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          webhookSecret: webhookSecret.trim(),
          mcOrganizationSlug: orgSlug.trim(),
        }),
      })
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
  }, [apiKey, webhookSecret, orgSlug, onConnected])

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
                MockCustomer places AI-driven test calls to candidates and returns evaluations directly on the
                candidate detail page.
              </p>
              <ul className="mt-3 space-y-1.5 text-[12px] text-grey-35">
                <li>• Free during beta — no credit card required</li>
                <li>• Uses your HireFunnel account (no separate signup)</li>
                <li>• Ready to use in ~3 seconds</li>
              </ul>

              {error && (
                <div className="mt-3 text-[12px] px-3 py-2 rounded-[8px] bg-[color:var(--danger-bg)] text-[color:var(--danger-fg)]">
                  {error}
                </div>
              )}
            </>
          ) : (
            <>
              <p className="text-[12px] text-grey-35 mb-3">
                Paste credentials from your MockCustomer dashboard.
              </p>
              <div className="space-y-3">
                <div>
                  <label className="block text-[12px] font-medium text-ink mb-1">Organization slug</label>
                  <input
                    type="text"
                    value={orgSlug}
                    onChange={(e) => setOrgSlug(e.target.value)}
                    placeholder="my-org"
                    className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40 font-mono"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-ink mb-1">API key</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="mc_live_…"
                    className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40 font-mono"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-ink mb-1">Webhook secret</label>
                  <input
                    type="password"
                    value={webhookSecret}
                    onChange={(e) => setWebhookSecret(e.target.value)}
                    placeholder="whsec_…"
                    className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40 font-mono"
                    autoComplete="off"
                  />
                </div>
              </div>

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
              setBranch((b) => (b === 'default' ? 'manual' : 'default'))
            }}
            disabled={submitting}
            className="text-[12px] text-grey-50 hover:text-ink disabled:opacity-50"
          >
            {branch === 'default' ? 'I already have an account →' : '← Back to auto-connect'}
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
              onClick={branch === 'default' ? submitDefault : submitManual}
              disabled={
                submitting ||
                (branch === 'manual' &&
                  (!apiKey.trim() || !webhookSecret.trim() || !orgSlug.trim()))
              }
              className="px-3 py-2 rounded-[8px] bg-ink text-white text-[12px] font-semibold disabled:opacity-50 hover:bg-grey-15 transition-colors"
            >
              {submitting ? 'Connecting…' : branch === 'default' ? 'Connect' : 'Save & connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
