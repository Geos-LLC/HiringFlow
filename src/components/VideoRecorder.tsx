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
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      })
      setStream(mediaStream)

      // Pick the best mimeType the platform supports. Safari/iOS rejects webm
      // and only records mp4 (h264/aac); Chrome/Firefox prefer webm/vp9.
      const candidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4;codecs=h264,aac',
        'video/mp4',
      ]
      const mimeType = candidates.find((t) =>
        typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)
      )
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
        const url = URL.createObjectURL(blob)
        setPreviewUrl(url)
        onRecordComplete(blob)

        // Stop all tracks
        mediaStream.getTracks().forEach(track => track.stop())
        setStream(null)
      }

      mediaRecorderRef.current = recorder
      // Emit chunks every second so the resulting blob has usable timing
      // metadata; without a timeslice, MediaRecorder produces a single chunk
      // with duration: Infinity and the preview can't play or seek.
      recorder.start(1000)
      setIsRecording(true)
    } catch (err) {
      console.error('Failed to start recording:', err)
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
            playsInline
            className="w-full h-full object-cover"
            onLoadedMetadata={(e) => {
              // Workaround for Chrome's MediaRecorder webm output: when
              // duration comes back as Infinity, seeking to a huge time and
              // back to 0 forces the browser to recompute it from chunks so
              // the controls become usable.
              const v = e.currentTarget
              if (!isFinite(v.duration)) {
                v.currentTime = 1e101
                const reset = () => {
                  v.currentTime = 0
                  v.removeEventListener('timeupdate', reset)
                }
                v.addEventListener('timeupdate', reset)
              }
            }}
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
