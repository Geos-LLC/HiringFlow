/**
 * Public flow landing page. First screen a candidate sees after clicking a
 * tracked link. Refreshed to match Design/design_handoff_hirefunnel tokens —
 * warm background, subtle card, mono eyebrow, editorial copy.
 */

'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Button, Eyebrow } from '@/components/design'
import { validateEmail, validatePhone } from '@/lib/contact-validation'

interface StartScreenConfig {
  showNameField?: boolean
  showEmailField?: boolean
  showPhoneField?: boolean
  buttonText?: string
  nameRequired?: boolean
  emailRequired?: boolean
}

interface FlowInfo {
  id: string
  name: string
  slug: string
  startMessage: string
  endMessage: string
  branding: { startScreenConfig?: StartScreenConfig; startScreenImage?: string } | null
  startStepId: string | null
}

export default function FlowStartPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const slug = params.slug as string
  const isPreview = searchParams.get('preview') === 'true'

  const [flow, setFlow] = useState<FlowInfo | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  // Inline validation errors. Set on blur so we don't yell at someone
  // mid-typing; cleared as soon as they edit again.
  const [emailError, setEmailError] = useState<string | null>(null)
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchFlow() }, [slug])

  const fetchFlow = async () => {
    const res = await fetch(`/api/public/flows/${slug}${isPreview ? '?preview=true' : ''}`)
    if (res.ok) setFlow(await res.json())
    else setError('Flow not found or not available')
    setLoading(false)
  }

  const handleStart = async () => {
    if (!flow) return
    // Re-validate at submit time. Email/phone fields are optional unless
    // the workspace's startScreenConfig marks them required, but if
    // *any* value is provided it must be well-formed — sending email or
    // SMS to a malformed address bounces and silently strands the
    // candidate (the Daphney "@gmail.comd" / "@yahoo,com" pattern).
    let normalizedEmail: string | null = null
    let normalizedPhone: string | null = null
    if (email.trim() || (showEmail && cfg.emailRequired)) {
      const r = validateEmail(email)
      if (!r.ok) { setEmailError(r.error); return }
      normalizedEmail = r.value
    }
    if (phone.trim()) {
      const r = validatePhone(phone)
      if (!r.ok) { setPhoneError(r.error); return }
      normalizedPhone = r.value
    }
    setStarting(true)
    const res = await fetch('/api/public/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flowSlug: slug,
        candidateName: name || null,
        candidateEmail: normalizedEmail,
        candidatePhone: normalizedPhone,
        preview: isPreview || undefined,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      // Carry the preview flag onto the session URL so downstream
      // surfaces (embedded TrainingViewer, etc.) can loosen candidate-
      // facing lockdowns (video seek/scrub, etc.) for the recruiter.
      // Preview mode isn't stored on Session, so the URL is the only
      // carrier through the redirect.
      router.replace(`/f/${slug}/s/${data.id}${isPreview ? '?preview=1' : ''}`)
    } else {
      const body = await res.json().catch(() => null)
      setError(body?.error || 'Failed to start session')
      setStarting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>Loading…</div>
      </div>
    )
  }

  if (error || !flow) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--bg)' }}>
        <div className="text-center max-w-md">
          <Eyebrow size="sm" className="mb-2">Not available</Eyebrow>
          <h1 className="text-[22px] font-semibold text-ink mb-1.5 tracking-tight2">This link isn&apos;t active</h1>
          <p className="text-grey-35 text-[14px]">{error || 'The link may have expired or the flow is not yet published.'}</p>
        </div>
      </div>
    )
  }

  if (!flow.startStepId) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--bg)' }}>
        <div className="text-center max-w-md">
          <Eyebrow size="sm" className="mb-2">Coming soon</Eyebrow>
          <h1 className="text-[22px] font-semibold text-ink mb-1.5 tracking-tight2">{flow.name}</h1>
          <p className="text-grey-35 text-[14px]">This flow has no steps yet.</p>
        </div>
      </div>
    )
  }

  const cfg = flow.branding?.startScreenConfig || {} as StartScreenConfig
  const showName = cfg.showNameField ?? true
  const showEmail = cfg.showEmailField ?? false
  const showPhone = cfg.showPhoneField ?? false
  const btnText = cfg.buttonText || 'Start application'
  const bgImage = flow.branding?.startScreenImage
  const hasFields = showName || showEmail || showPhone
  const canStart =
    (!showName || !cfg.nameRequired || name.trim())
    && (!showEmail || !cfg.emailRequired || email.trim())
    && !emailError
    && !phoneError

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative"
      style={{
        background: bgImage
          ? `url(${bgImage}) center/cover`
          : 'var(--bg)',
      }}
    >
      {!bgImage && (
        <div
          className="absolute inset-0 opacity-[0.6] pointer-events-none"
          style={{
            background: `
              radial-gradient(ellipse at top left, rgba(255,149,0,0.12), transparent 60%),
              radial-gradient(ellipse at bottom right, rgba(255,149,0,0.08), transparent 55%),
              repeating-linear-gradient(135deg, rgba(26,24,21,0.03) 0 1px, transparent 1px 32px)`,
          }}
        />
      )}

      {isPreview && (
        <div
          className="fixed top-0 left-0 right-0 text-center py-1.5 font-mono text-[10px] uppercase z-50"
          style={{ background: 'var(--warn-bg)', color: 'var(--warn-fg)', letterSpacing: '0.12em' }}
        >
          Preview mode — this flow is not published
        </div>
      )}

      <div
        className="relative bg-white rounded-[14px] border border-surface-border p-10 max-w-[480px] w-full"
        style={{ boxShadow: 'var(--shadow-raised)' }}
      >
        <div className="flex items-center gap-2.5 mb-8">
          <div
            className="w-9 h-9 rounded-[10px] flex items-center justify-center text-white font-bold text-[17px]"
            style={{ background: 'var(--brand-primary)', boxShadow: 'var(--shadow-brand)' }}
          >
            h
          </div>
          <span className="font-semibold text-[15px] text-ink tracking-[-0.01em]">HireFunnel</span>
        </div>

        <Eyebrow size="sm" className="mb-2">You&apos;re applying to</Eyebrow>
        <h1 className="text-[28px] font-semibold text-ink mb-3 tracking-tight2 leading-[1.15]">{flow.name}</h1>

        {flow.startMessage && (
          <p className="text-grey-35 text-[14px] mb-7 leading-relaxed">{flow.startMessage}</p>
        )}

        {hasFields && (
          <div className="space-y-3.5 mb-6">
            {showName && (
              <div>
                <label className="eyebrow block mb-1.5">
                  Name {cfg.nameRequired && <span style={{ color: 'var(--brand-primary)' }}>*</span>}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  className="w-full px-3 py-2.5 border border-surface-border rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-[color:var(--brand-primary)] text-ink text-[14px]"
                />
              </div>
            )}
            {showEmail && (
              <div>
                <label className="eyebrow block mb-1.5">
                  Email {cfg.emailRequired && <span style={{ color: 'var(--brand-primary)' }}>*</span>}
                </label>
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); if (emailError) setEmailError(null) }}
                  onBlur={() => {
                    if (!email.trim()) { setEmailError(null); return }
                    const r = validateEmail(email)
                    setEmailError(r.ok ? null : r.error)
                  }}
                  placeholder="your@email.com"
                  aria-invalid={!!emailError}
                  className={`w-full px-3 py-2.5 border rounded-[10px] focus:outline-none focus:ring-2 text-ink text-[14px] ${emailError ? 'border-[color:var(--danger-fg)] focus:ring-[color:var(--danger-fg)]/30 focus:border-[color:var(--danger-fg)]' : 'border-surface-border focus:ring-brand-500/40 focus:border-[color:var(--brand-primary)]'}`}
                />
                {emailError && <p className="mt-1 text-[12px]" style={{ color: 'var(--danger-fg)' }}>{emailError}</p>}
              </div>
            )}
            {showPhone && (
              <div>
                <label className="eyebrow block mb-1.5">Phone</label>
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => { setPhone(e.target.value); if (phoneError) setPhoneError(null) }}
                  onBlur={() => {
                    if (!phone.trim()) { setPhoneError(null); return }
                    const r = validatePhone(phone)
                    setPhoneError(r.ok ? null : r.error)
                  }}
                  placeholder="+1 (555) 123-4567"
                  aria-invalid={!!phoneError}
                  className={`w-full px-3 py-2.5 border rounded-[10px] focus:outline-none focus:ring-2 text-ink text-[14px] ${phoneError ? 'border-[color:var(--danger-fg)] focus:ring-[color:var(--danger-fg)]/30 focus:border-[color:var(--danger-fg)]' : 'border-surface-border focus:ring-brand-500/40 focus:border-[color:var(--brand-primary)]'}`}
                />
                {phoneError && <p className="mt-1 text-[12px]" style={{ color: 'var(--danger-fg)' }}>{phoneError}</p>}
              </div>
            )}
          </div>
        )}

        <Button
          onClick={handleStart}
          disabled={starting || !canStart}
          className="w-full !py-3.5 !text-[14px]"
        >
          {starting ? 'Starting…' : btnText}
        </Button>

        <div className="mt-6 pt-5 border-t border-surface-divider font-mono text-[10px] uppercase text-grey-50 text-center" style={{ letterSpacing: '0.12em' }}>
          Takes about 5 minutes
        </div>
      </div>
    </div>
  )
}
