'use client'

import { useState, useRef, useEffect } from 'react'

interface VideoRecorderProps {
  onRecordComplete: (blob: Blob | null) => void
  recordedVideo: Blob | null
}

// Chrome's MediaRecorder writes broken container metadata (duration: Infinity,
// videoWidth/Height: 2) into both webm and mp4 output regardless of codec,
// timeslice, or seek workarounds. The video bytes themselves are fine — the
// server transcoder unbreaks them on upload — but the in-browser <video>
// element refuses to play the unrepaired blob.
//
// So instead of trying to play the broken blob back to the user, we:
//   1) Capture a snapshot of the live stream's last visible frame to a canvas
//      right before stop, and show that as a thumbnail.
//   2) Show wall-clock duration + file size so the user can confirm a real
//      recording actually happened.
//   3) Hand the blob to onRecordComplete unchanged — the transcoder handles
//      the metadata fix server-side, same as a regular file upload.
export default function VideoRecorder({ onRecordComplete, recordedVideo }: VideoRecorderProps) {
  const liveVideoRef = useRef<HTMLVideoElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  // Guards against the click handler firing twice (double-click / accessibility
  // re-fire). Without this, two MediaRecorders race on the same MediaStream
  // and each produces a half-broken recording.
  const startingRef = useRef(false)
  const startedAtRef = useRef<number>(0)
  const [isRecording, setIsRecording] = useState(false)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [recordingMeta, setRecordingMeta] = useState<{ sizeBytes: number; durationMs: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop())
      }
    }
  }, [stream])

  // Attach the live stream to the <video> element after it mounts.
  useEffect(() => {
    if (stream && liveVideoRef.current) {
      liveVideoRef.current.srcObject = stream
      liveVideoRef.current.play().catch(() => {})
    }
  }, [stream])

  // Capture a snapshot from a live <video> element to a data URL.
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

      // Pick best supported codec. mp4 first (closer to what the transcoder
      // expects as input on Safari/iOS), webm fallback.
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

        // Snapshot the last visible frame BEFORE we tear the stream down.
        const snap = liveVideoRef.current ? captureSnapshot(liveVideoRef.current) : null
        setSnapshot(snap)
        setRecordingMeta({ sizeBytes: blob.size, durationMs })
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
    setSnapshot(null)
    setRecordingMeta(null)
    onRecordComplete(null)
  }

  // External reset — parent cleared recordedVideo.
  useEffect(() => {
    if (!recordedVideo && (snapshot || recordingMeta)) {
      setSnapshot(null)
      setRecordingMeta(null)
    }
  }, [recordedVideo, snapshot, recordingMeta])

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
        {inReviewState ? (
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

      {inReviewState && (
        <p className="text-xs text-gray-500">
          In-browser playback isn&apos;t supported for fresh recordings — the file will play normally
          once uploaded.
        </p>
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
