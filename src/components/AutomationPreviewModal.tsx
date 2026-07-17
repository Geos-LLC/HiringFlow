'use client'

import { useEffect, useState } from 'react'

// Payload shape returned by /api/automations/[id]/preview. Kept in sync
// with the endpoint's NextResponse.json body — narrow enough for what
// the modal renders, no more.
export type AutomationPreviewPayload = {
  channel?: 'email' | 'sms'
  subject?: string
  html?: string
  text?: string | null
  smsBody?: string
  length?: number
  segments?: number
  recipient: string
  from: { name: string; email: string }
  templateName: string
  stepOrder?: number
  stepId?: string
}

type Props = {
  ruleId: string
  ruleName: string
  onClose: () => void
  // Recruiter-only test-send from the automations dashboard. Candidate-page
  // usage passes false so the SMS row + fetch call are omitted entirely —
  // the candidate detail surface is inspection-only.
  enableSmsTestSend?: boolean
}

// Presentational + fetch wrapper for the saved-rule preview modal. Extracted
// from the automations dashboard so /dashboard/candidates/[id] can inline it
// instead of opening a new tab to /dashboard/automations?rule=<id> just to
// look at what a rule will send.
export default function AutomationPreviewModal({ ruleId, ruleName, onClose, enableSmsTestSend = false }: Props) {
  const [preview, setPreview] = useState<AutomationPreviewPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/automations/${ruleId}/preview`, { method: 'POST' })
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setError(data.error || res.statusText || 'Preview failed')
        } else {
          setPreview(data)
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message || 'Preview failed')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [ruleId])

  // SMS test-send: only mounted when the parent surface enables it.
  const [testSmsPhone, setTestSmsPhone] = useState('')
  const [testSmsSending, setTestSmsSending] = useState(false)
  const [testSmsResult, setTestSmsResult] = useState<{ ok: boolean; message: string } | null>(null)
  const sendTestSms = async () => {
    if (!preview || preview.channel !== 'sms' || !preview.smsBody) return
    setTestSmsSending(true)
    setTestSmsResult(null)
    try {
      const res = await fetch('/api/automations/preview-sms-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: testSmsPhone,
          ruleId,
          stepId: preview.stepId,
          fallbackBody: preview.smsBody,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setTestSmsResult({ ok: false, message: data.error || res.statusText || 'Send failed' })
      } else {
        const suffix = data.linksAreReal ? ' — links inside will open the real training / booking page.' : ' — save the rule to get working links.'
        setTestSmsResult({ ok: true, message: `Sent to ${data.sentTo || testSmsPhone}${suffix}` })
      }
    } catch (err) {
      setTestSmsResult({ ok: false, message: (err as Error).message || 'Send failed' })
    } finally {
      setTestSmsSending(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div
        className="bg-white rounded-[12px] shadow-2xl w-full max-w-[760px] max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-surface-border flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs text-grey-40 font-medium uppercase tracking-wide">
              Preview {preview?.stepOrder !== undefined ? `· Step ${preview.stepOrder + 1}` : ''}
            </div>
            <h2 className="text-lg font-semibold text-grey-15 truncate">{ruleName}</h2>
            {preview && <div className="text-xs text-grey-40 mt-0.5">Template: {preview.templateName}</div>}
          </div>
          <button
            onClick={onClose}
            className="text-grey-40 hover:text-grey-15 text-xl leading-none px-2"
            aria-label="Close"
          >×</button>
        </div>

        {loading && (
          <div className="flex-1 flex items-center justify-center py-12 text-sm text-grey-40">Loading preview…</div>
        )}

        {error && (
          <div className="flex-1 flex items-center justify-center py-12 px-6 text-sm text-red-600">{error}</div>
        )}

        {preview && !loading && !error && (
          <>
            <div className="px-6 py-4 border-b border-surface-border bg-surface-light text-[13px] space-y-1.5">
              <div className="flex gap-2"><span className="text-grey-40 w-16 flex-shrink-0">Channel</span><span className="text-grey-15 font-medium uppercase">{preview.channel || 'email'}</span></div>
              <div className="flex gap-2"><span className="text-grey-40 w-16 flex-shrink-0">From</span><span className="text-grey-15">{preview.from.name} &lt;{preview.from.email}&gt;</span></div>
              <div className="flex gap-2"><span className="text-grey-40 w-16 flex-shrink-0">To</span><span className="text-grey-15">{preview.recipient}</span></div>
              {preview.channel !== 'sms' && (
                <div className="flex gap-2"><span className="text-grey-40 w-16 flex-shrink-0">Subject</span><span className="text-grey-15 font-medium">{preview.subject}</span></div>
              )}
              {preview.channel === 'sms' && preview.length !== undefined && (
                <div className="flex gap-2"><span className="text-grey-40 w-16 flex-shrink-0">Length</span><span className="text-grey-15 font-mono">{preview.length} chars · {preview.segments} segment{(preview.segments || 0) > 1 ? 's' : ''}</span></div>
              )}
            </div>
            <div className="flex-1 overflow-auto">
              {preview.channel === 'sms' ? (
                <div className="p-6">
                  <div className="max-w-[320px] mx-auto bg-blue-500 text-white rounded-2xl rounded-bl-sm px-4 py-3 text-sm whitespace-pre-wrap break-words shadow">
                    {preview.smsBody}
                  </div>
                </div>
              ) : (
                <div className="p-6 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: preview.html || '' }} />
              )}
            </div>
            {enableSmsTestSend && preview.channel === 'sms' && (
              <div className="px-6 py-3 border-t border-surface-border bg-white">
                <div className="text-xs font-medium text-grey-20 mb-1.5">Send test SMS</div>
                <div className="flex items-center gap-2">
                  <input
                    type="tel"
                    value={testSmsPhone}
                    onChange={(e) => setTestSmsPhone(e.target.value)}
                    placeholder="+15551234567"
                    className="flex-1 px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    disabled={testSmsSending}
                  />
                  <button
                    onClick={sendTestSms}
                    disabled={testSmsSending || testSmsPhone.trim().length < 7}
                    className="px-3 py-2 rounded-[8px] bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {testSmsSending ? 'Sending…' : 'Send test'}
                  </button>
                </div>
                {testSmsResult && (
                  <div className={`text-xs mt-1.5 ${testSmsResult.ok ? 'text-green-700' : 'text-red-600'}`}>
                    {testSmsResult.ok ? '✓ ' : '✗ '}{testSmsResult.message}
                  </div>
                )}
                <p className="text-[11px] text-grey-40 mt-1.5">
                  Links inside are minted for real — the training / booking page opens when you tap them. Standard SMS rates apply.
                </p>
              </div>
            )}
            <div className="px-6 py-3 border-t border-surface-border bg-surface-light flex items-center justify-between text-xs text-grey-40">
              <span>Sample values shown for merge tokens. {preview.channel === 'sms' ? (enableSmsTestSend ? 'Use the field above to send a test.' : 'No message sent.') : 'No message sent.'}</span>
              <button onClick={onClose} className="text-grey-15 hover:text-grey-40 font-medium">Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
