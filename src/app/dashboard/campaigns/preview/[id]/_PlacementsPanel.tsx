'use client'

/**
 * Manual placement log for the per-ad preview. Recruiter clicks "Mark
 * as posted" after publishing on Indeed / Craigslist / Facebook / etc.,
 * paste the URL, pick the source and date. One ad → many rows
 * (multi-board and re-posts). No async status — this is a pure
 * bookkeeping surface.
 *
 * Distinct from the Telegram send history above, which is fully
 * automated with async status callbacks.
 */

import { useEffect, useState } from 'react'

interface Placement {
  id: string
  source: string
  url: string | null
  postedAt: string
  note: string | null
  createdAt: string
}

const SOURCE_OPTIONS = [
  'indeed', 'facebook', 'craigslist', 'linkedin', 'google',
  'work.ua', 'bazar', 'olx', 'telegram', 'referral', 'other',
]

function todayInputValue(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function PlacementsPanel({ adId, defaultSource }: { adId: string; defaultSource?: string }) {
  const [placements, setPlacements] = useState<Placement[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [source, setSource] = useState(defaultSource || 'indeed')
  const [url, setUrl] = useState('')
  const [postedAt, setPostedAt] = useState(todayInputValue())
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const r = await fetch(`/api/ads/${adId}/placements`)
    if (r.ok) {
      const d = await r.json() as { placements: Placement[] }
      setPlacements(d.placements)
    }
    setLoading(false)
  }

  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [adId])

  async function save() {
    setError(null)
    setSaving(true)
    try {
      const r = await fetch(`/api/ads/${adId}/placements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          url: url.trim() || null,
          postedAt: new Date(`${postedAt}T12:00:00`).toISOString(),
          note: note.trim() || null,
        }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      setUrl('')
      setNote('')
      setPostedAt(todayInputValue())
      setAdding(false)
      await load()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  async function remove(p: Placement) {
    if (!confirm(`Remove ${p.source} placement from ${new Date(p.postedAt).toLocaleDateString()}?`)) return
    const r = await fetch(`/api/ads/${adId}/placements/${p.id}`, { method: 'DELETE' })
    if (r.ok) await load()
  }

  if (loading) return null

  return (
    <div id="placements" className="max-w-2xl mx-auto mt-6 bg-white border border-surface-border rounded-[12px] overflow-hidden">
      <div className="px-4 py-2 bg-surface flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-grey-40">
          Posting log ({placements.length})
        </div>
        <button
          onClick={() => setAdding(v => !v)}
          className="text-xs px-2 py-1 text-brand-600 hover:text-brand-700 font-medium"
        >
          {adding ? 'Cancel' : '+ Mark as posted'}
        </button>
      </div>

      {adding && (
        <div className="px-4 py-3 bg-surface-light/40 border-b border-surface-border">
          <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr_130px] gap-2 mb-2">
            <select
              value={source}
              onChange={e => setSource(e.target.value)}
              className="px-2 py-1.5 text-[13px] border border-surface-border rounded-[6px] bg-white capitalize"
            >
              {SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="URL where you posted it (optional)"
              className="px-2 py-1.5 text-[13px] border border-surface-border rounded-[6px] bg-white"
            />
            <input
              type="date"
              value={postedAt}
              onChange={e => setPostedAt(e.target.value)}
              max={todayInputValue()}
              className="px-2 py-1.5 text-[13px] border border-surface-border rounded-[6px] bg-white"
            />
          </div>
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Note (e.g. Miami-Dade board, expires in 30d)"
            className="w-full px-2 py-1.5 text-[13px] border border-surface-border rounded-[6px] bg-white mb-2"
          />
          {error && <div className="text-[11px] text-red-600 mb-2">{error}</div>}
          <div className="flex justify-end">
            <button
              onClick={save}
              disabled={saving || !source}
              className="text-xs px-3 py-1.5 bg-brand-500 text-white rounded-[6px] hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save posting'}
            </button>
          </div>
        </div>
      )}

      {placements.length === 0 && !adding && (
        <div className="px-4 py-6 text-[12px] text-grey-40 text-center">
          No postings logged yet. Click <b>+ Mark as posted</b> after publishing this ad on a job board.
        </div>
      )}

      <div className="divide-y divide-surface-border">
        {placements.map(p => (
          <div key={p.id} className="px-4 py-3 flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-green-100 text-green-700 capitalize">
                  {p.source}
                </span>
                <span className="text-[12px] text-grey-15">
                  {new Date(p.postedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
                {p.url && (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-brand-600 hover:text-brand-700 truncate max-w-[280px]"
                    title={p.url}
                  >
                    ↗ {p.url.replace(/^https?:\/\//, '').slice(0, 40)}{p.url.length > 40 ? '…' : ''}
                  </a>
                )}
              </div>
              {p.note && <div className="text-[12px] text-grey-40 mt-1">{p.note}</div>}
            </div>
            <button
              onClick={() => remove(p)}
              className="text-xs px-2 py-1 text-red-500 hover:text-red-700"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
