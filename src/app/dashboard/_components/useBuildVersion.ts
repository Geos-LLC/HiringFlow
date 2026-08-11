'use client'

import { useEffect, useState } from 'react'

/**
 * Detects when a newer frontend build has shipped while this dashboard tab
 * has been open. Mechanism:
 *
 *   - next.config.js bakes NEXT_PUBLIC_BUILD_VERSION (Vercel commit SHA
 *     prefix) into the client bundle at build time.
 *   - /version.json is a route handler on the live deploy that returns the
 *     same value from process.env.VERCEL_GIT_COMMIT_SHA.
 *   - This hook fetches /version.json periodically; a mismatch means the
 *     bundle in this tab is stale → UpdateAvailableBanner prompts a reload.
 *
 * Polling cadence:
 *   - Once on mount.
 *   - Every 5 minutes while the tab is mounted.
 *   - On every visibilitychange → visible (users returning to a tab left
 *     open for hours is the common case).
 *
 * Dev mode (NEXT_PUBLIC_BUILD_VERSION === 'dev') skips the poll — the
 * banner would fire constantly against a running dev server.
 */

const POLL_INTERVAL_MS = 5 * 60_000

export interface BuildVersionState {
  current: string
  latest: string | null
  updateAvailable: boolean
  reload: () => void
}

export function useBuildVersion(): BuildVersionState {
  const current = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev'
  const [latest, setLatest] = useState<string | null>(null)

  useEffect(() => {
    if (current === 'dev') return

    let cancelled = false

    const check = async () => {
      try {
        const r = await fetch('/version.json', { cache: 'no-store' })
        if (!r.ok) return
        const j = (await r.json()) as { version?: string }
        if (cancelled) return
        if (typeof j.version === 'string' && j.version && j.version !== current) {
          setLatest(j.version)
        }
      } catch {
        // Network blip — retry on next tick. Never log; a flaky connection
        // shouldn't spam the console every 5 minutes.
      }
    }

    void check()
    const id = window.setInterval(check, POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [current])

  return {
    current,
    latest,
    updateAvailable: latest !== null && latest !== current,
    reload: () => window.location.reload(),
  }
}
