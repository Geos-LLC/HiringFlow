'use client'

import { useState } from 'react'
import {
  CANDIDATE_DISPOSITION_REASONS,
  DISPOSITION_DISPLAY,
  type CandidateDispositionReason,
  type CandidateStatus,
} from '@/lib/candidate-status'

export interface DispositionReasonPickerProps {
  mode: 'set-status' | 'change-reason'
  targetStatus?: CandidateStatus
  initial: CandidateDispositionReason | null
  onClose: () => void
  onSubmit: (reason: CandidateDispositionReason | null) => void | Promise<void>
}

export function DispositionReasonPicker({
  mode,
  targetStatus,
  initial,
  onClose,
  onSubmit,
}: DispositionReasonPickerProps) {
  const [chosen, setChosen] = useState<CandidateDispositionReason | null>(initial)
  const [busy, setBusy] = useState(false)
  const title = mode === 'change-reason'
    ? 'Change reason'
    : targetStatus === 'lost' ? 'Move to Lost'
    : targetStatus === 'nurture' ? 'Move to On Hold'
    : 'Pick reason'
  const subtitle = mode === 'change-reason'
    ? 'Update the structured reason. This does not change the candidate status.'
    : targetStatus === 'lost'
      ? 'Pick the reason this candidate is lost. Used by analytics to bucket lost candidates.'
      : 'Pick a reason (optional). Helps remember why this candidate is parked.'

  const handleSubmit = async () => {
    setBusy(true)
    try { await onSubmit(chosen) } finally { setBusy(false) }
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-[70] p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="bg-white rounded-[12px] shadow-2xl w-full max-w-[520px] p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-grey-15 mb-1">{title}</h3>
        <p className="text-xs text-grey-40 mb-4">{subtitle}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[50vh] overflow-y-auto">
          {CANDIDATE_DISPOSITION_REASONS.map((r) => (
            <button
              key={r}
              onClick={() => setChosen(r)}
              className={`text-left text-[13px] px-3 py-2 rounded-[8px] border transition-colors ${
                chosen === r
                  ? 'border-brand-500 bg-brand-50 text-brand-700'
                  : 'border-surface-border text-grey-15 hover:border-grey-50 hover:bg-surface-light'
              }`}
            >
              {DISPOSITION_DISPLAY[r]}
            </button>
          ))}
        </div>
        <div className="flex justify-between items-center mt-5 gap-2">
          {mode === 'change-reason' && (
            <button
              onClick={() => setChosen(null)}
              className={`text-xs px-3 py-1.5 rounded-[8px] ${chosen === null ? 'text-brand-600 bg-brand-50' : 'text-grey-40 hover:text-grey-15'}`}
            >
              Clear reason
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} disabled={busy} className="text-sm px-4 py-2 rounded-[8px] text-grey-40 hover:text-grey-15 disabled:opacity-50">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={busy || (mode === 'set-status' && targetStatus === 'lost' && chosen === null)}
              className="text-sm px-4 py-2 rounded-[8px] bg-brand-500 text-white hover:bg-brand-600 font-medium disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
