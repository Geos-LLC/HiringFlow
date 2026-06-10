'use client'

/**
 * Recruiter-facing message composer on the candidate drawer. Mirrors the
 * Automations → Templates editor layout so the same fields, merge tokens,
 * and "save as new template" flow are reused here.
 *
 * Posts to /api/candidates/[id]/send-message — supports email, SMS, or
 * both in a single request.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

interface EmailTemplate { id: string; name: string; subject: string; bodyHtml: string; bodyText: string | null }
interface SmsTemplate { id: string; name: string; body: string }

interface SendMessageModalProps {
  candidateId: string
  candidateEmail: string | null
  candidatePhone: string | null
  // When the candidate has been marked rejected with a reason, callers can
  // pass it here to enable the "Generate with AI" button — the AI endpoint
  // refuses without a reason on file.
  candidateRejectionReason?: string | null
  // Caller can pre-run AI generation on mount (used by the rejection flow on
  // the full candidate detail page, which used to auto-draft on open).
  autoGenerateRejectionEmail?: boolean
  onClose: () => void
  onSent?: () => void
}

// Source of truth: src/lib/automation.ts executeStep. Keep in sync with
// the Templates editor — same pill bank, same names.
const VARIABLES = [
  '{{candidate_name}}', '{{candidate_email}}', '{{candidate_phone}}',
  '{{flow_name}}', '{{source}}', '{{ad_name}}',
  '{{meeting_date}}', '{{meeting_clock}}', '{{meeting_time}}', '{{meeting_link}}',
  '{{reschedule_link}}', '{{cancel_link}}',
  '{{training_link}}', '{{schedule_link}}',
]

type Channel = 'email' | 'sms' | 'both'

export function SendMessageModal({
  candidateId,
  candidateEmail,
  candidatePhone,
  candidateRejectionReason,
  autoGenerateRejectionEmail,
  onClose,
  onSent,
}: SendMessageModalProps) {
  const hasEmail = !!candidateEmail
  const hasPhone = !!candidatePhone
  const canGenerateAi = !!candidateRejectionReason

  const defaultChannel: Channel = hasEmail ? 'email' : hasPhone ? 'sms' : 'email'
  const [channel, setChannel] = useState<Channel>(defaultChannel)

  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([])
  const [smsTemplates, setSmsTemplates] = useState<SmsTemplate[]>([])
  const [templatesLoaded, setTemplatesLoaded] = useState(false)

  const [emailTemplateId, setEmailTemplateId] = useState<string>('')
  const [smsTemplateId, setSmsTemplateId] = useState<string>('')

  const [emailSubject, setEmailSubject] = useState('')
  const [emailBodyHtml, setEmailBodyHtml] = useState('')
  const [emailBodyText, setEmailBodyText] = useState('')
  const [smsBody, setSmsBody] = useState('')

  // Save-as-new template state, per channel.
  const [saveEmailAsNew, setSaveEmailAsNew] = useState(false)
  const [newEmailTemplateName, setNewEmailTemplateName] = useState('')
  const [saveSmsAsNew, setSaveSmsAsNew] = useState(false)
  const [newSmsTemplateName, setNewSmsTemplateName] = useState('')

  const [sending, setSending] = useState(false)
  const [generatingAi, setGeneratingAi] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [partial, setPartial] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/email-templates').then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch('/api/sms-templates').then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]).then(([e, s]) => {
      setEmailTemplates(Array.isArray(e) ? e : [])
      setSmsTemplates(Array.isArray(s) ? s : [])
      setTemplatesLoaded(true)
    })
  }, [])

  const generateRejectionEmail = async () => {
    if (generatingAi || sending) return
    if (!canGenerateAi) return
    setGeneratingAi(true)
    setError(null)
    try {
      const res = await fetch(`/api/candidates/${candidateId}/generate-rejection-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: candidateRejectionReason || '' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || 'AI generation failed')
        return
      }
      setEmailSubject(data?.subject || '')
      setEmailBodyHtml(data?.bodyHtml || '')
      setEmailBodyText('')
      // Picking a template no longer reflects what's in the editor — clear
      // the selection so the dropdown doesn't lie.
      setEmailTemplateId('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI generation failed')
    } finally {
      setGeneratingAi(false)
    }
  }

  // One-shot autodraft: callers that opened the modal as a rejection flow
  // get the AI body filled in on mount, matching the old reject-composer
  // UX. Guarded with a ref so React 18 strict-mode double-mount doesn't
  // fire two OpenAI calls.
  const autoGenFiredRef = useRef(false)
  useEffect(() => {
    if (autoGenFiredRef.current) return
    if (autoGenerateRejectionEmail && canGenerateAi) {
      autoGenFiredRef.current = true
      generateRejectionEmail()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerateRejectionEmail, canGenerateAi])

  const showEmail = channel === 'email' || channel === 'both'
  const showSms = channel === 'sms' || channel === 'both'

  const smsLen = smsBody.length
  const smsSegments = Math.max(1, Math.ceil(smsLen / 160))

  const applyEmailTemplate = (id: string) => {
    setEmailTemplateId(id)
    if (!id) return
    const t = emailTemplates.find((x) => x.id === id)
    if (!t) return
    setEmailSubject(t.subject)
    setEmailBodyHtml(t.bodyHtml)
    setEmailBodyText(t.bodyText || '')
    setSaveEmailAsNew(false)
  }
  const applySmsTemplate = (id: string) => {
    setSmsTemplateId(id)
    if (!id) return
    const t = smsTemplates.find((x) => x.id === id)
    if (!t) return
    setSmsBody(t.body)
    setSaveSmsAsNew(false)
  }

  const disabled = useMemo(() => {
    if (sending) return true
    if (showEmail) {
      if (!hasEmail) return true
      if (!emailSubject.trim() || !emailBodyHtml.trim()) return true
      if (saveEmailAsNew && !newEmailTemplateName.trim()) return true
    }
    if (showSms) {
      if (!hasPhone) return true
      if (!smsBody.trim()) return true
      if (saveSmsAsNew && !newSmsTemplateName.trim()) return true
    }
    return false
  }, [sending, showEmail, showSms, hasEmail, hasPhone, emailSubject, emailBodyHtml, smsBody, saveEmailAsNew, newEmailTemplateName, saveSmsAsNew, newSmsTemplateName])

  const sendLabel = sending
    ? 'Sending…'
    : channel === 'email' ? 'Send email'
    : channel === 'sms' ? 'Send SMS'
    : 'Send both'

  const send = async () => {
    if (disabled) return
    setSending(true)
    setError(null)
    setPartial(null)
    try {
      const payload: Record<string, unknown> = { channels: channel }
      if (showEmail) {
        payload.email = {
          subject: emailSubject.trim(),
          bodyHtml: emailBodyHtml.trim(),
          bodyText: emailBodyText.trim() || null,
          ...(saveEmailAsNew ? { saveAsTemplate: { name: newEmailTemplateName.trim() } } : {}),
        }
      }
      if (showSms) {
        payload.sms = {
          body: smsBody.trim(),
          ...(saveSmsAsNew ? { saveAsTemplate: { name: newSmsTemplateName.trim() } } : {}),
        }
      }
      const res = await fetch(`/api/candidates/${candidateId}/send-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || 'Send failed')
        return
      }
      // Both channels requested but only one succeeded — surface a
      // partial-success message so the recruiter knows to retry the
      // failed channel instead of resending the whole thing.
      if (channel === 'both') {
        const emailOk = data?.email?.success
        const smsOk = data?.sms?.success
        if (emailOk && !smsOk) {
          setPartial(`Email sent. SMS failed${data?.sms?.error ? `: ${data.sms.error}` : '.'}`)
          setSending(false)
          return
        }
        if (smsOk && !emailOk) {
          setPartial(`SMS sent. Email failed${data?.email?.error ? `: ${data.email.error}` : '.'}`)
          setSending(false)
          return
        }
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
      <div
        className="bg-white rounded-[12px] shadow-2xl w-full max-w-[720px] max-h-[90vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-grey-15">Send message</h3>
            <p className="text-xs text-grey-40 mt-0.5">
              {hasEmail && <>Email → <span className="font-medium text-grey-15">{candidateEmail}</span></>}
              {hasEmail && hasPhone && <span className="text-grey-40"> · </span>}
              {hasPhone && <>SMS → <span className="font-medium text-grey-15">{candidatePhone}</span></>}
              {!hasEmail && !hasPhone && <span className="text-red-600">No email or phone on file.</span>}
            </p>
          </div>
        </div>

        {/* Channel selector */}
        <div className="inline-flex gap-1 p-1 rounded-[10px] bg-surface-weak border border-surface-border mb-4">
          <ChannelTab label="Email" active={channel === 'email'} disabled={!hasEmail} onClick={() => setChannel('email')} />
          <ChannelTab label="SMS" active={channel === 'sms'} disabled={!hasPhone} onClick={() => setChannel('sms')} />
          <ChannelTab label="Both" active={channel === 'both'} disabled={!hasEmail || !hasPhone} onClick={() => setChannel('both')} />
        </div>

        <div className="space-y-5">
          {showEmail && (
            <section className="border border-surface-border rounded-[10px] p-4 bg-white">
              <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                <div className="text-[11px] font-medium uppercase tracking-wide text-brand-700">Email</div>
                <div className="flex items-center gap-2 flex-wrap">
                  {canGenerateAi && (
                    <button
                      type="button"
                      onClick={generateRejectionEmail}
                      disabled={sending || generatingAi}
                      title={`AI-draft a rejection email about: ${candidateRejectionReason}`}
                      className="text-[12px] px-2 py-1 rounded-[6px] border border-surface-border bg-white text-grey-15 hover:bg-brand-50 hover:border-brand-200 disabled:opacity-50 flex items-center gap-1"
                    >
                      <span aria-hidden>✨</span>
                      {generatingAi
                        ? 'Generating…'
                        : (emailSubject || emailBodyHtml) ? 'Regenerate with AI' : 'Generate with AI'}
                    </button>
                  )}
                  <label className="text-[11px] text-grey-40">Template</label>
                  <select
                    value={emailTemplateId}
                    onChange={(e) => applyEmailTemplate(e.target.value)}
                    disabled={sending || !templatesLoaded}
                    className="text-[12px] px-2 py-1 rounded-[6px] border border-surface-border bg-white text-ink min-w-[180px]"
                  >
                    <option value="">Start blank…</option>
                    {emailTemplates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="block text-[11px] font-medium text-grey-35 mb-1">Subject</label>
              <input
                type="text"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                disabled={sending}
                placeholder="e.g. Quick update on your application"
                className="w-full text-[13px] px-2.5 py-1.5 rounded-[8px] border border-surface-border bg-white text-ink mb-3 disabled:opacity-50"
              />

              <label className="block text-[11px] font-medium text-grey-35 mb-1">HTML body</label>
              <textarea
                value={emailBodyHtml}
                onChange={(e) => setEmailBodyHtml(e.target.value)}
                disabled={sending}
                rows={8}
                placeholder="<p>Hi {{candidate_name}},</p>"
                className="w-full text-[13px] px-2.5 py-1.5 rounded-[8px] border border-surface-border bg-white text-ink font-mono mb-3 disabled:opacity-50 resize-y"
              />

              <label className="block text-[11px] font-medium text-grey-35 mb-1">Plain text (optional)</label>
              <textarea
                value={emailBodyText}
                onChange={(e) => setEmailBodyText(e.target.value)}
                disabled={sending}
                rows={3}
                placeholder="Hi {{candidate_name}}, …"
                className="w-full text-[13px] px-2.5 py-1.5 rounded-[8px] border border-surface-border bg-white text-ink mb-3 disabled:opacity-50 resize-y"
              />

              <SaveAsTemplateRow
                checked={saveEmailAsNew}
                onCheckedChange={setSaveEmailAsNew}
                name={newEmailTemplateName}
                onNameChange={setNewEmailTemplateName}
                disabled={sending}
                placeholder="New email template name"
              />
            </section>
          )}

          {showSms && (
            <section className="border border-surface-border rounded-[10px] p-4 bg-white">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-purple-700">SMS</div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-grey-40">Template</label>
                  <select
                    value={smsTemplateId}
                    onChange={(e) => applySmsTemplate(e.target.value)}
                    disabled={sending || !templatesLoaded}
                    className="text-[12px] px-2 py-1 rounded-[6px] border border-surface-border bg-white text-ink min-w-[180px]"
                  >
                    <option value="">Start blank…</option>
                    {smsTemplates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-medium text-grey-35">SMS body</label>
                <span className={`text-[11px] font-mono ${smsLen > 320 ? 'text-amber-700' : smsLen > 160 ? 'text-grey-15' : 'text-grey-40'}`}>
                  {smsLen} chars · {smsSegments} seg
                </span>
              </div>
              <textarea
                value={smsBody}
                onChange={(e) => setSmsBody(e.target.value)}
                disabled={sending}
                rows={4}
                placeholder="Hi {{candidate_name}}, …"
                className="w-full text-[13px] px-2.5 py-1.5 rounded-[8px] border border-surface-border bg-white text-ink font-mono mb-3 disabled:opacity-50 resize-y"
              />

              <SaveAsTemplateRow
                checked={saveSmsAsNew}
                onCheckedChange={setSaveSmsAsNew}
                name={newSmsTemplateName}
                onNameChange={setNewSmsTemplateName}
                disabled={sending}
                placeholder="New SMS template name"
              />
            </section>
          )}

          <div className="bg-surface rounded-[8px] p-3">
            <div className="text-[10px] font-medium text-grey-40 uppercase tracking-wide mb-2">Available variables (click to copy)</div>
            <div className="flex flex-wrap gap-1.5">
              {VARIABLES.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(v) }}
                  className="text-[11px] px-2 py-0.5 bg-white border border-surface-border rounded-[6px] text-grey-15 font-mono hover:bg-brand-50 hover:border-brand-200"
                  title="Click to copy"
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && <div className="mt-4 text-[12px] text-red-600">{error}</div>}
        {partial && <div className="mt-4 text-[12px] text-amber-700">{partial}</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} disabled={sending} className="text-sm px-4 py-2 rounded-[8px] text-grey-40 hover:text-grey-15 disabled:opacity-50">Cancel</button>
          <button
            onClick={send}
            disabled={disabled}
            className="text-sm px-4 py-2 rounded-[8px] bg-brand-500 text-white hover:bg-brand-600 font-medium disabled:opacity-50"
          >
            {sendLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function ChannelTab({ label, active, disabled, onClick }: { label: string; active: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1 text-[12px] rounded-[8px] font-medium transition-colors ${
        active ? 'bg-white text-grey-15 shadow-sm border border-surface-border' : 'text-grey-40 hover:text-grey-15'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  )
}

function SaveAsTemplateRow({
  checked,
  onCheckedChange,
  name,
  onNameChange,
  disabled,
  placeholder,
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  name: string
  onNameChange: (v: string) => void
  disabled: boolean
  placeholder: string
}) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <label className="flex items-center gap-2 text-[12px] text-grey-35 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheckedChange(e.target.checked)}
          disabled={disabled}
          className="rounded border-surface-border"
        />
        Save as new template
      </label>
      {checked && (
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          className="flex-1 text-[12px] px-2 py-1 rounded-[6px] border border-surface-border bg-white text-ink disabled:opacity-50"
        />
      )}
    </div>
  )
}
