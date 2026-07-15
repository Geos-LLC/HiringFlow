'use client'

import { useEffect, useMemo, useState } from 'react'

export interface VideoLibraryItem {
  id: string
  filename: string
  displayName?: string | null
  url?: string
  kind?: string
  durationSeconds?: number | null
  posterUrl?: string | null
  transcript?: string | null
  createdAt?: string
}

interface Props {
  open: boolean
  onClose: () => void
  onSelect: (video: VideoLibraryItem) => void
  videos: VideoLibraryItem[]
  // Which video is currently selected (highlighted in the list, if any).
  selectedId?: string | null
  // Optional label override for the header.
  title?: string
}

type KindFilter = 'all' | 'interview' | 'training'

function fmtDuration(seconds?: number | null): string {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '—'
  const min = Math.floor(seconds / 60)
  const sec = Math.round(seconds % 60)
  if (min === 0) return `${sec}s`
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`
}

function labelOf(v: VideoLibraryItem): string {
  return v.displayName || v.filename?.replace(/\.[^.]+$/, '') || 'Untitled video'
}

/**
 * Cross-library video picker. Replaces the dropdown+upload combo in the flow
 * builder so recruiters can browse ALL their videos (both interview-kind and
 * training-kind), search by name/transcript, and see thumbnails + duration
 * before picking. Same component used from the Add Step modal and the popup
 * step editor.
 */
export function VideoPickerModal({ open, onClose, onSelect, videos, selectedId, title = 'Choose a video' }: Props) {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')

  // Reset search state when the modal reopens so a stale query from a
  // previous session doesn't hide videos on next launch.
  useEffect(() => {
    if (open) {
      setQ('')
      setKind('all')
    }
  }, [open])

  const counts = useMemo(() => {
    const c = { all: videos.length, interview: 0, training: 0 }
    for (const v of videos) {
      if (v.kind === 'interview') c.interview++
      else if (v.kind === 'training') c.training++
    }
    return c
  }, [videos])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return videos.filter((v) => {
      if (kind !== 'all' && v.kind !== kind) return false
      if (!needle) return true
      const hay = `${labelOf(v)} ${v.filename || ''} ${v.transcript || ''}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [videos, q, kind])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-[60]"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-[12px] shadow-2xl w-full max-w-[720px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 pb-3 border-b border-surface-border">
          <h2 className="text-lg font-semibold text-grey-15">{title}</h2>
          <button onClick={onClose} className="text-grey-40 hover:text-grey-15 text-xl leading-none">&times;</button>
        </div>

        <div className="p-5 pt-4 space-y-3 border-b border-surface-border">
          <input
            type="text"
            placeholder="Search by name or transcript…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-surface-border rounded-[8px] focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            autoFocus
          />
          <div className="flex gap-2">
            {([
              { k: 'all' as const, label: 'All', n: counts.all },
              { k: 'interview' as const, label: 'Interview', n: counts.interview },
              { k: 'training' as const, label: 'Training', n: counts.training },
            ]).map(({ k, label, n }) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  kind === k
                    ? 'bg-brand-500 text-white border-brand-500'
                    : 'bg-white text-grey-35 border-surface-border hover:border-brand-300'
                }`}
              >
                {label} · {n}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {filtered.length === 0 ? (
            <div className="p-12 text-center text-sm text-grey-40">
              {videos.length === 0 ? "You don't have any videos yet." : 'No videos match your search.'}
            </div>
          ) : (
            <ul className="space-y-1">
              {filtered.map((v) => {
                const isSelected = v.id === selectedId
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => { onSelect(v); onClose() }}
                      className={`w-full flex items-center gap-3 p-2.5 rounded-[8px] text-left transition-colors ${
                        isSelected
                          ? 'bg-brand-50 border border-brand-200'
                          : 'border border-transparent hover:bg-surface-light'
                      }`}
                    >
                      {/* Poster / placeholder */}
                      <div className="w-20 h-12 rounded-[6px] bg-[#F1F1F3] flex-shrink-0 overflow-hidden flex items-center justify-center">
                        {v.posterUrl ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img src={v.posterUrl} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <svg className="w-5 h-5 text-grey-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-grey-15 truncate">{labelOf(v)}</div>
                        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-grey-40">
                          <span>{fmtDuration(v.durationSeconds)}</span>
                          {v.kind && (
                            <>
                              <span>·</span>
                              <span className={`px-1.5 py-0.5 rounded-full ${v.kind === 'training' ? 'bg-blue-100 text-blue-700' : 'bg-brand-100 text-brand-700'}`}>
                                {v.kind}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      {isSelected && (
                        <span className="text-brand-500 text-lg leading-none">✓</span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
