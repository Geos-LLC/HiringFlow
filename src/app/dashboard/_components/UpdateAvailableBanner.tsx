'use client'

import { useBuildVersion } from './useBuildVersion'

/**
 * Fixed bottom-right toast that appears when /version.json reports a newer
 * build than the one this tab loaded. Clicking "Reload" hard-refreshes.
 *
 * Renders nothing when no update is available. Safe to mount once at the
 * dashboard layout — the underlying hook handles polling + cleanup.
 *
 * Why: operator dashboard tabs stay open for hours; without this, recruiters
 * see stale UI (missing new buttons, old copy) until they manually refresh.
 * Ported from LeadBridge's useBuildVersion / UpdateAvailableBanner pair.
 */
export function UpdateAvailableBanner() {
  const { updateAvailable, reload } = useBuildVersion()
  if (!updateAvailable) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 right-5 z-[9999] flex items-center gap-3 px-4 py-2.5 rounded-[14px] bg-ink text-white text-[13px] font-medium shadow-[0_10px_32px_rgba(0,0,0,0.22)] max-w-[calc(100vw-40px)]"
    >
      <span className="inline-flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
        Update available
      </span>
      <button
        type="button"
        onClick={reload}
        title="Reload to pick up the latest version"
        className="px-4 py-1.5 rounded-lg bg-[color:var(--brand-primary)] text-white text-[13px] font-bold cursor-pointer hover:brightness-110 transition"
      >
        Reload
      </button>
    </div>
  )
}
