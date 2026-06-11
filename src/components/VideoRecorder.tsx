'use client'

import { useState, useRef, useEffect } from 'react'

interface VideoRecorderProps {
  onRecordComplete: (blob: Blob | null) => void
  recordedVideo: Blob | null
}

// Chrome's MediaRecorder writes broken container metadata (duration: Infinity,
// videoWidth/Height: 2) into the produced blob. The bytes themselves are valid
// — the server transcoder consumes them fine — but a plain
// `<video src={blobUrl}>` element refuses to play it.
//
// Workaround: feed the recorded chunks back via MediaSource Extensions. MSE
// handles fragmented mp4/webm input natively (that's how live video streams
// work) and gets correct dimensions from the init segment instead of the
// broken global container metadata. If MSE setup fails (older browser /
// codec mismatch), we fall back to a snapshot-based review UI.
export default function VideoRecorder({ onRecordComplete, recordedVideo }: VideoRecorderProps) {
  const liveVideoRef = useRef<HTMLVideoElement>(null)
  const playbackVideoRef = useRef<HTMLVideoElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  // Guards against the click handler firing twice. Two parallel MediaRecorders
  // on the same MediaStream each produce a broken half-recording.
  const startingRef = useRef(false)
  const startedAtRef = useRef<number>(0)
  const chunksRef = useRef<Blob[]>([])
  const mimeTypeRef = useRef<string>('')
  const [isRecording, setIsRecording] = useState(false)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [playbackSrc, setPlaybackSrc] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [recordingMeta, setRecordingMeta] = useState<{ sizeBytes: number; durationMs: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop())
      }
      if (playbackSrc) {
        URL.revokeObjectURL(playbackSrc)
      }
    }
  }, [stream, playbackSrc])

  useEffect(() => {
    if (stream && liveVideoRef.current) {
      liveVideoRef.current.srcObject = stream
      liveVideoRef.current.play().catch(() => {})
    }
  }, [stream])

  const captureSnapshot = (videoEl: HTMLVideoElement): string | null => {
    const w = videoEl.videoWidth
    const h = videoEl.videoHeight
    if (!w || !h) return null
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    try {
      ctx.drawImage(videoEl, 0, 0, w, h)
      return canvas.toDataURL('image/jpeg', 0.85)
    } catch {
      return null
    }
  }

  // Feed the recorded chunks back through MediaSource so the <video> element
  // gets correct dimensions/timing from the init segment instead of the
  // broken global container metadata.
  const setupMsePlayback = (chunks: Blob[], mime: string): string | null => {
    try {
      if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mime)) {
        console.log('[VideoRecorder] MSE not supported for', mime)
        return null
      }
      const ms = new MediaSource()
      const url = URL.createObjectURL(ms)
      ms.addEventListener('sourceopen', async () => {
        try {
          const sb = ms.addSourceBuffer(mime)
          const merged = new Blob(chunks, { type: mime })
          const buf = await merged.arrayBuffer()
          sb.addEventListener('updateend', () => {
            if (ms.readyState === 'open') {
              try { ms.endOfStream() } catch {}
            }
          })
          sb.appendBuffer(buf)
        } catch (err) {
          console.error('[VideoRecorder] MSE append failed', err)
        }
      })
      return url
    } catch (err) {
      console.error('[VideoRecorder] MSE setup failed', err)
      return null
    }
  }

  const startRecording = async () => {
    if (startingRef.current || isRecording || mediaRecorderRef.current?.state === 'recording') {
      return
    }
    startingRef.current = true
    try {
      setError(null)
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      })
      setStream(mediaStream)

      const candidates = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ]
      const mimeType = candidates.find(c => MediaRecorder.isTypeSupported(c))
      const recorder = mimeType
        ? new MediaRecorder(mediaStream, { mimeType })
        : new MediaRecorder(mediaStream)
      const chunks: Blob[] = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }

      recorder.onstop = () => {
        const blobType = recorder.mimeType || 'video/webm'
        const blob = new Blob(chunks, { type: blobType })
        const durationMs = Date.now() - startedAtRef.current

        chunksRef.current = chunks
        mimeTypeRef.current = blobType

        const snap = liveVideoRef.current ? captureSnapshot(liveVideoRef.current) : null
        setSnapshot(snap)
        setRecordingMeta({ sizeBytes: blob.size, durationMs })

        // Attempt MSE playback. If unsupported, the UI falls back to snapshot.
        const mseUrl = setupMsePlayback(chunks, blobType)
        if (mseUrl) {
          console.log('[VideoRecorder] using MSE playback')
          setPlaybackSrc(mseUrl)
        } else {
          console.log('[VideoRecorder] MSE unavailable, falling back to snapshot only')
        }

        onRecordComplete(blob)

        mediaStream.getTracks().forEach(track => track.stop())
        setStream(null)
      }

      mediaRecorderRef.current = recorder
      startedAtRef.current = Date.now()
      recorder.start(1000)
      setIsRecording(true)
    } catch (err) {
      console.error('[VideoRecorder] Failed to start recording', err)
      setError('Could not access camera/microphone. Please check permissions.')
    } finally {
      startingRef.current = false
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
    }
  }

  const resetRecording = () => {
    if (playbackSrc) {
      URL.revokeObjectURL(playbackSrc)
    }
    setPlaybackSrc(null)
    setSnapshot(null)
    setRecordingMeta(null)
    chunksRef.current = []
    onRecordComplete(null)
  }

  useEffect(() => {
    if (!recordedVideo && (snapshot || recordingMeta || playbackSrc)) {
      if (playbackSrc) URL.revokeObjectURL(playbackSrc)
      setPlaybackSrc(null)
      setSnapshot(null)
      setRecordingMeta(null)
    }
  }, [recordedVideo, snapshot, recordingMeta, playbackSrc])

  const formatDuration = (ms: number) => {
    const totalSec = Math.max(0, Math.round(ms / 1000))
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const inReviewState = !!recordingMeta

  return (
    <div className="space-y-3">
      <div className="aspect-video bg-gray-100 rounded-lg overflow-hidden relative">
        {inReviewState && playbackSrc ? (
          <video
            ref={playbackVideoRef}
            src={playbackSrc}
            controls
            playsInline
            className="w-full h-full object-contain bg-black"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              console.log('[VideoRecorder] MSE playback loadedmetadata', { duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight })
            }}
            onError={(e) => {
              const v = e.currentTarget
              console.error('[VideoRecorder] MSE playback error', { code: v.error?.code, message: v.error?.message })
            }}
          />
        ) : inReviewState ? (
          <div className="w-full h-full relative bg-black">
            {snapshot ? (
              <img src={snapshot} alt="Recording snapshot" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-300 text-sm">
                Snapshot unavailable
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-4 py-3 flex items-center gap-3 text-white">
              <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <div className="text-xs">
                <div className="font-medium">Recording captured</div>
                <div className="opacity-80">
                  {formatDuration(recordingMeta!.durationMs)} · {formatSize(recordingMeta!.sizeBytes)}
                </div>
              </div>
            </div>
          </div>
        ) : stream ? (
          <video
            ref={liveVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-400">
            <div className="text-center">
              <svg className="w-12 h-12 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <p className="text-sm">Click &quot;Start Recording&quot; to begin</p>
            </div>
          </div>
        )}

        {isRecording && (
          <div className="absolute top-3 left-3 flex items-center gap-2 bg-red-600 text-white px-3 py-1 rounded-full text-sm">
            <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
            Recording...
          </div>
        )}
      </div>

      {error && (
        <div className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        {!isRecording && !inReviewState && (
          <button
            type="button"
            onClick={startRecording}
            className="flex-1 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors"
          >
            Start Recording
          </button>
        )}

        {isRecording && (
          <button
            type="button"
            onClick={stopRecording}
            className="flex-1 py-2 bg-gray-800 text-white rounded-lg font-medium animate-pulse"
          >
            Stop Recording
          </button>
        )}

        {inReviewState && (
          <button
            type="button"
            onClick={resetRecording}
            className="flex-1 py-2 border border-gray-300 rounded-lg font-medium hover:bg-gray-50 transition-colors"
          >
            Re-record
          </button>
        )}
      </div>
    </div>
  )
}
