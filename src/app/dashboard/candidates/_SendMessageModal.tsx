'use client'

/**
 * Lightweight email composer for the candidate drawer. Posts to
 * /api/candidates/[id]/send-rejection-email — despite the URL, that endpoint
 * is a generic custom-email send (the name reflects its original use case).
 */

import { useState } from 'react'

interface SendMessageModalProps {
  candidateId: string
  candidateEmail: string | null
  onClose: () => void
  onSent?: () => void
}

export function SendMessageModal({ candidateId, candidateEmail, onClose, onSent }: SendMessageModalProps) {
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const disabled = sending || !candidateEmail || !subject.trim() || !body.trim()

  const send = async () => {
    if (disabled) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/candidates/${candidateId}/send-rejection-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subject.trim(), bodyHtml: body.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || 'Send failed')
        return
      }
      onSent?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-[70] p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !sending) onClose() }}
    >
      <div className="bg-white rounded-[12px] shadow-2xl w-full max-w-[560px] p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-grey-15 mb-1">Send message</h3>
        <p className="text-xs text-grey-40 mb-4">
          {candidateEmail
            ? <>Email will go to <span className="font-medium text-grey-15">{candidateEmail}</span>.</>
            : 'This candidate has no email on file — add one before sending.'}
        </p>
        <label className="block text-[11px] font-medium text-grey-35 mb-1">Subject</label>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={sending || !candidateEmail}
          className="w-full text-[13px] px-2.5 py-1.5 rounded-[8px] border border-surface-border bg-white text-ink mb-3 disabled:opacity-50"
          placeholder="e.g. Quick update on your application"
        />
        <label className="block text-[11px] font-medium text-grey-35 mb-1">Message</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={sending || !candidateEmail}
          rows={8}
          className="w-full text-[13px] px-2.5 py-1.5 rounded-[8px] border border-surface-border bg-white text-ink mb-3 disabled:opacity-50 resize-y"
          placeholder="Plain text or basic HTML supported."
        />
        {error && <div className="text-[12px] text-red-600 mb-3">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={sending} className="text-sm px-4 py-2 rounded-[8px] text-grey-40 hover:text-grey-15 disabled:opacity-50">Cancel</button>
          <button
            onClick={send}
            disabled={disabled}
            className="text-sm px-4 py-2 rounded-[8px] bg-brand-500 text-white hover:bg-brand-600 font-medium disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send email'}
          </button>
        </div>
      </div>
    </div>
  )
}
