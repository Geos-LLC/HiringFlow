'use client'

import { Suspense, useState, useEffect } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { MANUAL_MEETING_NUDGE_TEMPLATE_NAME } from '@/lib/email-templates-seed'

interface TemplateUsage { ruleIds: string[]; ruleNames: string[] }
interface EmailTemplate { id: string; name: string; subject: string; bodyHtml: string; bodyText: string | null; isActive: boolean; updatedAt: string; usage?: TemplateUsage }
interface SmsTemplate { id: string; name: string; body: string; isActive: boolean; updatedAt: string; usage?: TemplateUsage }

// Source of truth: src/lib/automation.ts executeStep — when adding a
// new merge token in the variables map there, mirror it here so the
// "click to copy" pill bank stays accurate.
const VARIABLES = [
  '{{candidate_name}}', '{{candidate_email}}', '{{candidate_phone}}',
  '{{flow_name}}', '{{source}}', '{{ad_name}}',
  '{{meeting_date}}', '{{meeting_clock}}', '{{meeting_time}}', '{{meeting_link}}',
  '{{reschedule_link}}', '{{cancel_link}}',
  '{{training_link}}', '{{schedule_link}}',
]

type Tab = 'email' | 'sms'

// Next 14 requires anything calling useSearchParams() at module top level to
// be wrapped in <Suspense> or the static-export pass during `next build`
// fails with "useSearchParams() should be wrapped in a suspense boundary".
// Without this wrap the prod deploy errored on prerender of this page (see
// Vercel build log for commit 397c1a2 — it broke deploys until this fix).
export default function TemplatesPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-grey-40">Loading templates…</div>}>
      <TemplatesContent />
    </Suspense>
  )
}

