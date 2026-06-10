'use client'

import { useState, useCallback } from 'react'
import VideoRecorder from './VideoRecorder'

interface VideoRecorderModalProps {
  open: boolean
  onClose: () => void
  onAccept: (file: File) => void
  /** Filename stem for the saved recording (extension is derived from blob type). */
  filenameStem?: string
  title?: string
}

export default function VideoRecorderModal({
  open,
  onClose,
  onAccept,
  filenameStem = 'recording',
  title = 'Record a video',
}: VideoRecorderModalProps) {
  const [recorded, setRecorded] = useState<Blob | null>(null)

  const handleClose = useCallback(() => {
    setRecorded(null)
    onClose()
  }, [onClose])

  const handleUse = useCallback(() => {
    if (!recorded) return
    const ext = recorded.type.includes('mp4') ? 'mp4' : 'webm'
    const file = new File([recorded], `${filenameStem}.${ext}`, { type: recorded.type })
    onAccept(file)
    setRecorded(null)
  }, [recorded, filenameStem, onAccept])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl bg-white rounded-lg shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button
            type="button"
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5">
          <VideoRecorder recordedVideo={recorded} onRecordComplete={setRecorded} />
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-lg">
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleUse}
            disabled={!recorded}
            className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Use this recording
          </button>
        </div>
      </div>
    </div>
  )
}
