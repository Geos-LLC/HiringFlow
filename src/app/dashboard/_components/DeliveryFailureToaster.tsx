/**
 * Polls /api/notifications/delivery-failures every 60s and pops a red
 * toast for each new failure the recruiter hasn't seen yet.
 *
 * "Seen" state lives in localStorage keyed per workspace + execution id.
 * On first ever load we set the high-water mark to now() so historical
 * failures don't flood the user. A failure surfaces if its
 * deliveryStatusAt is newer than the high-water mark AND its execution
 * id isn't already in the seen set.
 *
 * The bounce-retry fallback (src/lib/bounce-retry.ts) clears
 * deliveryStatus on a retry. If the retry succeeds, the row disappears
 * from this endpoint's results — so toasts effectively self-rescind. If
 * the retry also fails, a new event flips deliveryStatus back to blocked
 * and we toast once (deduped by execution id + bounceRetried flag).
 */

'use client'

import { useEffect, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { toast } from 'sonner'

type Item = {
  id: string
  sessionId: string | null
  candidateName: string | null
  candidateEmail: string | null
  ruleName: string | null
  deliveryStatus: string | null
  deliveryErrorMessage: string | null
  deliveryStatusAt: string | null
  bounceRetried: boolean
}

const POLL_MS = 60_000

function highWaterKey(workspaceId: string) {
  return `hf:delivery-failures:high-water:${workspaceId}`
}
function seenKey(workspaceId: string) {
  return `hf:delivery-failures:seen:${workspaceId}`
}

function loadSeen(workspaceId: string): Set<string> {
  try {
    const raw = localStorage.getItem(seenKey(workspaceId))
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}
function persistSeen(workspaceId: string, seen: Set<string>) {
  try {
    // Cap at 500 to keep storage bounded; older ids age out.
    const arr = Array.from(seen).slice(-500)
    localStorage.setItem(seenKey(workspaceId), JSON.stringify(arr))
  } catch {
    /* quota — drop silently */
  }
}

function loadHighWater(workspaceId: string): string {
  try {
    const v = localStorage.getItem(highWaterKey(workspaceId))
    if (v) return v
  } catch { /* ignore */ }
  // First ever load: set high-water to now so old failures don't toast.
  const now = new Date().toISOString()
  try { localStorage.setItem(highWaterKey(workspaceId), now) } catch { /* ignore */ }
  return now
}
function persistHighWater(workspaceId: string, iso: string) {
  try { localStorage.setItem(highWaterKey(workspaceId), iso) } catch { /* ignore */ }
}

function describeFailure(it: Item): string {
  const who = it.candidateName || it.candidateEmail || 'A candidate'
  const status = it.deliveryStatus === 'dropped' ? 'dropped' : it.deliveryStatus === 'bounce' ? 'bounced' : 'blocked'
  return `${who} — email ${status}${it.bounceRetried ? ' (retry also failed)' : ''}`
}

export function DeliveryFailureToaster() {
  const { data: session } = useSession()
  const workspaceId = (session?.user as { workspaceId?: string } | undefined)?.workspaceId
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!workspaceId) return

    let cancelled = false

    async function tick() {
      if (cancelled || inFlightRef.current || !workspaceId) return
      inFlightRef.current = true
      try {
        const since = loadHighWater(workspaceId)
        const res = await fetch(`/api/notifications/delivery-failures?since=${encodeURIComponent(since)}`, {
          cache: 'no-store',
        })
        if (!res.ok) return
        const data = (await res.json()) as { items?: Item[] }
        const items = data.items ?? []
        if (items.length === 0) return

        const seen = loadSeen(workspaceId)
        let newest = since
        for (const it of items) {
          if (it.deliveryStatusAt && it.deliveryStatusAt > newest) newest = it.deliveryStatusAt
          if (seen.has(it.id)) continue
          seen.add(it.id)
          toast.error(describeFailure(it), {
            description: it.deliveryErrorMessage?.slice(0, 240) || it.ruleName || 'Delivery failed',
            action: it.sessionId
              ? {
                  label: 'Open candidate',
                  onClick: () => { window.location.href = `/dashboard/candidates/${it.sessionId}` },
                }
              : undefined,
            duration: 12_000,
          })
        }
        persistSeen(workspaceId, seen)
        persistHighWater(workspaceId, newest)
      } catch {
        /* polling errors are silent; we'll retry next tick */
      } finally {
        inFlightRef.current = false
      }
    }

    // Fire once immediately, then on interval.
    tick()
    pollRef.current = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [workspaceId])

  return null
}