function TemplatesContent() {
  const searchParams = useSearchParams()
  const initialTab: Tab = searchParams?.get('tab') === 'sms' ? 'sms' : 'email'
  const [tab, setTab] = useState<Tab>(initialTab)
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([])
  const [smsTemplates, setSmsTemplates] = useState<SmsTemplate[]>([])
  const [loading, setLoading] = useState(true)

  // Email modal state
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [editingEmail, setEditingEmail] = useState<EmailTemplate | null>(null)
  const [emailName, setEmailName] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBodyHtml, setEmailBodyHtml] = useState('')
  const [emailBodyText, setEmailBodyText] = useState('')

  // SMS modal state
  const [showSmsModal, setShowSmsModal] = useState(false)
  const [editingSms, setEditingSms] = useState<SmsTemplate | null>(null)
  const [smsName, setSmsName] = useState('')
  const [smsBody, setSmsBody] = useState('')

  const [saving, setSaving] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/email-templates').then(r => r.ok ? r.json() : []),
      fetch('/api/sms-templates').then(r => r.ok ? r.json() : []),
    ]).then(([e, s]) => { setEmailTemplates(e); setSmsTemplates(s); setLoading(false) })
  }, [])

  const refreshEmail = async () => { const r = await fetch('/api/email-templates'); if (r.ok) setEmailTemplates(await r.json()) }
  const refreshSms = async () => { const r = await fetch('/api/sms-templates'); if (r.ok) setSmsTemplates(await r.json()) }

  // ─── Email ─────────────────────────────────────────────────────────────
  const openCreateEmail = () => {
    setEditingEmail(null); setEmailName(''); setEmailSubject('')
    setEmailBodyHtml('<p>Hi {{candidate_name}},</p>\n<p>Thank you for completing the application.</p>\n<p><a href="{{training_link}}">Start your training</a></p>')
    setEmailBodyText(''); setShowEmailModal(true)
  }
  const openEditEmail = (t: EmailTemplate) => {
    setEditingEmail(t); setEmailName(t.name); setEmailSubject(t.subject)
    setEmailBodyHtml(t.bodyHtml); setEmailBodyText(t.bodyText || ''); setShowEmailModal(true)
  }
  const saveEmail = async () => {
    if (!emailName.trim() || !emailSubject.trim() || !emailBodyHtml.trim()) return
    setSaving(true)
    const body = { name: emailName, subject: emailSubject, bodyHtml: emailBodyHtml, bodyText: emailBodyText || null }
    if (editingEmail) {
      await fetch(`/api/email-templates/${editingEmail.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    } else {
      await fetch('/api/email-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    }
    setSaving(false); setShowEmailModal(false); refreshEmail()
  }
  const removeEmail = async (id: string) => {
    if (!confirm('Delete this email template?')) return
    const res = await fetch(`/api/email-templates/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      // Server-side delete-guard surfaces "still used by …" — show the rule
      // list so the recruiter can unhook them before retrying.
      const data = await res.json().catch(() => null)
      if (data?.code === 'template_in_use' && Array.isArray(data?.usage?.ruleNames)) {
        const names: string[] = data.usage.ruleNames
        alert(`Can’t delete — this template is still used by:\n\n• ${names.join('\n• ')}\n\nDetach it from those rules first.`)
      } else {
        alert(data?.error || 'Delete failed')
      }
      return
    }
    refreshEmail()
  }

  // ─── SMS ───────────────────────────────────────────────────────────────
  const openCreateSms = () => {
    setEditingSms(null); setSmsName(''); setSmsBody('Hi {{candidate_name}}, '); setShowSmsModal(true)
  }
  const openEditSms = (t: SmsTemplate) => {
    setEditingSms(t); setSmsName(t.name); setSmsBody(t.body); setShowSmsModal(true)
  }
  const saveSms = async () => {
    if (!smsName.trim() || !smsBody.trim()) return
    setSaving(true)
    const payload = { name: smsName, body: smsBody }
    if (editingSms) {
      await fetch(`/api/sms-templates/${editingSms.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    } else {
      await fetch('/api/sms-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    }
    setSaving(false); setShowSmsModal(false); refreshSms()
  }
  const removeSms = async (id: string) => {
    if (!confirm('Delete this SMS template?')) return
    const res = await fetch(`/api/sms-templates/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      if (data?.code === 'template_in_use' && Array.isArray(data?.usage?.ruleNames)) {
        const names: string[] = data.usage.ruleNames
        alert(`Can’t delete — this template is still used by:\n\n• ${names.join('\n• ')}\n\nDetach it from those rules first.`)
      } else {
        alert(data?.error || 'Delete failed')
      }
      return
    }
    refreshSms()
  }

  if (loading) return <div className="text-center py-12 text-grey-40">Loading...</div>

  const smsBodyLen = smsBody.length
  const smsSegments = Math.max(1, Math.ceil(smsBodyLen / 160))

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link href="/dashboard/automations" className="text-grey-40 hover:text-grey-15">&larr; Automations</Link>
          </div>
          <h1 className="text-[36px] font-semibold text-grey-15">Templates</h1>
          <p className="text-grey-35 mt-1">Reusable email and SMS bodies for automations</p>
        </div>
        <button onClick={tab === 'email' ? openCreateEmail : openCreateSms} className="btn-primary">
          + Create {tab === 'email' ? 'Email' : 'SMS'} Template
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-surface-border mb-6">
        <button
          onClick={() => setTab('email')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === 'email' ? 'border-brand-500 text-brand-700' : 'border-transparent text-grey-40 hover:text-grey-15'
          }`}
        >
          Email <span className="ml-1.5 text-xs text-grey-40">({emailTemplates.length})</span>
        </button>
        <button
          onClick={() => setTab('sms')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === 'sms' ? 'border-purple-500 text-purple-700' : 'border-transparent text-grey-40 hover:text-grey-15'
          }`}
        >
          SMS <span className="ml-1.5 text-xs text-grey-40">({smsTemplates.length})</span>
        </button>
      </div>

      {/* Email list */}
      {tab === 'email' && (
        emailTemplates.length === 0 ? (
          <div className="section-card text-center py-16">
            <div className="w-16 h-16 mx-auto mb-4 bg-brand-50 rounded-[8px] flex items-center justify-center">
              <svg className="w-8 h-8 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
            </div>
            <h2 className="text-xl font-semibold text-grey-15 mb-2">No email templates yet</h2>
            <p className="text-grey-35 mb-6">Create your first email template</p>
            <button onClick={openCreateEmail} className="btn-primary">+ Create Email Template</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {emailTemplates.map((t) => (
              <div key={t.id} className="bg-white rounded-lg border border-surface-border p-5 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h3 className="font-medium text-grey-15">{t.name}</h3>
                  <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand-50 text-brand-700">Email</span>
                </div>
                <p className="text-sm text-grey-40 mb-3 truncate">Subject: {t.subject}</p>
                <UsageBadge usage={t.usage} />
                <div className="flex items-center gap-3">
                  <button onClick={() => openEditEmail(t)} className="text-xs text-brand-500 hover:text-brand-600 font-medium">Edit</button>
                  <button onClick={() => removeEmail(t.id)} className="text-xs text-grey-35 hover:text-grey-15">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* SMS list */}
      {tab === 'sms' && (
        smsTemplates.length === 0 ? (
          <div className="section-card text-center py-16">
            <div className="w-16 h-16 mx-auto mb-4 bg-purple-50 rounded-[8px] flex items-center justify-center">
              <svg className="w-8 h-8 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
            </div>
            <h2 className="text-xl font-semibold text-grey-15 mb-2">No SMS templates yet</h2>
            <p className="text-grey-35 mb-6">Create your first SMS template</p>
            <button onClick={openCreateSms} className="btn-primary">+ Create SMS Template</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {smsTemplates.map((t) => (
              <div key={t.id} className="bg-white rounded-lg border border-surface-border p-5 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h3 className="font-medium text-grey-15">{t.name}</h3>
                  <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-purple-50 text-purple-700">SMS</span>
                </div>
                <p className="text-sm text-grey-40 mb-3 line-clamp-2 whitespace-pre-wrap">{t.body}</p>
                <UsageBadge usage={t.usage} />
                <div className="flex items-center gap-3">
                  <button onClick={() => openEditSms(t)} className="text-xs text-purple-700 hover:text-purple-900 font-medium">Edit</button>
                  <button onClick={() => removeSms(t.id)} className="text-xs text-grey-35 hover:text-grey-15">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Email Modal */}
      {showEmailModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-white rounded-[12px] shadow-2xl p-8 w-full max-w-[640px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-semibold text-grey-15 mb-6">{editingEmail ? 'Edit Email Template' : 'Create Email Template'}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Template Name</label>
                <input type="text" value={emailName} onChange={(e) => setEmailName(e.target.value)} placeholder="e.g. Training Invitation" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Subject Line</label>
                <input type="text" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} placeholder="e.g. Your training is ready, {{candidate_name}}!" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-grey-20">HTML Body</label>
                </div>
                <textarea value={emailBodyHtml} onChange={(e) => setEmailBodyHtml(e.target.value)} rows={10} placeholder="<p>Hi {{candidate_name}},</p>" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">
                  {emailName === MANUAL_MEETING_NUDGE_TEMPLATE_NAME ? 'Plain text / SMS body' : 'Plain Text (optional)'}
                </label>
                <textarea value={emailBodyText} onChange={(e) => setEmailBodyText(e.target.value)} rows={4} placeholder="Hi {{candidate_name}}, ..." className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                {emailName === MANUAL_MEETING_NUDGE_TEMPLATE_NAME && (
                  <p className="mt-1.5 text-xs text-grey-40">
                    For this template, the plain-text field is also sent as the SMS body when a recruiter clicks <span className="font-medium text-grey-20">Send reminder</span> on the candidate page (and the candidate has a phone on file). Keep it short.
                  </p>
                )}
              </div>
              <div className="bg-surface rounded-[8px] p-4">
                <label className="text-xs font-medium text-grey-40 uppercase mb-2 block">Available Variables</label>
                <div className="flex flex-wrap gap-2">
                  {VARIABLES.map(v => (
                    <button key={v} onClick={() => { navigator.clipboard.writeText(v) }} className="text-xs px-2.5 py-1 bg-white border border-surface-border rounded-[8px] text-grey-15 font-mono hover:bg-brand-50 hover:border-brand-200" title="Click to copy">
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowEmailModal(false)} className="btn-secondary flex-1">Cancel</button>
              <button onClick={saveEmail} disabled={saving || !emailName.trim() || !emailSubject.trim() || !emailBodyHtml.trim()} className="btn-primary flex-1 disabled:opacity-50">{saving ? 'Saving...' : editingEmail ? 'Save' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}

      {/* SMS Modal */}
      {showSmsModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-white rounded-[12px] shadow-2xl p-8 w-full max-w-[640px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-semibold text-grey-15 mb-6">{editingSms ? 'Edit SMS Template' : 'Create SMS Template'}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Template Name</label>
                <input type="text" value={smsName} onChange={(e) => setSmsName(e.target.value)} placeholder="e.g. 1-hour Reminder" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-grey-20">SMS Body</label>
                  <span className={`text-[11px] font-mono ${smsBodyLen > 320 ? 'text-amber-700' : smsBodyLen > 160 ? 'text-grey-15' : 'text-grey-40'}`}>
                    {smsBodyLen} chars · {smsSegments} seg
                  </span>
                </div>
                <textarea value={smsBody} onChange={(e) => setSmsBody(e.target.value)} rows={5} placeholder="Hi {{candidate_name}}, your interview starts at {{meeting_time}}. Join: {{meeting_link}}" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono" />
              </div>
              <div className="bg-surface rounded-[8px] p-4">
                <label className="text-xs font-medium text-grey-40 uppercase mb-2 block">Available Variables</label>
                <div className="flex flex-wrap gap-2">
                  {VARIABLES.map(v => (
                    <button key={v} onClick={() => { navigator.clipboard.writeText(v) }} className="text-xs px-2.5 py-1 bg-white border border-surface-border rounded-[8px] text-grey-15 font-mono hover:bg-brand-50 hover:border-brand-200" title="Click to copy">
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowSmsModal(false)} className="btn-secondary flex-1">Cancel</button>
              <button onClick={saveSms} disabled={saving || !smsName.trim() || !smsBody.trim()} className="btn-primary flex-1 disabled:opacity-50">{saving ? 'Saving...' : editingSms ? 'Save' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Renders the "Used in N rules" or "Not used" pill above the Edit/Delete row.
// Truncates the rule-name list past 2 names so a heavily-shared template
// doesn't blow up the card height — the full list is in the tooltip.
function UsageBadge({ usage }: { usage?: TemplateUsage }) {
  const names = usage?.ruleNames ?? []
  if (names.length === 0) {
    return (
      <div className="mb-3 text-[11px]">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-weak text-grey-50 font-medium">
          Not used
        </span>
      </div>
    )
  }
  const preview = names.slice(0, 2).join(', ')
  const rest = names.length - 2
  const tooltip = names.join('\n')
  return (
    <div className="mb-3 text-[11px] text-grey-35" title={tooltip}>
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">
        Used in {names.length} rule{names.length === 1 ? '' : 's'}
      </span>
      <span className="ml-2 text-grey-40 truncate align-middle">
        {preview}{rest > 0 ? `, +${rest} more` : ''}
      </span>
    </div>
  )
}
