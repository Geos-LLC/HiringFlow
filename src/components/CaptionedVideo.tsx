'use client'

import { useRef, useState, useEffect, useCallback } from 'react'

interface Segment {
  start: number
  end: number
  text: string
}

export interface CaptionStyle {
  fontFamily: string
  fontSize: number
  color: string
  backgroundColor: string
  position: 'bottom' | 'top' | 'custom'
  // Custom position as percentage (0-100)
  customX?: number
  customY?: number
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Arial, sans-serif',
  fontSize: 16,
  color: '#ffffff',
  backgroundColor: 'rgba(0, 0, 0, 0.75)',
  position: 'bottom',
  customX: 50,
  customY: 85,
}

const FONT_OPTIONS = [
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Courier', value: '"Courier New", monospace' },
  { label: 'Verdana', value: 'Verdana, sans-serif' },
  { label: 'Impact', value: 'Impact, sans-serif' },
]

interface CaptionedVideoProps {
  src: string
  /** R2 HLS master.m3u8 — preferred when present. The raw `src` is the
   *  original upload (often Chrome MediaRecorder webm with broken metadata
   *  that <video> can't decode), so always prefer HLS when ready. */
  hlsUrl?: string | null
  /** Video.status from the Video model. When not 'ready', the transcode
   *  pipeline hasn't produced a playable HLS yet — show a processing
   *  placeholder instead of trying to render the broken raw file. */
  status?: string | null
  segments: Segment[]
  captionsEnabled: boolean
  captionStyle?: CaptionStyle
  onStyleChange?: (style: CaptionStyle) => void
  showStyleEditor?: boolean
  autoPlay?: boolean
  onEnded?: () => void
  className?: string
  videoClassName?: string
}

