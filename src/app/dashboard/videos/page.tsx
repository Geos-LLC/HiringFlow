'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { SubNav } from '../_components/SubNav'
import { Card, Eyebrow, PageHeader, WipBadge } from '@/components/design'
import { useUploads } from '../_components/UploadProvider'
import { DashboardVideoPreview } from '../_components/DashboardVideoPreview'

const ASSETS_NAV = [
  { href: '/dashboard/content', label: 'Templates' },
  { href: '/dashboard/videos', label: 'Media' },
]

type VideoKind = 'interview' | 'training'
type Tab = VideoKind | 'pictures'

interface Video {
  id: string
  filename: string
  displayName?: string
  summary?: string
  mimeType: string
  sizeBytes: number
  durationSeconds?: number | null
  kind: VideoKind
  createdAt: string
  url: string
  // R2/HLS pipeline (2026-05-14): status is 'ready' for legacy Vercel Blob
  // videos AND for new uploads that finished transcoding. 'transcoding'/'uploading'
  // mean Lambda is still processing; 'failed' means the Lambda gave up.
  status?: string
  hlsManifestUrl?: string | null
  posterUrl?: string | null
  transcodeError?: string | null
}

interface Picture {
  id: string
  filename: string
  displayName?: string | null
  url: string
  mimeType: string
  sizeBytes: number
  createdAt: string
}

function fmtFileSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
function fmtDuration(s?: number | null) {
  if (!s || !isFinite(s)) return null
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function MediaPage() {
  const [tab, setTab] = useState<Tab>('training')
  const [videos, setVideos] = useState<Video[]>([])
  const [pictures, setPictures] = useState<Picture[]>([])
  const [pictureUploads, setPictureUploads] = useState<Array<{ filename: string; progress: number; status: 'pending' | 'uploading' | 'success' | 'error'; error?: string }>>([])
  // Video uploads now live in the dashboard-level UploadProvider so they
  // survive tab navigation. Pictures still upload synchronously (smaller,
  // single API call), so we keep their state local.
  const { uploads: videoUploads, startUpload: startVideoUpload, clearFinished, successTick } = useUploads()
  const [playing, setPlaying] = useState<string | null>(null)
  // Global display preference: show AI displayName or fall back to file name.
  // Persisted in localStorage so it survives reloads.
  const [useAutoName, setUseAutoName] = useState(true)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem('media:useAutoName')
    if (stored === 'false') setUseAutoName(false)
    else if (stored === 'true') setUseAutoName(true)
  }, [])
  const toggleUseAutoName = (next: boolean) => {
    setUseAutoName(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('media:useAutoName', next ? 'true' : 'false')
    }
  }

  const fetchVideos = useCallback(async () => {
    const res = await fetch('/api/videos')
    if (res.ok) setVideos(await res.json())
  }, [])
  const fetchPictures = useCallback(async () => {
    const res = await fetch('/api/pictures')
    if (res.ok) setPictures(await res.json())
  }, [])

  useEffect(() => { fetchVideos(); fetchPictures() }, [fetchVideos, fetchPictures])

  // Refetch the videos list whenever an upload succeeds in the global
  // provider — covers the case where the recruiter starts an upload here,
  // navigates to /candidates, comes back, and expects to see the new row.
  useEffect(() => { if (successTick > 0) fetchVideos() }, [successTick, fetchVideos])

  // Poll for transcode status while any video is still processing. We refetch
  // the whole list (cheap, returns once status flips) every 8 s so the
  // "Transcoding..." badge auto-clears without forcing a page refresh.
  useEffect(() => {
    const anyPending = videos.some((v) => v.status === 'transcoding' || v.status === 'uploading')
    if (!anyPending) return
    const id = setInterval(() => { fetchVideos() }, 8000)
    return () => clearInterval(id)
  }, [videos, fetchVideos])

  const counts = {
    interview: videos.filter((v) => v.kind === 'interview').length,
    training: videos.filter((v) => v.kind === 'training').length,
    pictures: pictures.length,
  }

  const [copiedId, setCopiedId] = useState<string | null>(null)
  const copyShareLink = async (videoId: string) => {
    const url = `${window.location.origin}/preview/video/${videoId}`
    try { await navigator.clipboard.writeText(url) } catch { /* swallow — fallback prompt below */ return prompt('Copy this share link:', url) ?? undefined }
    setCopiedId(videoId)
    setTimeout(() => setCopiedId((curr) => (curr === videoId ? null : curr)), 1800)
  }

  const deleteVideo = async (id: string) => {
    if (!confirm('Delete this video?')) return
    setVideos((prev) => prev.filter((v) => v.id !== id))
    await fetch(`/api/videos/${id}`, { method: 'DELETE' })
  }
  const reclassifyVideo = async (id: string, kind: VideoKind) => {
    setVideos((prev) => prev.map((v) => (v.id === id ? { ...v, kind } : v)))
    await fetch(`/api/videos/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    })
  }

  const deletePicture = async (id: string) => {
    if (!confirm('Delete this image?')) return
    setPictures((prev) => prev.filter((p) => p.id !== id))
    await fetch(`/api/pictures/${id}`, { method: 'DELETE' })
  }

  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>, kind: VideoKind) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    e.target.value = ''
    // Fire all uploads in parallel through the global provider — they keep
    // running even if the recruiter navigates to another dashboard tab.
    // The provider also handles the beforeunload guard.
    files.forEach((file) => { startVideoUpload(file, kind) })
  }

  const uploadSinglePicture = async (file: File, index: number) => {
    try {
      setPictureUploads((prev) => prev.map((u, i) => (i === index ? { ...u, status: 'uploading', progress: 20 } : u)))
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/pictures', { method: 'POST', body: formData })
      if (!res.ok) throw new Error('Upload failed')
      setPictureUploads((prev) => prev.map((u, i) => (i === index ? { ...u, progress: 100, status: 'success' } : u)))
    } catch {
      setPictureUploads((prev) => prev.map((u, i) => (i === index ? { ...u, status: 'error', error: 'Upload failed' } : u)))
    }
  }

  const handlePictureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setPictureUploads(files.map((f) => ({ filename: f.name, progress: 0, status: 'pending' as const })))
    for (let i = 0; i < files.length; i++) await uploadSinglePicture(files[i], i)
    await fetchPictures()
    e.target.value = ''
    setTimeout(() => setPictureUploads([]), 3000)
  }

  // Active "upload in flight or just-finished" row from the global provider,
  // merged with synchronous picture uploads. We render both lists below.
  const uploading = videoUploads.some((u) => u.status === 'pending' || u.status === 'uploading') ||
    pictureUploads.some((u) => u.status === 'pending' || u.status === 'uploading')

  const tabs: Array<{ k: Tab; l: string; count: number; hint: string }> = [
    { k: 'interview', l: 'Interview videos', count: counts.interview, hint: 'Short clips used in flow steps (usually under a minute).' },
    { k: 'training', l: 'Training videos', count: counts.training, hint: 'Longer videos used as training lessons.' },
    { k: 'pictures', l: 'Pictures', count: counts.pictures, hint: 'Cover images and other artwork.' },
  ]

  const uploadButton = tab === 'pictures' ? (
    <label className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-[10px] text-white font-semibold text-[13px] cursor-pointer" style={{ background: 'var(--brand-primary)' }}>
      {uploading ? 'Uploading…' : '+ Upload image'}
      <input type="file" accept="image/*" multiple onChange={handlePictureUpload} disabled={uploading} className="hidden" />
    </label>
  ) : (
    <label className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-[10px] text-white font-semibold text-[13px] cursor-pointer" style={{ background: 'var(--brand-primary)' }}>
      {uploading ? 'Uploading…' : tab === 'interview' ? '+ Upload interview video' : '+ Upload training video'}
      <input type="file" accept="video/*" multiple onChange={(e) => handleVideoUpload(e, tab as VideoKind)} disabled={uploading} className="hidden" />
    </label>
  )

  const activeHint = tabs.find((t) => t.k === tab)?.hint ?? ''
  const totalItems = counts.interview + counts.training + counts.pictures

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow={`${totalItems} item${totalItems === 1 ? '' : 's'}`}
        title="Media"
        description="Central media library — videos, audio, images, and documents reused across workflows, trainings, and campaigns."
        actions={uploadButton}
      />

      <div className="px-8 pt-5">
        <SubNav items={ASSETS_NAV} />
      </div>

      <div className="px-8 pt-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="inline-flex gap-1 rounded-[10px] bg-surface-weak p-1 flex-wrap">
            {tabs.map((t) => (
              <button
                key={t.k}
                onClick={() => setTab(t.k)}
                className={`px-3.5 py-1.5 rounded-[8px] text-[13px] font-medium transition-colors ${
                  tab === t.k ? 'bg-white text-ink shadow-sm' : 'text-grey-35 hover:text-ink'
                }`}
              >
                {t.l} <span className="ml-1 font-mono text-[11px] text-grey-50">{t.count}</span>
              </button>
            ))}
            {/* Audio + Documents per spec — not modeled yet so rendered
                disabled with a Coming-soon badge so the recruiter sees the
                intended structure. */}
            <button
              disabled
              title="Audio uploads not modeled yet"
              className="px-3.5 py-1.5 rounded-[8px] text-[13px] font-medium text-grey-50 cursor-not-allowed inline-flex items-center gap-1.5"
            >
              Audio <WipBadge label="WIP" />
            </button>
            <button
              disabled
              title="Document uploads not modeled yet"
              className="px-3.5 py-1.5 rounded-[8px] text-[13px] font-medium text-grey-50 cursor-not-allowed inline-flex items-center gap-1.5"
            >
              Documents <WipBadge label="WIP" />
            </button>
          </div>
          {tab !== 'pictures' && (
            <label className="inline-flex items-center gap-2 text-[12px] text-grey-35 cursor-pointer select-none">
              <span>{useAutoName ? 'Auto-generated name' : 'File name'}</span>
              <button
                type="button"
                onClick={() => toggleUseAutoName(!useAutoName)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${useAutoName ? 'bg-[#FF9500]' : 'bg-gray-300'}`}
                title={useAutoName ? 'Switch to file name' : 'Switch to auto-generated name'}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${useAutoName ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
            </label>
          )}
        </div>
        <p className="mt-2 text-[12px] text-grey-35">{activeHint}</p>
      </div>

      <div className="px-8 py-4">
        {(videoUploads.length > 0 || pictureUploads.length > 0) && (
          <div className="mb-5 space-y-2">
            {[...videoUploads.map((u) => ({ key: u.id, filename: u.filename, progress: u.progress, status: u.status, error: u.error, isVideo: true as const })),
              ...pictureUploads.map((u, i) => ({ key: `pic-${i}`, filename: u.filename, progress: u.progress, status: u.status, error: u.error, isVideo: false as const }))].map((u) => (
              <Card key={u.key} padding={12}>
                <div className="flex justify-between text-[12px] mb-1.5">
                  <span className="truncate font-medium text-ink">{u.filename}</span>
                  <span className="ml-2 font-mono text-grey-35">
                    {u.status === 'success' && (u.isVideo ? 'Uploaded — transcoding' : 'Done')}
                    {u.status === 'error' && 'Failed'}
                    {u.status === 'uploading' && `${u.progress}%`}
                    {u.status === 'pending' && 'Waiting…'}
                  </span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--weak-track)' }}>
                  <div className="h-full transition-all duration-300"
                    style={{
                      width: `${u.progress}%`,
                      background:
                        u.status === 'error' ? 'var(--danger-fg)' :
                        u.status === 'success' ? 'var(--success-fg)' :
                        'var(--brand-primary)',
                    }}
                  />
                </div>
                {u.status === 'uploading' && u.isVideo && (
                  <p className="mt-2 text-[11px] text-grey-35">Uploading to secure storage — keep the browser open. You can switch to other tabs (Candidates, Automations…) while this runs.</p>
                )}
                {u.status === 'error' && (
                  <p className="mt-2 text-[11px] text-[color:var(--danger-fg)]">{u.error || 'Upload failed — try again.'}</p>
                )}
              </Card>
            ))}
            {videoUploads.length > 0 && videoUploads.every((u) => u.status === 'success' || u.status === 'error') && videoUploads.some((u) => u.status === 'success') && (
              // Persistent banner shown after the upload PUT finishes. The
              // transcode itself runs in the background on Lambda; the
              // recruiter can navigate away or kick off another upload — an
              // email lands when each video is playable.
              <div className="rounded-[10px] border p-4 flex items-start gap-3" style={{ background: '#FFF7EA', borderColor: '#FFE2B7' }}>
                <div className="w-8 h-8 rounded-full flex-none flex items-center justify-center" style={{ background: '#FF9500' }}>
                  <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                </div>
                <div className="flex-1 text-[13px] leading-relaxed">
                  <div className="font-semibold text-ink mb-0.5">Upload complete — transcoding in the background</div>
                  <p className="text-grey-35">Feel free to keep working or close this tab. We&apos;ll email you at your account address when the video is ready to play (usually 1–5 minutes per video).</p>
                </div>
                <button
                  type="button"
                  onClick={clearFinished}
                  className="text-[12px] text-grey-35 hover:text-ink"
                  title="Dismiss"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        )}

        {tab === 'pictures' ? (
          pictures.length === 0 ? (
            <Card padding={48} className="text-center">
              <Eyebrow size="xs" className="mb-2">Nothing yet</Eyebrow>
              <h2 className="text-[18px] font-semibold text-ink mb-1.5">No images uploaded</h2>
              <p className="text-grey-35 text-[13px]">Upload images to use as training cover art or branding.</p>
            </Card>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5">
              {pictures.map((p) => (
                <Card key={p.id} padding={0} className="overflow-hidden group">
                  <div className="aspect-square bg-surface-weak relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt={p.displayName || p.filename} className="w-full h-full object-cover" />
                  </div>
                  <div className="p-3">
                    <div className="font-mono text-[11px] text-ink truncate mb-1" title={p.filename}>
                      {p.displayName || p.filename}
                    </div>
                    {/* Used-in tracker — per spec, key UX to prevent
                        accidental deletion. Not aggregated yet (would need
                        a Picture→Training/Workflow reference scan). */}
                    <div className="text-[10px] text-grey-50 mb-1.5 flex items-center gap-1">
                      Used in — <WipBadge label="WIP" />
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-mono text-grey-35">{fmtFileSize(p.sizeBytes)}</span>
                      <button
                        onClick={() => deletePicture(p.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-[color:var(--danger-fg)] hover:underline"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )
        ) : (() => {
          const filtered = videos.filter((v) => v.kind === tab)
          if (filtered.length === 0) {
            return (
              <Card padding={48} className="text-center">
                <Eyebrow size="xs" className="mb-2">Nothing yet</Eyebrow>
                <h2 className="text-[18px] font-semibold text-ink mb-1.5">
                  No {tab === 'interview' ? 'interview' : 'training'} videos uploaded
                </h2>
                <p className="text-grey-35 text-[13px]">
                  {tab === 'interview'
                    ? 'Upload short video clips to use in flow steps.'
                    : 'Upload longer videos to use as training lessons.'}
                </p>
              </Card>
            )
          }
          return (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
              {filtered.map((v) => {
                const duration = fmtDuration(v.durationSeconds)
                const isPlaying = playing === v.id
                const isTranscoding = v.status === 'transcoding' || v.status === 'uploading'
                const isFailed = v.status === 'failed'
                return (
                  <Card key={v.id} padding={0} className="overflow-hidden group">
                    <div
                      className="aspect-video relative cursor-pointer"
                      style={{ background: isPlaying ? '#000' : 'linear-gradient(135deg, #2a2826 0%, #1a1815 100%)' }}
                      onClick={() => { if (!isTranscoding && !isFailed) setPlaying(isPlaying ? null : v.id) }}
                    >
                      {isPlaying ? (
                        <DashboardVideoPreview src={v.url} hlsUrl={v.hlsManifestUrl} poster={v.posterUrl || undefined} autoPlay />
                      ) : (
                        <>
                          {isTranscoding ? (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
                              <div className="w-8 h-8 mb-2 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
                              <p className="text-xs font-mono uppercase" style={{ letterSpacing: '0.08em' }}>Transcoding…</p>
                            </div>
                          ) : isFailed ? (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-white px-3 text-center">
                              <p className="text-xs font-semibold mb-1">Transcode failed</p>
                              <p className="text-[10px] text-white/70 line-clamp-2" title={v.transcodeError || ''}>{v.transcodeError || 'Unknown error'}</p>
                            </div>
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="w-12 h-12 rounded-full flex items-center justify-center backdrop-blur-sm transition-transform group-hover:scale-110" style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.18)' }}>
                                <svg className="w-5 h-5 text-white ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                              </div>
                            </div>
                          )}
                          {duration && !isTranscoding && !isFailed && (
                            <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-[4px] font-mono text-[10px] text-white" style={{ background: 'rgba(0,0,0,0.6)', letterSpacing: '0.04em' }}>
                              {duration}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    <div className="p-3.5">
                      <div className="font-mono text-[11px] text-ink truncate mb-1" title={v.filename} style={{ letterSpacing: '0.02em' }}>
                        {useAutoName ? (v.displayName || v.filename) : v.filename}
                      </div>
                      {v.summary && (
                        <p className="text-[11px] text-grey-35 line-clamp-2 mb-2">{v.summary}</p>
                      )}
                      {/* Used-in tracker placeholder — same idea as the
                          pictures card. Will list workflows + trainings
                          that reference this video once the back-reference
                          query lands. */}
                      <div className="text-[10px] text-grey-50 mb-1.5 flex items-center gap-1">
                        Used in — <WipBadge label="WIP" />
                      </div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-mono text-grey-35">
                          {fmtFileSize(v.sizeBytes)} · {new Date(v.createdAt).toLocaleDateString()}
                        </span>
                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          {v.status !== 'transcoding' && v.status !== 'uploading' && v.status !== 'failed' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); copyShareLink(v.id) }}
                              className="text-grey-35 hover:text-ink"
                              title="Copy public share link"
                            >
                              {copiedId === v.id ? 'Copied!' : 'Share'}
                            </button>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); reclassifyVideo(v.id, v.kind === 'interview' ? 'training' : 'interview') }}
                            className="text-grey-35 hover:text-ink"
                            title={`Move to ${v.kind === 'interview' ? 'training' : 'interview'}`}
                          >
                            Move
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteVideo(v.id) }}
                            className="text-[color:var(--danger-fg)] hover:underline"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  </Card>
                )
              })}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
