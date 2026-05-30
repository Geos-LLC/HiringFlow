'use client'

import { useState, useEffect, useRef } from 'react'
import { SubNav } from '../_components/SubNav'
import { DEFAULT_EMAIL_TEMPLATES, type DefaultEmailTemplate } from '@/lib/email-templates-seed'
import { DEFAULT_SMS_TEMPLATES, type DefaultSmsTemplate } from '@/lib/sms-templates-seed'
import { Badge, Button, PageHeader } from '@/components/design'
import { plainTextToHtml, htmlToPlainText, applyInlineMarkdown } from '@/lib/markdown'

const ASSETS_NAV = [
  { href: '/dashboard/content', label: 'Templates' },
  { href: '/dashboard/videos', label: 'Media' },
]

interface EmailTemplate { id: string; name: string; subject: string; bodyHtml: string; bodyText: string | null; isActive: boolean; updatedAt: string }
interface SmsTemplate { id: string; name: string; body: string; isActive: boolean; updatedAt: string }
interface AdTemplate { id: string; name: string; source: string; headline: string; bodyText: string; requirements: string | null; benefits: string | null; callToAction: string | null; isActive: boolean; updatedAt: string }

// Source of truth for the "Variables — click to copy" pill bank in the
// email/SMS template editor. Must stay in sync with the variables map
// built in src/lib/automation.ts executeStep — when adding a new merge
// token, add it both there (so it resolves at send time) and here (so
// users know it exists).
const EMAIL_VARIABLES = [
  '{{candidate_name}}', '{{candidate_email}}', '{{candidate_phone}}',
  '{{flow_name}}', '{{source}}', '{{ad_name}}',
  '{{meeting_date}}', '{{meeting_clock}}', '{{meeting_time}}', '{{meeting_link}}',
  '{{reschedule_link}}', '{{cancel_link}}',
  '{{training_link}}', '{{schedule_link}}',
]
const SMS_VARIABLES = EMAIL_VARIABLES
const SOURCES = ['general', 'indeed', 'facebook', 'craigslist', 'google', 'linkedin', 'instagram', 'tiktok', 'other']

// Recruiters compose in plain text with optional lightweight markdown markers
// (`**bold**`, `*italic*`, `[text](url)`, `- ` bullets, `1.` numbered) inserted
// via the small toolbar above the textarea. We expand markdown → HTML on save
// and reverse it on edit so the field is round-trippable. Heavier styling on
// seeded defaults (e.g. orange button-styled `<a>`) flattens to a plain link
// on edit — recruiters can re-pick the default if they want the button back.

// Small markdown toolbar bound to a textarea ref. Buttons wrap the current
// selection (or insert a placeholder at the caret) with markdown markers and
// restore focus + selection so typing can continue.
function MarkdownToolbar({ textareaRef, value, onChange }: {
  textareaRef: React.RefObject<HTMLTextAreaElement>
  value: string
  onChange: (next: string) => void
}) {
  const wrap = (before: string, after: string, placeholder: string) => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const sel = value.slice(start, end) || placeholder
    const next = value.slice(0, start) + before + sel + after + value.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      ta.focus()
      const a = start + before.length
      const b = a + sel.length
      ta.setSelectionRange(a, b)
    })
  }

  const insertLink = () => {
    const ta = textareaRef.current
    if (!ta) return
    const url = window.prompt('Link URL (https://… or {{meeting_link}}):')
    if (!url) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const label = value.slice(start, end) || url
    const insert = `[${label}](${url})`
    const next = value.slice(0, start) + insert + value.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      ta.focus()
      const cursor = start + insert.length
      ta.setSelectionRange(cursor, cursor)
    })
  }

  const prefixLines = (linePrefix: (i: number) => string) => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    // Expand the selection to whole lines so the prefix is applied per row.
    const blockStart = value.lastIndexOf('\n', start - 1) + 1
    const tailIdx = value.indexOf('\n', end)
    const blockEnd = tailIdx === -1 ? value.length : tailIdx
    const block = value.slice(blockStart, blockEnd)
    const prefixed = block.split('\n').map((l, i) => linePrefix(i) + l).join('\n')
    const next = value.slice(0, blockStart) + prefixed + value.slice(blockEnd)
    onChange(next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(blockStart, blockStart + prefixed.length)
    })
  }

  const btn = 'px-2 py-1 text-xs text-grey-15 hover:bg-white rounded transition-colors'
  return (
    <div className="flex items-center gap-0.5 px-2 py-1.5 border border-surface-border border-b-0 rounded-t-[8px] bg-surface">
      <button type="button" onClick={() => wrap('**', '**', 'bold text')} title="Bold (**text**)" className={`${btn} font-bold`}>B</button>
      <button type="button" onClick={() => wrap('*', '*', 'italic text')} title="Italic (*text*)" className={`${btn} italic`}>I</button>
      <button type="button" onClick={insertLink} title="Insert link [text](url)" className={btn}>Link</button>
      <span className="w-px h-4 bg-surface-border mx-1" aria-hidden />
      <button type="button" onClick={() => prefixLines(() => '- ')} title="Bulleted list" className={btn}>• List</button>
      <button type="button" onClick={() => prefixLines((i) => `${i + 1}. `)} title="Numbered list" className={btn}>1. List</button>
    </div>
  )
}

