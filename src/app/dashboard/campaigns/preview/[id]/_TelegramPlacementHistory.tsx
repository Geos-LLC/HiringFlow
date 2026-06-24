'use client'

/**
 * Compact send-history strip for the per-ad preview. Renders the last N
 * Telegram placements for the ad with status pill + cancel button for any
 * not-yet-terminal row. Polls every 15s while any row is in a non-terminal
 * state so the recruiter sees Sigcore callbacks land without refreshing.
 *
 * Mounted via `refreshKey` — bumping the prop from the parent (e.g. after
 * the publish modal dispatches) forces an immediate reload.
 */

import { useEffect, useRef, useState } from 'react'

interface Placement {
  id: string
  status: 'queued' | 'scheduled' | 'sent' | 'failed' | 'cancelled'
  scheduledAt: string | null
  sentAt: string | null
  failedAt: string | null
  cancelledAt: string | null
  providerMessageId: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  channel: { id: string; chatRef: string; displayName: string | null }
}

const NON_TERMINAL = new Set(['queued', 'scheduled'])

export function TelegramPlacementHistory({ adId, refreshKey }: { adId: string; refreshKey: number }) {
  const [placements, setPlacements] = useState<Placement[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelBusy, setCancelBusy] = useState<string | null>(null)
  const pollTimer = useRef<number | null>(null)

  async function load() {
    const r = await fetch(`/api/ads/${adId}/telegram-placements`)
    if (!r.ok) {
      setLoading(false)
      return
    }
    const d = (await r.json()) as { placements: Placement[] }
    setPlacements(d.placements)
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [adId, refreshKey])

  useEffect(() => {
    const hasPending = placements.some((p) => NON_TERMINAL.has(p.status))
    if (!hasPending) return
    pollTimer.current = window.setInterval(load, 15_000)
    return () => {
      if (pollTimer.current !== null) {
        clearInterval(pollTimer.current)
        pollTimer.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placements])

  async function cancel(p: Placement) {
    if (!confirm(`Cancel placement to ${p.channel.chatRef}?`)) return
    setCancelBusy(p.id)
    try {
      await fetch(`/api/integrations/telegram/placements/${p.id}/cancel`, { method: 'POST' })
      await load()
    } finally {
      setCancelBusy(null)
    }
  }

  if (loading) return null
  if (placements.length === 0) return null

  return (
    <div className="max-w-2xl mx-auto mt-6 bg-white border border-surface-border rounded-[12px] overflow-hidden">
      <div className="px-4 py-2 bg-surface text-xs uppercase tracking-wide text-grey-40">
        Telegram send history ({placements.length})
      </div>
      <div className="divide-y divide-surface-border">
        {placements.map((p) => (
          <div key={p.id} className="px-4 py-3 flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <code className="font-mono text-sm text-grey-15">{p.channel.chatRef}</code>
                <StatusPill status={p.status} />
              </div>
              <div className="text-xs text-grey-50 mt-1">
                {p.status === 'sent' && p.sentAt && <>Sent {new Date(p.sentAt).toLocaleString()}</>}
                {p.status === 'failed' && p.failedAt && <>Failed {new Date(p.failedAt).toLocaleString()}</>}
                {p.status === 'scheduled' && p.scheduledAt && <>Scheduled {new Date(p.scheduledAt).toLocaleString()}</>}
                {p.status === 'queued' && <>Queued {new Date(p.createdAt).toLocaleString()}</>}
                {p.status === 'cancelled' && p.cancelledAt && <>Cancelled {new Date(p.cancelledAt).toLocaleString()}</>}
              </div>
              {p.errorMessage && <div className="text-xs text-red-600 mt-1">{p.errorMessage}</div>}
              {p.providerMessageId && <div className="text-xs text-grey-50 mt-1 font-mono">msg id: {p.providerMessageId}</div>}
            </div>
            {NON_TERMINAL.has(p.status) && (
              <button
                onClick={() => cancel(p)}
                disabled={cancelBusy === p.id}
                className="text-xs px-2 py-1 text-red-500 hover:text-red-700 disabled:opacity-50"
              >
                {cancelBusy === p.id ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: Placement['status'] }) {
  const map: Record<Placement['status'], { cls: string }> = {
    queued: { cls: 'bg-blue-100 text-blue-700' },
    scheduled: { cls: 'bg-blue-100 text-blue-700' },
    sent: { cls: 'bg-green-100 text-green-700' },
    failed: { cls: 'bg-red-100 text-red-700' },
    cancelled: { cls: 'bg-gray-100 text-grey-40' },
  }
  return <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wide ${map[status].cls}`}>{status}</span>
}
