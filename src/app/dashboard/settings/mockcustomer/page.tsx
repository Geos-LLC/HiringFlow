/**
 * Workspace settings — MockCustomer connection.
 *
 * Minimal management surface: shows current connection state + a
 * disconnect button. Deep-link to MC dashboard for anything else
 * (persona/scenario config, transcripts, billing — MC owns those).
 */

'use client'

import { useCallback, useEffect, useState } from 'react'

interface Status {
  connected: boolean
  mcOrganizationSlug: string | null
  mcEnvironment: 'test' | 'live' | null
  connectedAt: string | null
}

export default function McSettingsPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/mc-connection/status')
      if (!res.ok) {
        setStatus({ connected: false, mcOrganizationSlug: null, mcEnvironment: null, connectedAt: null })
        return
      }
      setStatus((await res.json()) as Status)
    } catch {
      setStatus({ connected: false, mcOrganizationSlug: null, mcEnvironment: null, connectedAt: null })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const disconnect = useCallback(async () => {
    if (!confirm('Disconnect MockCustomer? Existing simulation history stays; new simulations will be blocked until reconnected.')) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/mc-connection', { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Disconnect failed (${res.status})`)
        return
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed')
    } finally {
      setSubmitting(false)
    }
  }, [load])

  const reconnect = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/mc-connection/connect', { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Reconnect failed (${res.status})`)
        return
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reconnect failed')
    } finally {
      setSubmitting(false)
    }
  }, [load])

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-lg font-semibold text-ink mb-4">MockCustomer</h1>
      <p className="text-[13px] text-grey-50 mb-6">
        MockCustomer runs AI-driven test calls with your candidates and returns evaluations to HireFunnel.
      </p>

      {status === null ? (
        <div className="text-[13px] text-grey-50">Loading…</div>
      ) : status.connected ? (
        <div className="bg-white rounded-[12px] border border-surface-border p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>
            <span className="text-[13px] font-semibold text-ink">Connected</span>
          </div>
          <dl className="text-[12px] space-y-1.5">
            <div className="flex gap-2">
              <dt className="text-grey-50 w-32">Organization</dt>
              <dd className="font-mono text-grey-15">{status.mcOrganizationSlug}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-grey-50 w-32">Environment</dt>
              <dd className="font-mono text-grey-15">{status.mcEnvironment}</dd>
            </div>
            {status.connectedAt && (
              <div className="flex gap-2">
                <dt className="text-grey-50 w-32">Connected</dt>
                <dd className="font-mono text-grey-15">{new Date(status.connectedAt).toLocaleString()}</dd>
              </div>
            )}
          </dl>

          {error && (
            <div className="mt-3 text-[12px] px-3 py-2 rounded-[8px] bg-[color:var(--danger-bg)] text-[color:var(--danger-fg)]">
              {error}
            </div>
          )}

          <div className="mt-5 flex gap-2">
            <a
              href="https://mockcustomer.vercel.app/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 rounded-[8px] border border-surface-border text-[12px] text-ink hover:bg-surface-light transition-colors"
            >
              Open in MockCustomer ↗
            </a>
            <button
              type="button"
              onClick={disconnect}
              disabled={submitting}
              className="px-3 py-2 rounded-[8px] border border-rose-200 text-[12px] text-rose-700 hover:bg-rose-50 transition-colors disabled:opacity-50"
            >
              {submitting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-[12px] border border-surface-border p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-block w-2 h-2 rounded-full bg-grey-35"></span>
            <span className="text-[13px] font-semibold text-ink">Not connected</span>
          </div>
          <p className="text-[12px] text-grey-50 mb-4">
            Connect MockCustomer to enable AI Customer Simulations on candidate pages.
          </p>
          {error && (
            <div className="mb-3 text-[12px] px-3 py-2 rounded-[8px] bg-[color:var(--danger-bg)] text-[color:var(--danger-fg)]">
              {error}
            </div>
          )}
          <button
            type="button"
            onClick={reconnect}
            disabled={submitting}
            className="px-3 py-2 rounded-[8px] bg-ink text-white text-[12px] font-semibold hover:bg-grey-15 transition-colors disabled:opacity-50"
          >
            {submitting ? 'Connecting…' : 'Connect MockCustomer'}
          </button>
        </div>
      )}
    </div>
  )
}
