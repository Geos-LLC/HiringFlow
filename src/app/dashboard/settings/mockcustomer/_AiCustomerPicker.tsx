/**
 * Sub-component for /dashboard/settings/mockcustomer.
 *
 * Renders a select of the workspace's MC AiCustomers (aka "mockcustomers"
 * in the user's vocab) and PATCHes the choice through to MC. MC's
 * behavioral-snapshot-resolver reads Organization.activeAiCustomerId
 * on every dial, so persisting the selection is the entire wiring —
 * no separate flag on the HF-side McWorkspaceMapping needed.
 *
 * Behavior:
 *   - "Loading…" while fetching /api/mc-connection/ai-customers
 *   - "No AI Customers yet — create one in MockCustomer →" empty state
 *     with a deep link (MC ships a default when the org is provisioned,
 *     so this branch is rare in practice)
 *   - Select shows all customers; current active is preselected
 *   - Changing the select fires an immediate PATCH; disables during
 *     the call so double-picks can't race
 */

'use client'

import { useCallback, useEffect, useState } from 'react'

interface AiCustomer {
  id: string
  name: string
  createdAt: string
}

interface ListResponse {
  organizationId: string
  organizationSlug: string
  activeAiCustomerId: string | null
  aiCustomers: AiCustomer[]
}

export function AiCustomerPicker() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<ListResponse | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/mc-connection/ai-customers')
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string }
        setError(body.error ?? `Failed to load AI Customers (${res.status})`)
        setData(null)
        return
      }
      setData((await res.json()) as ListResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AI Customers')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onChange = useCallback(async (aiCustomerId: string) => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/mc-connection/ai-customers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiCustomerId }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Save failed (${res.status})`)
        return
      }
      // Local echo so the UI reflects the change without a full reload.
      setData((prev) => (prev ? { ...prev, activeAiCustomerId: aiCustomerId } : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [])

  return (
    <div className="mt-5 pt-5 border-t border-surface-divider">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[13px] font-semibold text-ink">Which AI Customer to use?</h2>
        {saving && <span className="text-[11px] text-grey-50">Saving…</span>}
      </div>
      <p className="text-[12px] text-grey-50 mb-3">
        Applies to every simulation run from this workspace. Change any time.
      </p>

      {loading ? (
        <div className="text-[12px] text-grey-50">Loading…</div>
      ) : !data ? (
        <div className="text-[12px] text-rose-700">{error ?? 'Failed to load.'}</div>
      ) : data.aiCustomers.length === 0 ? (
        <div className="text-[12px] text-grey-50">
          No AI Customers yet.{' '}
          <a
            href="https://mockcustomer.vercel.app/dashboard/ai-customer"
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-600 hover:underline"
          >
            Create one in MockCustomer →
          </a>
        </div>
      ) : (
        <>
          <select
            value={data.activeAiCustomerId ?? data.aiCustomers[0]?.id ?? ''}
            onChange={(e) => void onChange(e.target.value)}
            disabled={saving}
            className="w-full max-w-md px-3 py-2 border border-surface-border rounded-[10px] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50"
          >
            {data.aiCustomers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {error && (
            <div className="mt-2 text-[12px] text-rose-700" role="alert">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  )
}