const EMAIL_DEFAULTS: Array<DefaultEmailTemplate & { category: 'email' }> = DEFAULT_EMAIL_TEMPLATES.map(t => ({ ...t, category: 'email' as const }))
const SMS_DEFAULTS: Array<DefaultSmsTemplate & { category: 'sms' }> = DEFAULT_SMS_TEMPLATES.map(t => ({ ...t, category: 'sms' as const }))

const AD_DEFAULTS = [
  { name: 'Indeed - General Hiring', source: 'indeed', headline: 'Now Hiring — Join Our Team!', bodyText: 'We are looking for motivated team members to join our growing company.\n\nGreat opportunity for career growth.', requirements: '- Authorized to work\n- Reliable transportation\n- Positive attitude', benefits: '- Competitive pay\n- Flexible schedule\n- Growth opportunities', callToAction: 'Apply now — takes less than 5 minutes!' },
  { name: 'Facebook - Casual Tone', source: 'facebook', headline: "We're Hiring! Come Work With Us", bodyText: "Looking for your next gig? We're hiring and we'd love to hear from you.\n\nNo long applications — just a quick intro.", requirements: null, benefits: '- Weekly pay\n- Friendly team\n- No experience needed', callToAction: 'Tap the link to apply — only takes a few minutes!' },
  { name: 'Craigslist - Simple', source: 'craigslist', headline: 'HIRING NOW — Apply Today', bodyText: 'Immediate openings. We need reliable, hardworking individuals. Full-time and part-time.', requirements: '- Must be 18+\n- Background check\n- Valid ID', benefits: '- Start ASAP\n- Paid training\n- Weekly pay', callToAction: 'Click the link to apply online.' },
  { name: 'LinkedIn - Professional', source: 'linkedin', headline: 'Join Our Growing Team', bodyText: 'We are expanding and looking for talented professionals to join us.\n\nIf you are passionate about making a difference, we want to hear from you.', requirements: '- Relevant experience preferred\n- Strong communication skills', benefits: '- Career development\n- Competitive compensation\n- Great team culture', callToAction: 'Apply through our streamlined process today.' },
]

