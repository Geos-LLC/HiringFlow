'use client'

import { useEffect, useRef } from 'react'

// Same playback path the candidate viewer uses: prefer the HLS manifest via
// hls.js so Chrome/Firefox/Edge get the 360p/480p/720p ladder and metadata-first
// loading instead of downloading the raw MP4. Safari plays HLS natively, so it
// skips the dynamic import. Falls back to the source URL when there's no
// manifest (legacy Vercel Blob videos, or new uploads mid-transcode).
export function DashboardVideoPreview({
  src,
  hlsUrl,
  poster,
  autoPlay = false,
  className = 'w-full h-full object-contain',
}: {
  src: string
  hlsUrl?: string | null
  poster?: string
  autoPlay?: boolean
  className?: string
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const v = videoRef.current
    if (!v || !hlsUrl) return
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = hlsUrl
      return
    }
    let hls: { destroy: () => void } | null = null
    let cancelled = false
    import('hls.js').then((mod) => {
      const Hls = mod.default
      if (cancelled || !Hls.isSupported()) return
      const instance = new Hls({ startLevel: 1, maxBufferLength: 60 })
      instance.loadSource(hlsUrl)
      instance.attachMedia(v)
      hls = instance
    }).catch(() => {})
    return () => { cancelled = true; if (hls) hls.destroy() }
  }, [hlsUrl])
  return (
    <video
      ref={videoRef}
      {...(hlsUrl ? {} : { src })}
      poster={poster}
      className={className}
      controls
      autoPlay={autoPlay}
      playsInline
      preload="metadata"
    />
  )
}
