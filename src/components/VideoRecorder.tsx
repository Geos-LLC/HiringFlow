'use client'

import { useState, useRef, useEffect } from 'react'

interface VideoRecorderProps {
  onRecordComplete: (blob: Blob | null) => void
  recordedVideo: Blob | null
}

export default function VideoRecorder({ onRecordComplete, recordedVideo }: VideoRecorderProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop())
      }
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl)
      }
    }
  }, [stream, previewUrl])

  // Attach the live stream to the <video> element after it mounts. Setting
  // srcObject synchronously inside startRecording() doesn't work because the
  // video element only renders once `stream` is non-null, so videoRef.current
  // is still null at that point.
  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream
      videoRef.current.play().catch(() => {})
    }
  }, [stream])

  // Update preview URL when recordedVideo changes externally
  useEffect(() => {
    if (recordedVideo && !previewUrl) {
      const url = URL.createObjectURL(recordedVideo)
      setPreviewUrl(url)
    }
  }, [recordedVideo, previewUrl])

  const startRecording = async () => {
    try {
      setError(null)
      console.log('[VideoRecorder] startRecording: requesting getUserMedia')
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      })
      console.log('[VideoRecorder] got stream', {
        tracks: mediaStream.getTracks().map(t => ({ kind: t.kind, label: t.label, enabled: t.enabled, readyState: t.readyState })),
      })
      setStream(mediaStream)

      // Pick best supported codec. Prefer mp4 because Chrome's webm output
      // from MediaRecorder has a corrupt container header (dimensions read
      // as 2x2, duration as Infinity), making the preview unplayable.
      const candidates = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ]
      const support = Object.fromEntries(candidates.map(c => [c, MediaRecorder.isTypeSupported(c)]))
      console.log('[VideoRecorder] codec support', support)
      const mimeType = candidates.find(c => support[c])
      console.log('[VideoRecorder] selected mimeType', mimeType)
      const recorder = mimeType
        ? new MediaRecorder(mediaStream, { mimeType })
        : new MediaRecorder(mediaStream)
      console.log('[VideoRecorder] recorder created', { mimeType: recorder.mimeType, state: recorder.state })
      const chunks: Blob[] = []

      recorder.ondataavailable = (e) => {
        console.log('[VideoRecorder] ondataavailable', { size: e.data.size, type: e.data.type })
        if (e.data.size > 0) chunks.push(e.data)
      }

      recorder.onerror = (e) => {
        console.error('[VideoRecorder] recorder error', e)
      }

      recorder.onstop = () => {
        console.log('[VideoRecorder] onstop', { chunkCount: chunks.length, totalSize: chunks.reduce((a, c) => a + c.size, 0) })
        const blobType = recorder.mimeType || 'video/webm'
        const blob = new Blob(chunks, { type: blobType })
        console.log('[VideoRecorder] blob ready', { size: blob.size, type: blob.type })
        const url = URL.createObjectURL(blob)
        console.log('[VideoRecorder] objectURL', url)
        setPreviewUrl(url)
        onRecordComplete(blob)

        // Stop all tracks
        mediaStream.getTracks().forEach(track => track.stop())
        setStream(null)
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      console.log('[VideoRecorder] recorder.start() called', { state: recorder.state })
      setIsRecording(true)
    } catch (err) {
      console.error('[VideoRecorder] Failed to start recording', err)
      setError('Could not access camera/microphone. Please check permissions.')
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
    }
  }

  const resetRecording = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
    }
    setPreviewUrl(null)
    onRecordComplete(null)
  }

  return (
    <div className="space-y-3">
      <div className="aspect-video bg-gray-100 rounded-lg overflow-hidden relative">
        {previewUrl ? (
          <video
            src={previewUrl}
            controls
            className="w-full h-full object-cover"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              console.log('[VideoRecorder] playback loadedmetadata', { duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight, readyState: v.readyState })
            }}
            onCanPlay={(e) => {
              const v = e.currentTarget
              console.log('[VideoRecorder] playback canplay', { duration: v.duration, readyState: v.readyState })
            }}
            onError={(e) => {
              const v = e.currentTarget
              console.error('[VideoRecorder] playback error', { error: v.error, code: v.error?.code, message: v.error?.message })
            }}
            onPlay={() => console.log('[VideoRecorder] playback play')}
            onPause={() => console.log('[VideoRecorder] playback pause')}
          />
        ) : stream ? (
          <video
            ref={videoRef}
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
              <p className="text-sm">Click "Start Recording" to begin</p>
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
        {!isRecording && !previewUrl && (
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

        {previewUrl && (
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