export default function ContentPage() {
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([])
  const [smsTemplates, setSmsTemplates] = useState<SmsTemplate[]>([])
  const [adTemplates, setAdTemplates] = useState<AdTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'email' | 'sms' | 'ad'>('all')
  const [sourceFilter, setSourceFilter] = useState('all')

  // Email modal
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [editingEmail, setEditingEmail] = useState<EmailTemplate | null>(null)
  const [emailName, setEmailName] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [emailSaving, setEmailSaving] = useState(false)
  const [previewEmail, setPreviewEmail] = useState<EmailTemplate | null>(null)
  const emailBodyRef = useRef<HTMLTextAreaElement>(null)

  // SMS modal
  const [showSmsModal, setShowSmsModal] = useState(false)
  const [editingSms, setEditingSms] = useState<SmsTemplate | null>(null)
  const [smsName, setSmsName] = useState('')
  const [smsBody, setSmsBody] = useState('')
  const [smsSaving, setSmsSaving] = useState(false)
  const [previewSms, setPreviewSms] = useState<SmsTemplate | null>(null)

  // Ad modal
  const [showAdModal, setShowAdModal] = useState(false)
  const [editingAd, setEditingAd] = useState<AdTemplate | null>(null)
  const [adName, setAdName] = useState('')
  const [adSource, setAdSource] = useState('general')
  const [adHeadline, setAdHeadline] = useState('')
  const [adBody, setAdBody] = useState('')
  const [adRequirements, setAdRequirements] = useState('')
  const [adBenefits, setAdBenefits] = useState('')
  const [adCta, setAdCta] = useState('')
  const [adSaving, setAdSaving] = useState(false)
  const [previewAd, setPreviewAd] = useState<AdTemplate | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/email-templates').then(r => r.json()),
      fetch('/api/sms-templates').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/ad-templates').then(r => r.json()).catch(() => []),
    ]).then(([e, s, a]) => { setEmailTemplates(e); setSmsTemplates(s); setAdTemplates(a); setLoading(false) })
  }, [])

  const refreshEmails = async () => { const r = await fetch('/api/email-templates'); if (r.ok) setEmailTemplates(await r.json()) }
  const refreshSms = async () => { const r = await fetch('/api/sms-templates'); if (r.ok) setSmsTemplates(await r.json()) }
  const refreshAds = async () => { const r = await fetch('/api/ad-templates'); if (r.ok) setAdTemplates(await r.json()) }

  // SMS CRUD — much simpler than email: just name + body, plus a char/segment counter.
  const openCreateSms = (starter?: DefaultSmsTemplate & { category?: 'sms' }) => {
    setEditingSms(null); setSmsName(starter?.name || ''); setSmsBody(starter?.body || 'Hi {{candidate_name}}, ')
    setShowSmsModal(true)
  }
  const openEditSms = (t: SmsTemplate) => {
    setEditingSms(t); setSmsName(t.name); setSmsBody(t.body); setShowSmsModal(true)
  }
  const saveSms = async () => {
    if (!smsName.trim() || !smsBody.trim()) return
    setSmsSaving(true)
    const body = { name: smsName, body: smsBody }
    if (editingSms) { await fetch(`/api/sms-templates/${editingSms.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    else { await fetch('/api/sms-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    setSmsSaving(false); setShowSmsModal(false); refreshSms()
  }
  const deleteSms = async (id: string) => {
    if (!confirm('Delete this SMS template? Any rule still using it will fall back to its inline body.')) return
    await fetch(`/api/sms-templates/${id}`, { method: 'DELETE' }); refreshSms()
  }

  // Email CRUD — recruiter composes in plain text; HTML is generated on save.
  // When a starter is picked, prefer its bodyText if provided (e.g. the
  // manual-meeting-nudge template), otherwise convert the seeded bodyHtml
  // back to text so the recruiter sees something readable to edit.
  // Note: explicitly typed as DefaultEmailTemplate (not typeof EMAIL_DEFAULTS[0])
  // because TS infers the array's element type from the strictest common
  // shape across the spread, which drops the optional bodyText field.
  const openCreateEmail = (starter?: DefaultEmailTemplate & { category?: 'email' }) => {
    setEditingEmail(null); setEmailName(starter?.name || ''); setEmailSubject(starter?.subject || '')
    const seedText = starter?.bodyText || (starter?.bodyHtml ? htmlToPlainText(starter.bodyHtml) : 'Hi {{candidate_name}},\n\n')
    setEmailBody(seedText); setShowEmailModal(true)
  }
  const openEditEmail = (t: EmailTemplate) => {
    setEditingEmail(t); setEmailName(t.name); setEmailSubject(t.subject)
    setEmailBody(t.bodyText || htmlToPlainText(t.bodyHtml || ''))
    setShowEmailModal(true)
  }
  const saveEmail = async () => {
    if (!emailName.trim() || !emailSubject.trim() || !emailBody.trim()) return
    setEmailSaving(true)
    const body = { name: emailName, subject: emailSubject, bodyHtml: plainTextToHtml(emailBody), bodyText: emailBody }
    if (editingEmail) { await fetch(`/api/email-templates/${editingEmail.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    else { await fetch('/api/email-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    setEmailSaving(false); setShowEmailModal(false); refreshEmails()
  }
  const deleteEmail = async (id: string) => { if (!confirm('Delete?')) return; await fetch(`/api/email-templates/${id}`, { method: 'DELETE' }); refreshEmails() }

  // Ad CRUD
  const openCreateAd = (starter?: typeof AD_DEFAULTS[0]) => {
    setEditingAd(null); setAdName(starter?.name || ''); setAdSource(starter?.source || 'general')
    setAdHeadline(starter?.headline || ''); setAdBody(starter?.bodyText || '')
    setAdRequirements(starter?.requirements || ''); setAdBenefits(starter?.benefits || '')
    setAdCta(starter?.callToAction || ''); setShowAdModal(true)
  }
  const openEditAd = (t: AdTemplate) => {
    setEditingAd(t); setAdName(t.name); setAdSource(t.source); setAdHeadline(t.headline)
    setAdBody(t.bodyText); setAdRequirements(t.requirements || ''); setAdBenefits(t.benefits || '')
    setAdCta(t.callToAction || ''); setShowAdModal(true)
  }
  const saveAd = async () => {
    if (!adName.trim() || !adHeadline.trim() || !adBody.trim()) return
    setAdSaving(true)
    const body = { name: adName, source: adSource, headline: adHeadline, bodyText: adBody, requirements: adRequirements || null, benefits: adBenefits || null, callToAction: adCta || null }
    if (editingAd) { await fetch(`/api/ad-templates/${editingAd.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    else { await fetch('/api/ad-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    setAdSaving(false); setShowAdModal(false); refreshAds()
  }
  const deleteAd = async (id: string) => { if (!confirm('Delete?')) return; await fetch(`/api/ad-templates/${id}`, { method: 'DELETE' }); refreshAds() }
  const copyAdText = (t: AdTemplate) => {
    const text = [t.headline, '', t.bodyText, t.requirements ? '\nRequirements:\n' + t.requirements : '', t.benefits ? '\nBenefits:\n' + t.benefits : '', t.callToAction ? '\n' + t.callToAction : ''].filter(Boolean).join('\n')
    navigator.clipboard.writeText(text); setCopiedId(t.id); setTimeout(() => setCopiedId(null), 2000)
  }

  // Filter ad templates by source
  const filteredAdTemplates = sourceFilter === 'all' ? adTemplates : adTemplates.filter(t => t.source === sourceFilter)
  const filteredAdDefaults = sourceFilter === 'all' ? AD_DEFAULTS : AD_DEFAULTS.filter(d => d.source === sourceFilter)

  if (loading) return <div className="py-14 text-center font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>Loading…</div>

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow={`${emailTemplates.length + smsTemplates.length + adTemplates.length} template${emailTemplates.length + smsTemplates.length + adTemplates.length === 1 ? '' : 's'}`}
        title="Assets"
        description="Reusable templates and media for your flows and campaigns."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={async () => {
              // Seed both Email + SMS defaults in one click. Each endpoint
              // is idempotent (skips names that already exist).
              const [eRes, sRes] = await Promise.all([
                fetch('/api/email-templates/seed', { method: 'POST' }),
                fetch('/api/sms-templates/seed', { method: 'POST' }),
              ])
              const eD = await eRes.json().catch(() => ({}))
              const sD = await sRes.json().catch(() => ({}))
              const emailCreated = eRes.ok ? (eD.created ?? 0) : 0
              const smsCreated = sRes.ok ? (sD.created ?? 0) : 0
              alert(`Added ${emailCreated} email + ${smsCreated} SMS defaults.`)
              refreshEmails(); refreshSms()
            }}>+ Defaults</Button>
            <Button variant="secondary" size="sm" onClick={() => openCreateEmail()}>+ Email</Button>
            <Button variant="secondary" size="sm" onClick={() => openCreateSms()}>+ SMS</Button>
            <Button size="sm" onClick={() => openCreateAd()}>+ Ad</Button>
          </>
        }
      />
      <div className="px-8 pt-5">
        <SubNav items={ASSETS_NAV} />
      </div>
      <div className="px-8 py-4">
      <div className="flex items-end justify-between mb-4">
        <div>
          <div className="eyebrow mb-0.5">Templates</div>
          <div className="text-[15px] font-semibold text-ink">Emails, SMS &amp; job ads</div>
          <p className="text-grey-35 text-[12px] mt-0.5">Click a default to start, or build from scratch.</p>
        </div>
      </div>

      {/* Type + Source filters */}
      <div className="flex items-center gap-4 mb-6">
        <div className="flex gap-1 bg-surface rounded-[8px] p-1 border border-surface-border">
          {[{ v: 'all' as const, l: 'All' }, { v: 'email' as const, l: 'Emails' }, { v: 'sms' as const, l: 'SMS' }, { v: 'ad' as const, l: 'Ads' }].map(f => (
            <button key={f.v} onClick={() => setFilter(f.v)} className={`px-4 py-1.5 text-xs rounded-[6px] font-medium transition-colors ${filter === f.v ? 'bg-white text-grey-15 shadow-sm' : 'text-grey-40 hover:text-grey-20'}`}>{f.l}</button>
          ))}
        </div>
        {(filter === 'all' || filter === 'ad') && (
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="px-3 py-1.5 text-xs border border-surface-border rounded-[6px] text-grey-35">
            <option value="all">All Sources</option>
            {SOURCES.map(s => <option key={s} value={s} className="capitalize">{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
          </select>
        )}
      </div>

      {/* DEFAULT TEMPLATES — always visible */}
      <div className="mb-8">
        <h3 className="text-sm font-semibold text-grey-20 mb-3">Default Templates — click to create from these</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {(filter === 'all' || filter === 'email') && EMAIL_DEFAULTS.map((s, i) => (
            <button key={`e${i}`} onClick={() => openCreateEmail(s)} className="bg-white rounded-[8px] border border-surface-border p-4 text-left hover:shadow-md hover:border-brand-300 transition-all">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium">Email</span>
              </div>
              <div className="text-sm font-medium text-grey-15 mt-1">{s.name}</div>
              <div className="text-xs text-grey-40 truncate mt-0.5">{s.subject}</div>
            </button>
          ))}
          {(filter === 'all' || filter === 'sms') && SMS_DEFAULTS.map((s, i) => (
            <button key={`s${i}`} onClick={() => openCreateSms(s)} className="bg-white rounded-[8px] border border-surface-border p-4 text-left hover:shadow-md hover:border-brand-300 transition-all">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-600 font-medium">SMS</span>
              </div>
              <div className="text-sm font-medium text-grey-15 mt-1">{s.name}</div>
              <div className="text-xs text-grey-40 line-clamp-2 mt-0.5">{s.body}</div>
            </button>
          ))}
          {(filter === 'all' || filter === 'ad') && filteredAdDefaults.map((s, i) => (
            <button key={`a${i}`} onClick={() => openCreateAd(s)} className="bg-white rounded-[8px] border border-surface-border p-4 text-left hover:shadow-md hover:border-brand-300 transition-all">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand-50 text-brand-600 font-medium capitalize">{s.source}</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-50 text-green-600 font-medium">Ad</span>
              </div>
              <div className="text-sm font-medium text-grey-15 mt-1">{s.name}</div>
              <div className="text-xs text-grey-40 truncate mt-0.5">{s.headline}</div>
            </button>
          ))}
        </div>
      </div>

      {/* YOUR TEMPLATES */}
      {(emailTemplates.length > 0 || smsTemplates.length > 0 || adTemplates.length > 0) && (
        <>
          <h3 className="text-sm font-semibold text-grey-20 mb-3">Your Templates</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Email templates */}
            {(filter === 'all' || filter === 'email') && emailTemplates.map(t => (
              <div key={t.id} className="bg-white rounded-lg border border-surface-border p-5 hover:shadow-md transition-shadow">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium">Email</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${t.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-grey-40'}`}>{t.isActive ? 'Active' : 'Draft'}</span>
                </div>
                <h3 className="font-medium text-grey-15 mb-0.5">{t.name}</h3>
                <p className="text-xs text-grey-40 mb-3 truncate">Subject: {t.subject}</p>
                <div className="flex items-center gap-3">
                  <button onClick={() => setPreviewEmail(t)} className="text-xs text-brand-500 hover:text-brand-600 font-medium">Preview</button>
                  <button onClick={() => openEditEmail(t)} className="text-xs text-grey-35 hover:text-grey-15">Edit</button>
                  <button onClick={() => deleteEmail(t.id)} className="text-xs text-grey-35 hover:text-grey-15">Delete</button>
                </div>
              </div>
            ))}
            {/* SMS templates */}
            {(filter === 'all' || filter === 'sms') && smsTemplates.map(t => {
              const len = t.body.length
              const seg = Math.max(1, Math.ceil(len / 160))
              return (
                <div key={t.id} className="bg-white rounded-lg border border-surface-border p-5 hover:shadow-md transition-shadow">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-600 font-medium">SMS</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${t.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-grey-40'}`}>{t.isActive ? 'Active' : 'Draft'}</span>
                    <span className="text-[10px] text-grey-40 font-mono ml-auto">{len}c · {seg}s</span>
                  </div>
                  <h3 className="font-medium text-grey-15 mb-0.5">{t.name}</h3>
                  <p className="text-xs text-grey-40 mb-3 line-clamp-2 whitespace-pre-wrap">{t.body}</p>
                  <div className="flex items-center gap-3">
                    <button onClick={() => setPreviewSms(t)} className="text-xs text-brand-500 hover:text-brand-600 font-medium">Preview</button>
                    <button onClick={() => openEditSms(t)} className="text-xs text-grey-35 hover:text-grey-15">Edit</button>
                    <button onClick={() => deleteSms(t.id)} className="text-xs text-grey-35 hover:text-grey-15">Delete</button>
                  </div>
                </div>
              )
            })}
            {/* Ad templates */}
            {(filter === 'all' || filter === 'ad') && filteredAdTemplates.map(t => (
              <div key={t.id} className="bg-white rounded-lg border border-surface-border p-5 hover:shadow-md transition-shadow">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand-50 text-brand-600 font-medium capitalize">{t.source}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-50 text-green-600 font-medium">Ad</span>
                </div>
                <h3 className="font-medium text-grey-15 mb-0.5">{t.name}</h3>
                <p className="text-xs text-grey-40 mb-3 truncate">{t.headline}</p>
                <div className="flex items-center gap-3">
                  <button onClick={() => setPreviewAd(t)} className="text-xs text-brand-500 hover:text-brand-600 font-medium">Preview</button>
                  <button onClick={() => copyAdText(t)} className="text-xs text-brand-500 hover:text-brand-600 font-medium">{copiedId === t.id ? 'Copied!' : 'Copy'}</button>
                  <button onClick={() => openEditAd(t)} className="text-xs text-grey-35 hover:text-grey-15">Edit</button>
                  <button onClick={() => deleteAd(t.id)} className="text-xs text-grey-35 hover:text-grey-15">Delete</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Email Preview */}
      {previewEmail && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50" onClick={() => setPreviewEmail(null)}>
          <div className="bg-white rounded-[12px] shadow-2xl w-full max-w-[600px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b border-surface-border flex items-center justify-between">
              <div><h3 className="font-semibold text-grey-15">{previewEmail.name}</h3><p className="text-sm text-grey-40 mt-0.5">Subject: {previewEmail.subject}</p></div>
              <button onClick={() => setPreviewEmail(null)} className="text-grey-40 hover:text-grey-15 text-xl">&times;</button>
            </div>
            <div className="p-6"><div className="bg-surface rounded-[8px] p-6 border border-surface-border" dangerouslySetInnerHTML={{ __html: previewEmail.bodyHtml }} /></div>
          </div>
        </div>
      )}

      {/* Ad Preview */}
      {previewAd && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50" onClick={() => setPreviewAd(null)}>
          <div className="bg-white rounded-[12px] shadow-2xl w-full max-w-[600px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b border-surface-border flex items-center justify-between">
              <div className="flex items-center gap-2"><h3 className="font-semibold text-grey-15">{previewAd.name}</h3><span className="text-xs px-2 py-0.5 rounded-full bg-brand-50 text-brand-600 capitalize">{previewAd.source}</span></div>
              <button onClick={() => setPreviewAd(null)} className="text-grey-40 hover:text-grey-15 text-xl">&times;</button>
            </div>
            <div className="p-6 space-y-4">
              <h2 className="text-xl font-bold text-grey-15">{previewAd.headline}</h2>
              <div className="text-sm text-grey-35 whitespace-pre-wrap">{previewAd.bodyText}</div>
              {previewAd.requirements && <div><h4 className="text-sm font-semibold text-grey-15 mb-1">Requirements</h4><div className="text-sm text-grey-35 whitespace-pre-wrap">{previewAd.requirements}</div></div>}
              {previewAd.benefits && <div><h4 className="text-sm font-semibold text-grey-15 mb-1">Benefits</h4><div className="text-sm text-grey-35 whitespace-pre-wrap">{previewAd.benefits}</div></div>}
              {previewAd.callToAction && <div className="bg-brand-50 rounded-[8px] p-4 text-sm font-medium text-brand-700">{previewAd.callToAction}</div>}
            </div>
            <div className="p-4 border-t border-surface-border flex justify-end">
              <button onClick={() => { copyAdText(previewAd); setPreviewAd(null) }} className="btn-primary text-sm">Copy Full Text</button>
            </div>
          </div>
        </div>
      )}

      {/* SMS Preview */}
      {previewSms && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50" onClick={() => setPreviewSms(null)}>
          <div className="bg-white rounded-[12px] shadow-2xl w-full max-w-[480px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b border-surface-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-grey-15">{previewSms.name}</h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 font-medium">SMS</span>
              </div>
              <button onClick={() => setPreviewSms(null)} className="text-grey-40 hover:text-grey-15 text-xl">&times;</button>
            </div>
            <div className="p-6">
              <div className="bg-purple-50/30 rounded-[12px] p-4 border border-purple-100 text-sm whitespace-pre-wrap font-mono text-grey-15">{previewSms.body}</div>
              <div className="flex items-center justify-between mt-2 text-[11px] text-grey-40">
                <span>{previewSms.body.length} chars</span>
                <span>{Math.max(1, Math.ceil(previewSms.body.length / 160))} segment(s)</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SMS Modal */}
      {showSmsModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-white rounded-[12px] shadow-2xl p-8 w-full max-w-[560px] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-xl font-semibold text-grey-15 mb-6">{editingSms ? 'Edit SMS Template' : 'New SMS Template'}</h2>
            <div className="space-y-4">
              <div><label className="block text-sm font-medium text-grey-20 mb-1.5">Name</label><input type="text" value={smsName} onChange={e => setSmsName(e.target.value)} placeholder="e.g. 1-hour Reminder" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" /></div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-grey-20">Body</label>
                  <span className={`text-[11px] font-mono ${smsBody.length > 320 ? 'text-amber-700' : smsBody.length > 160 ? 'text-grey-15' : 'text-grey-40'}`}>
                    {smsBody.length} chars · {Math.max(1, Math.ceil(smsBody.length / 160))} seg
                  </span>
                </div>
                <textarea value={smsBody} onChange={e => setSmsBody(e.target.value)} rows={5} placeholder="Hi {{candidate_name}}, your interview starts at {{meeting_time}}. Join: {{meeting_link}}" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono" />
                <p className="mt-1.5 text-xs text-grey-40">Each 160-char segment is billed as a separate SMS. Keep it concise.</p>
              </div>
              <div className="bg-surface rounded-[8px] p-3"><label className="text-xs font-medium text-grey-40 uppercase mb-2 block">Variables — click to copy</label><div className="flex flex-wrap gap-2">{SMS_VARIABLES.map(v => <button key={v} onClick={() => navigator.clipboard.writeText(v)} className="text-xs px-2.5 py-1 bg-white border border-surface-border rounded-[8px] text-grey-15 font-mono hover:bg-brand-50">{v}</button>)}</div></div>
            </div>
            <div className="flex gap-3 mt-6"><button onClick={() => setShowSmsModal(false)} className="btn-secondary flex-1">Cancel</button><button onClick={saveSms} disabled={smsSaving || !smsName.trim() || !smsBody.trim()} className="btn-primary flex-1 disabled:opacity-50">{smsSaving ? 'Saving...' : editingSms ? 'Save' : 'Create'}</button></div>
          </div>
        </div>
      )}

      {/* Email Modal */}
      {showEmailModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-white rounded-[12px] shadow-2xl p-8 w-full max-w-[640px] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-xl font-semibold text-grey-15 mb-6">{editingEmail ? 'Edit Email Template' : 'New Email Template'}</h2>
            <div className="space-y-4">
              <div><label className="block text-sm font-medium text-grey-20 mb-1.5">Name</label><input type="text" value={emailName} onChange={e => setEmailName(e.target.value)} placeholder="e.g. Training Invitation" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" /></div>
              <div><label className="block text-sm font-medium text-grey-20 mb-1.5">Subject</label><input type="text" value={emailSubject} onChange={e => setEmailSubject(e.target.value)} placeholder="e.g. Your training is ready!" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" /></div>
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Body</label>
                <MarkdownToolbar textareaRef={emailBodyRef} value={emailBody} onChange={setEmailBody} />
                <textarea
                  ref={emailBodyRef}
                  value={emailBody}
                  onChange={e => setEmailBody(e.target.value)}
                  rows={10}
                  placeholder={'Hi {{candidate_name}},\n\nThanks for completing the application…'}
                  className="w-full px-4 py-3 border border-surface-border rounded-b-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <p className="mt-1.5 text-xs text-grey-40">Plain text by default — use the toolbar for <span className="font-bold">bold</span>, <span className="italic">italic</span>, links, or lists. Blank line = new paragraph. URLs and <code className="font-mono">{'{{...}}'}</code> tokens become clickable automatically.</p>
              </div>
              <div className="bg-surface rounded-[8px] p-3"><label className="text-xs font-medium text-grey-40 uppercase mb-2 block">Variables — click to copy</label><div className="flex flex-wrap gap-2">{EMAIL_VARIABLES.map(v => <button key={v} onClick={() => navigator.clipboard.writeText(v)} className="text-xs px-2.5 py-1 bg-white border border-surface-border rounded-[8px] text-grey-15 font-mono hover:bg-brand-50">{v}</button>)}</div></div>
            </div>
            <div className="flex gap-3 mt-6"><button onClick={() => setShowEmailModal(false)} className="btn-secondary flex-1">Cancel</button><button onClick={saveEmail} disabled={emailSaving || !emailName.trim() || !emailSubject.trim() || !emailBody.trim()} className="btn-primary flex-1 disabled:opacity-50">{emailSaving ? 'Saving...' : editingEmail ? 'Save' : 'Create'}</button></div>
          </div>
        </div>
      )}

      {/* Ad Modal */}
      {showAdModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-white rounded-[12px] shadow-2xl p-8 w-full max-w-[640px] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-xl font-semibold text-grey-15 mb-6">{editingAd ? 'Edit Ad Template' : 'New Ad Template'}</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-grey-20 mb-1.5">Name</label><input type="text" value={adName} onChange={e => setAdName(e.target.value)} placeholder="e.g. Indeed Cleaner Ad" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" /></div>
                <div><label className="block text-sm font-medium text-grey-20 mb-1.5">Source</label><select value={adSource} onChange={e => setAdSource(e.target.value)} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500">{SOURCES.map(s => <option key={s} value={s} className="capitalize">{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}</select></div>
              </div>
              <div><label className="block text-sm font-medium text-grey-20 mb-1.5">Headline</label><input type="text" value={adHeadline} onChange={e => setAdHeadline(e.target.value)} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" /></div>
              <div><label className="block text-sm font-medium text-grey-20 mb-1.5">Body</label><textarea value={adBody} onChange={e => setAdBody(e.target.value)} rows={4} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-grey-20 mb-1.5">Requirements</label><textarea value={adRequirements} onChange={e => setAdRequirements(e.target.value)} rows={3} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" /></div>
                <div><label className="block text-sm font-medium text-grey-20 mb-1.5">Benefits</label><textarea value={adBenefits} onChange={e => setAdBenefits(e.target.value)} rows={3} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" /></div>
              </div>
              <div><label className="block text-sm font-medium text-grey-20 mb-1.5">Call to Action</label><input type="text" value={adCta} onChange={e => setAdCta(e.target.value)} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" /></div>
            </div>
            <div className="flex gap-3 mt-6"><button onClick={() => setShowAdModal(false)} className="btn-secondary flex-1">Cancel</button><button onClick={saveAd} disabled={adSaving || !adName.trim() || !adHeadline.trim() || !adBody.trim()} className="btn-primary flex-1 disabled:opacity-50">{adSaving ? 'Saving...' : editingAd ? 'Save' : 'Create'}</button></div>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