export default function CaptionedVideo({
  src,
  hlsUrl,
  status,
  segments,
  captionsEnabled,
  captionStyle = DEFAULT_CAPTION_STYLE,
  onStyleChange,
  showStyleEditor = false,
  autoPlay = false,
  onEnded,
  className,
  videoClassName,
}: CaptionedVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const captionRef = useRef<HTMLDivElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  const [activeColorTarget, setActiveColorTarget] = useState<'text' | 'bg' | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleTimeUpdate = () => setCurrentTime(video.currentTime)
    video.addEventListener('timeupdate', handleTimeUpdate)
    return () => video.removeEventListener('timeupdate', handleTimeUpdate)
  }, [])

  // Attach HLS to the video element via hls.js when an HLS manifest is
  // available. Safari plays HLS natively, so it just gets src=hlsUrl. For
  // Chrome/Firefox/Edge, dynamically import hls.js so it doesn't bloat the
  // initial bundle. Mirrors DashboardVideoPreview's playback path.
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

  const isProcessing = status && status !== 'ready' && status !== 'failed'
  const isFailed = status === 'failed'

  const currentSegment = captionsEnabled
    ? segments.find((s) => currentTime >= s.start && currentTime <= s.end)
    : null

  // Draggable caption logic
  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!onStyleChange) return
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY

    dragStartRef.current = {
      x: clientX,
      y: clientY,
      startX: captionStyle.customX ?? 50,
      startY: captionStyle.customY ?? 85,
    }
  }, [captionStyle, onStyleChange])

  useEffect(() => {
    if (!isDragging) return

    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!dragStartRef.current || !containerRef.current) return
      const container = containerRef.current.getBoundingClientRect()

      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY

      const deltaXPercent = ((clientX - dragStartRef.current.x) / container.width) * 100
      const deltaYPercent = ((clientY - dragStartRef.current.y) / container.height) * 100

      const newX = Math.max(5, Math.min(95, dragStartRef.current.startX + deltaXPercent))
      const newY = Math.max(5, Math.min(95, dragStartRef.current.startY + deltaYPercent))

      onStyleChange?.({
        ...captionStyle,
        position: 'custom',
        customX: newX,
        customY: newY,
      })
    }

    const handleEnd = () => {
      setIsDragging(false)
      dragStartRef.current = null
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleEnd)
    window.addEventListener('touchmove', handleMove, { passive: false })
    window.addEventListener('touchend', handleEnd)

    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleEnd)
      window.removeEventListener('touchmove', handleMove)
      window.removeEventListener('touchend', handleEnd)
    }
  }, [isDragging, captionStyle, onStyleChange])

  // Caption position styles
  const getCaptionPositionStyle = (): React.CSSProperties => {
    if (captionStyle.position === 'custom') {
      return {
        position: 'absolute',
        left: `${captionStyle.customX ?? 50}%`,
        top: `${captionStyle.customY ?? 85}%`,
        transform: 'translate(-50%, -50%)',
      }
    }
    if (captionStyle.position === 'top') {
      return {
        position: 'absolute',
        left: '50%',
        top: '48px',
        transform: 'translateX(-50%)',
      }
    }
    return {
      position: 'absolute',
      left: '50%',
      bottom: '48px',
      transform: 'translateX(-50%)',
    }
  }

  return (
    <div className="relative">
      {/* Video */}
      <div ref={containerRef} className={`relative rounded-md overflow-hidden bg-black ${className || ''}`}>
        {isProcessing ? (
          <div className={`${videoClassName || 'w-full'} aspect-video flex items-center justify-center bg-gray-900 text-gray-200 text-sm`}>
            <div className="text-center px-6">
              <svg className="w-10 h-10 mx-auto mb-2 animate-spin text-brand-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
              </svg>
              <div className="font-medium">Processing video…</div>
              <div className="text-gray-400 text-xs mt-1">The recording is saved. Playback will be available in a moment — refresh to see it.</div>
            </div>
          </div>
        ) : isFailed ? (
          <div className={`${videoClassName || 'w-full'} aspect-video flex items-center justify-center bg-gray-900 text-red-300 text-sm`}>
            <div className="text-center px-6">
              <div className="font-medium">Video processing failed</div>
              <div className="text-gray-400 text-xs mt-1">Try re-uploading the recording.</div>
            </div>
          </div>
        ) : (
          <video
            ref={videoRef}
            {...(hlsUrl ? {} : { src })}
            className={videoClassName || "w-full"}
            controls
            preload="metadata"
            autoPlay={autoPlay}
            playsInline
            onEnded={onEnded}
          />
        )}

        {/* Caption overlay — draggable */}
        {currentSegment && (
          <div
            ref={captionRef}
            style={getCaptionPositionStyle()}
            className={`px-4 max-w-[90%] z-10 ${
              onStyleChange ? 'cursor-grab active:cursor-grabbing' : 'pointer-events-none'
            } ${isDragging ? 'opacity-80' : ''}`}
            onMouseDown={handleDragStart}
            onTouchStart={handleDragStart}
          >
            <span
              style={{
                fontFamily: captionStyle.fontFamily,
                fontSize: `${captionStyle.fontSize}px`,
                color: captionStyle.color,
                backgroundColor: captionStyle.backgroundColor,
                padding: '4px 12px',
                borderRadius: '4px',
                textAlign: 'center',
                lineHeight: 1.4,
                display: 'inline-block',
                userSelect: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {currentSegment.text}
            </span>
          </div>
        )}

        {/* Drag hint — show when captions enabled and editable */}
        {captionsEnabled && onStyleChange && !currentSegment && segments.length > 0 && (
          <div className="absolute bottom-12 left-1/2 -translate-x-1/2 text-[10px] text-gray-400 bg-black/40 px-2 py-0.5 rounded pointer-events-none">
            Drag captions to reposition
          </div>
        )}
      </div>

      {/* Caption style editor */}
      {showStyleEditor && captionsEnabled && (
        <div className="mt-2">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Caption Style
          </button>

          {showSettings && onStyleChange && (() => {
            const COLOR_PALETTE = [
              { color: '#ffffff', label: 'White' },
              { color: '#000000', label: 'Black' },
              { color: '#f3f4f6', label: 'Light Gray' },
              { color: '#6b7280', label: 'Gray' },
              { color: '#374151', label: 'Dark Gray' },
              { color: '#ef4444', label: 'Red' },
              { color: '#f97316', label: 'Orange' },
              { color: '#eab308', label: 'Yellow' },
              { color: '#22c55e', label: 'Green' },
              { color: '#14b8a6', label: 'Teal' },
              { color: '#3b82f6', label: 'Blue' },
              { color: '#8b5cf6', label: 'Purple' },
              { color: '#ec4899', label: 'Pink' },
              { color: '#a855f7', label: 'Violet' },
              { color: 'transparent', label: 'None' },
            ]
            const OPACITY_OPTIONS = [
              { value: 1, label: '100%' },
              { value: 0.9, label: '90%' },
              { value: 0.75, label: '75%' },
              { value: 0.5, label: '50%' },
              { value: 0.3, label: '30%' },
            ]

            const applyColor = (hex: string, target: 'text' | 'bg') => {
              if (target === 'text') {
                onStyleChange({ ...captionStyle, color: hex })
              } else {
                if (hex === 'transparent') {
                  onStyleChange({ ...captionStyle, backgroundColor: 'transparent' })
                } else {
                  // Parse current opacity or default to 0.75
                  const match = captionStyle.backgroundColor.match(/[\d.]+\)$/)
                  const opacity = match ? parseFloat(match[0]) : 0.75
                  const r = parseInt(hex.slice(1, 3), 16)
                  const g = parseInt(hex.slice(3, 5), 16)
                  const b = parseInt(hex.slice(5, 7), 16)
                  onStyleChange({ ...captionStyle, backgroundColor: `rgba(${r}, ${g}, ${b}, ${opacity})` })
                }
              }
            }

            const applyOpacity = (opacity: number) => {
              const match = captionStyle.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
              if (match) {
                onStyleChange({ ...captionStyle, backgroundColor: `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${opacity})` })
              }
            }

            const getActiveHex = (target: 'text' | 'bg') => {
              if (target === 'text') return captionStyle.color
              if (captionStyle.backgroundColor === 'transparent') return 'transparent'
              const match = captionStyle.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
              if (match) {
                const hex = '#' + [match[1], match[2], match[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('')
                return hex
              }
              return captionStyle.backgroundColor
            }

            const getCurrentOpacity = () => {
              const match = captionStyle.backgroundColor.match(/([\d.]+)\)$/)
              return match ? parseFloat(match[1]) : 1
            }

            return (
            <div className="mt-2 p-3 bg-gray-50 rounded-md border border-gray-200 space-y-3">
              {/* Row 1: Font + Size */}
              <div className="flex items-center gap-3">
                <select
                  value={captionStyle.fontFamily}
                  onChange={(e) => onStyleChange({ ...captionStyle, fontFamily: e.target.value })}
                  className="flex-1 text-xs px-2 py-1.5 border border-gray-300 rounded"
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onStyleChange({ ...captionStyle, fontSize: Math.max(8, captionStyle.fontSize - 1) })}
                    className="w-6 h-6 flex items-center justify-center text-xs border border-gray-300 rounded hover:bg-gray-100"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={8}
                    max={48}
                    value={captionStyle.fontSize}
                    onChange={(e) => onStyleChange({ ...captionStyle, fontSize: Math.max(8, Math.min(48, Number(e.target.value) || 16)) })}
                    className="w-12 text-center text-xs px-1 py-1.5 border border-gray-300 rounded"
                  />
                  <button
                    onClick={() => onStyleChange({ ...captionStyle, fontSize: Math.min(48, captionStyle.fontSize + 1) })}
                    className="w-6 h-6 flex items-center justify-center text-xs border border-gray-300 rounded hover:bg-gray-100"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Row 2: Font Color & BG Color toggle buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => setActiveColorTarget(activeColorTarget === 'text' ? null : 'text')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors ${
                    activeColorTarget === 'text'
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  <span
                    className="w-4 h-4 rounded border border-gray-400"
                    style={{ backgroundColor: captionStyle.color }}
                  />
                  Font Color
                </button>
                <button
                  onClick={() => setActiveColorTarget(activeColorTarget === 'bg' ? null : 'bg')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors ${
                    activeColorTarget === 'bg'
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  <span
                    className="w-4 h-4 rounded border border-gray-400"
                    style={{
                      background: captionStyle.backgroundColor === 'transparent'
                        ? 'repeating-conic-gradient(#ccc 0% 25%, white 0% 50%) 50% / 6px 6px'
                        : captionStyle.backgroundColor,
                    }}
                  />
                  Background
                </button>
              </div>

              {/* Shared color palette */}
              {activeColorTarget && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {COLOR_PALETTE.map(({ color, label }) => (
                      <button
                        key={color}
                        title={label}
                        onClick={() => applyColor(color, activeColorTarget)}
                        className={`w-6 h-6 rounded border-2 transition-all ${
                          getActiveHex(activeColorTarget) === color
                            ? 'border-brand-500 scale-110 ring-1 ring-brand-300'
                            : 'border-gray-300 hover:border-gray-400'
                        }`}
                        style={{
                          background: color === 'transparent'
                            ? 'repeating-conic-gradient(#ccc 0% 25%, white 0% 50%) 50% / 8px 8px'
                            : color,
                        }}
                      />
                    ))}
                  </div>

                  {/* Opacity — only for background */}
                  {activeColorTarget === 'bg' && captionStyle.backgroundColor !== 'transparent' && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-gray-500">Opacity:</span>
                      {OPACITY_OPTIONS.map(({ value, label }) => (
                        <button
                          key={value}
                          onClick={() => applyOpacity(value)}
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            Math.abs(getCurrentOpacity() - value) < 0.05
                              ? 'bg-brand-500 text-white'
                              : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Custom hex input */}
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={getActiveHex(activeColorTarget) === 'transparent' ? '#000000' : getActiveHex(activeColorTarget)}
                      onChange={(e) => applyColor(e.target.value, activeColorTarget)}
                      className="w-6 h-6 rounded cursor-pointer border border-gray-300"
                    />
                    <input
                      type="text"
                      value={activeColorTarget === 'text' ? captionStyle.color : captionStyle.backgroundColor}
                      onChange={(e) => {
                        if (activeColorTarget === 'text') {
                          onStyleChange({ ...captionStyle, color: e.target.value })
                        } else {
                          onStyleChange({ ...captionStyle, backgroundColor: e.target.value })
                        }
                      }}
                      className="flex-1 text-xs px-2 py-1 border border-gray-300 rounded font-mono"
                      placeholder="#hex or rgba(...)"
                    />
                  </div>
                </div>
              )}

              {/* Position */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-600 flex-shrink-0">Position</label>
                <div className="flex gap-1.5">
                  {(['top', 'bottom', 'custom'] as const).map((pos) => (
                    <button
                      key={pos}
                      onClick={() => onStyleChange({ ...captionStyle, position: pos })}
                      className={`text-xs px-2.5 py-1 rounded capitalize ${
                        captionStyle.position === pos ? 'bg-brand-500 text-white' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                      }`}
                    >
                      {pos === 'custom' ? 'Free' : pos}
                    </button>
                  ))}
                </div>
              </div>
              {captionStyle.position === 'custom' && (
                <p className="text-[10px] text-gray-400 -mt-1">Drag the caption on the video to reposition</p>
              )}
            </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
