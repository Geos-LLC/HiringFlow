'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import VideoRecorder from '@/components/VideoRecorder'
import CaptureRecorder from '@/components/CaptureRecorder'
import CaptionedVideo, { type CaptionStyle, DEFAULT_CAPTION_STYLE } from '@/components/CaptionedVideo'

interface CaptureStepConfig {
  mode: 'text' | 'audio' | 'video' | 'audio_video' | 'upload' | 'ai_call'
  prompt?: string | null
  required?: boolean
  maxDurationSec?: number | null
  minDurationSec?: number | null
  allowRetake?: boolean
  maxRetakes?: number | null
  transcriptionEnabled?: boolean
  aiAnalysisEnabled?: boolean
}

interface StepOption {
  optionId: string
  text: string
  nextStepId: string | null
}

interface Segment {
  start: number
  end: number
  text: string
}

interface FormField {
  id: string
  label: string
  type: string
  enabled: boolean
  required: boolean
  isBuiltIn?: boolean
  options?: string[]
}

interface CombinedStepData {
  stepId: string
  title: string
  videoUrl: string | null
  questionText: string | null
  stepType: string
  infoContent?: string | null
  questionType?: string
  captionsEnabled?: boolean
  segments?: Segment[]
  formEnabled?: boolean
  formConfig?: { fields: FormField[] } | null
  options: StepOption[]
}

interface TrainingStepData {
  id: string
  title: string
  slug: string
  description: string | null
  url: string
  completed: boolean
}

interface StepData {
  stepId: string
  title: string
  videoUrl: string | null
  questionText: string | null
  stepType: string
  infoContent?: string | null
  progress?: { current: number; total: number }
  stepIds?: string[]
  questionType: string
  captionsEnabled?: boolean
  captionStyle?: CaptionStyle | null
  segments?: Segment[]
  formEnabled?: boolean
  formConfig?: { fields: FormField[] } | null
  captureConfig?: CaptureStepConfig | null
  // Server-side composite gate: global env flag AND
  // workspace.settings.captureStepsEnabled. The candidate page never reads
  // env or workspace settings on the client; this boolean is the only signal.
  captureStepsEnabled?: boolean
  training?: TrainingStepData | null
  combinedStep?: CombinedStepData | null
  options: StepOption[]
  finished?: boolean
}

export default function SessionPlayerPage() {
  const params = useParams()
  const router = useRouter()
  const slug = params.slug as string
  const sessionId = params.sessionId as string

  const [step, setStep] = useState<StepData | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [videoEnded, setVideoEnded] = useState(false)
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [textMessage, setTextMessage] = useState('')
  const [textAnswer, setTextAnswer] = useState('')
  const [recordedVideo, setRecordedVideo] = useState<Blob | null>(null)
  const [isDesktop, setIsDesktop] = useState(true)

  // Detect desktop vs mobile to render only one video element
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    setIsDesktop(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Form state
  const [showForm, setShowForm] = useState(false)
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [formSubmitted, setFormSubmitted] = useState(false)

  useEffect(() => {
    fetchStep()
  }, [sessionId])

  // Poll for training completion while a training step is active. The
  // candidate opens the training in a new tab; when they finish it the
  // server writes TrainingEnrollment.completedAt. We refetch /step every
  // 5s so the client picks up completion and swaps the CTA to "Continue".
  // The user can also just click Continue themselves — the answer route
  // enforces the same gate.
  useEffect(() => {
    if (!step || step.stepType !== 'training') return
    if (step.training?.completed) return
    const interval = setInterval(() => {
      fetch(`/api/public/sessions/${sessionId}/step`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data && !data.finished && data.stepId === step.stepId && data.training?.completed) {
            setStep(data)
          }
        })
        .catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [step?.stepId, step?.stepType, step?.training?.completed, sessionId])

  const fetchStep = async () => {
    setLoading(true)
    setVideoEnded(false)
    setSelectedOptions([])
    setTextMessage('')
    setTextAnswer('')
    setRecordedVideo(null)
    setFormSubmitted(false)
    setFormValues({})
    const res = await fetch(`/api/public/sessions/${sessionId}/step`)
    if (res.ok) {
      const data = await res.json()
      if (data.finished) {
        router.push(`/f/${slug}/s/${sessionId}/done`)
      } else {
        setStep(data)
        // Show form for form steps or if form is enabled on other steps
        if ((data.stepType === 'form' || data.formEnabled) && data.formConfig?.fields?.some((f: FormField) => f.enabled)) {
          setShowForm(true)
        } else {
          setShowForm(false)
        }
      }
    }
    setLoading(false)
  }

  const handleVideoEnd = () => {
    setVideoEnded(true)
  }

  const handleFormSubmit = async () => {
    if (!step) return
    // Validate required fields
    const enabledFields = step.formConfig?.fields?.filter(f => f.enabled) || []
    const missingRequired = enabledFields.filter(f => f.required && !formValues[f.id]?.trim())
    if (missingRequired.length > 0) return

    setFormSubmitted(true)
    setShowForm(false)
    setSubmitting(true)

    // Submit form data to the API
    const res = await fetch(`/api/public/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepId: step.stepId, formData: formValues }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.finished) {
        router.push(`/f/${slug}/s/${sessionId}/done`)
      } else {
        fetchStep()
      }
    }
    setSubmitting(false)
  }

  const navigateToStep = async (stepId: string) => {
    // Jump to a specific step by setting lastStepId
    await fetch(`/api/public/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepId: step?.stepId, jumpTo: stepId }),
    })
    setVideoEnded(false)
    fetchStep()
  }

  const selectOption = async (option: StepOption) => {
    if (!step) return
    setSubmitting(true)
    const res = await fetch(`/api/public/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stepId: step.stepId,
        optionId: option.optionId,
        formData: formSubmitted ? formValues : undefined,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.finished) {
        router.push(`/f/${slug}/s/${sessionId}/done`)
      } else {
        fetchStep()
      }
    }
    setSubmitting(false)
  }

  const toggleOption = (optionId: string) => {
    setSelectedOptions((prev) =>
      prev.includes(optionId) ? prev.filter((id) => id !== optionId) : [...prev, optionId]
    )
  }

  const submitMultiselect = async () => {
    if (!step || selectedOptions.length === 0) return
    setSubmitting(true)
    const res = await fetch(`/api/public/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stepId: step.stepId,
        optionIds: selectedOptions,
        formData: formSubmitted ? formValues : undefined,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.finished) {
        router.push(`/f/${slug}/s/${sessionId}/done`)
      } else {
        fetchStep()
      }
    }
    setSubmitting(false)
  }

  const submitSubmission = async () => {
    if (!step || (!textMessage && !recordedVideo)) return
    setSubmitting(true)
    const formData = new FormData()
    formData.append('stepId', step.stepId)
    if (textMessage) formData.append('textMessage', textMessage)
    if (recordedVideo) formData.append('video', recordedVideo, 'recording.webm')
    if (formSubmitted) formData.append('formData', JSON.stringify(formValues))

    const res = await fetch(`/api/public/sessions/${sessionId}/submit`, {
      method: 'POST',
      body: formData,
    })
    if (res.ok) {
      router.push(`/f/${slug}/s/${sessionId}/done`)
    }
    setSubmitting(false)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#0f0e0c' }}>
        <div className="font-mono text-[11px] uppercase text-white/60" style={{ letterSpacing: '0.12em' }}>Loading…</div>
      </div>
    )
  }

  if (!step) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: '#0f0e0c' }}>
        <div className="text-center max-w-md">
          <div className="font-mono text-[11px] uppercase text-white/50 mb-2" style={{ letterSpacing: '0.12em' }}>
            Session not found
          </div>
          <h1 className="text-[22px] font-semibold text-white mb-2 tracking-tight2">This link has expired</h1>
          <p className="text-white/60 text-[14px]">Request a fresh invitation from the hiring team.</p>
        </div>
      </div>
    )
  }

  // Form screen — shown before video. Restyled to match the Classic StartCard
  // from the design handoff; behaviour unchanged.
  if (showForm && !formSubmitted) {
    const enabledFields = step.formConfig?.fields?.filter((f) => f.enabled) || []
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg)', fontFamily: 'var(--body-font)' }}>
        <div
          className="relative bg-white rounded-[20px] border border-surface-border p-10 w-full max-w-[520px]"
          style={{ boxShadow: 'var(--shadow-raised)' }}
        >
          <div className="flex items-center gap-2.5 mb-6">
            <div
              className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white font-bold text-[15px]"
              style={{ background: 'var(--brand-primary)', boxShadow: 'var(--shadow-brand)' }}
            >
              h
            </div>
            <span className="font-semibold text-[15px] text-ink tracking-[-0.01em]">HireFunnel</span>
          </div>

          <div className="font-mono text-[11px] uppercase text-grey-35 mb-2" style={{ letterSpacing: '0.12em' }}>
            Before we begin
          </div>
          <h2 className="text-[26px] font-semibold text-ink mb-1.5 tracking-tight2">{step.title}</h2>
          <p className="text-[14px] text-grey-35 mb-6">We&apos;ll use these details to follow up about your application.</p>

          <div className="space-y-4">
            {enabledFields.map((field) => (
              <div key={field.id}>
                <label className="eyebrow block mb-1.5">
                  {field.label}
                  {field.required && <span style={{ color: 'var(--brand-primary)' }} className="ml-1">*</span>}
                </label>
                {field.type === 'textarea' ? (
                  <textarea
                    value={formValues[field.id] || ''}
                    onChange={(e) => setFormValues({ ...formValues, [field.id]: e.target.value })}
                    rows={3}
                    className="w-full px-3 py-2.5 border border-surface-border rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-[color:var(--brand-primary)] text-ink text-[14px]"
                    placeholder={field.label}
                  />
                ) : field.type === 'radio' && field.options ? (
                  <div className="space-y-2">
                    {field.options.map((opt, j) => (
                      <label
                        key={j}
                        className={`flex items-center w-full px-3 py-2.5 rounded-[10px] border cursor-pointer transition-all ${
                          formValues[field.id] === opt
                            ? 'border-[color:var(--brand-primary)] bg-brand-50'
                            : 'border-surface-border bg-white hover:border-grey-50'
                        }`}
                      >
                        <input type="radio" name={field.id} value={opt} checked={formValues[field.id] === opt} onChange={(e) => setFormValues({ ...formValues, [field.id]: e.target.value })} className="mr-2.5 accent-[#FF9500]" />
                        <span className="text-[14px] text-ink">{opt}</span>
                      </label>
                    ))}
                  </div>
                ) : field.type === 'multiselect' && field.options ? (
                  <div className="space-y-2">
                    {field.options.map((opt, j) => {
                      const selected = (formValues[field.id] || '').split(',').filter(Boolean)
                      const isChecked = selected.includes(opt)
                      return (
                        <label
                          key={j}
                          className={`flex items-center w-full px-3 py-2.5 rounded-[10px] border cursor-pointer transition-all ${
                            isChecked
                              ? 'border-[color:var(--brand-primary)] bg-brand-50'
                              : 'border-surface-border bg-white hover:border-grey-50'
                          }`}
                        >
                          <input type="checkbox" checked={isChecked} onChange={() => {
                            const next = isChecked ? selected.filter((s) => s !== opt) : [...selected, opt]
                            setFormValues({ ...formValues, [field.id]: next.join(',') })
                          }} className="mr-2.5 accent-[#FF9500]" />
                          <span className="text-[14px] text-ink">{opt}</span>
                        </label>
                      )
                    })}
                  </div>
                ) : field.type === 'button' && field.options ? (
                  <div className="flex flex-wrap gap-2">
                    {field.options.map((opt, j) => (
                      <button
                        key={j}
                        type="button"
                        onClick={() => setFormValues({ ...formValues, [field.id]: opt })}
                        className={`px-4 py-2 rounded-[10px] border text-[13px] font-medium transition-all ${
                          formValues[field.id] === opt
                            ? 'text-white border-[color:var(--brand-primary)]'
                            : 'border-surface-border text-ink bg-white hover:border-grey-50'
                        }`}
                        style={formValues[field.id] === opt ? { background: 'var(--brand-primary)' } : undefined}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                ) : (
                  <input
                    type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'}
                    value={formValues[field.id] || ''}
                    onChange={(e) => setFormValues({ ...formValues, [field.id]: e.target.value })}
                    className="w-full px-3 py-2.5 border border-surface-border rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-[color:var(--brand-primary)] text-ink text-[14px]"
                    placeholder={field.label}
                  />
                )}
              </div>
            ))}
          </div>

          <button
            onClick={handleFormSubmit}
            className="w-full mt-6 py-3 rounded-[10px] text-white font-semibold text-[14px] transition-colors hover:opacity-90"
            style={{ background: 'var(--brand-primary)' }}
          >
            Continue
          </button>
        </div>
      </div>
    )
  }

  const showOptions = !step.videoUrl || videoEnded

  // Question/options rendering (shared between mobile overlay and desktop sidebar)
  const renderQuestionContent = (overlay = false) => {
    const containerClass = overlay
      ? 'absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/70 to-transparent p-6 pt-16'
      : ''
    const textColorClass = overlay ? 'text-white' : 'text-gray-900'
    const optionBorderClass = overlay
      ? 'border-white/30 hover:border-white/60 hover:bg-white/10 text-white'
      : 'border-gray-200 hover:border-brand-500 hover:bg-brand-50 text-gray-900'
    const optionSelectedClass = overlay
      ? 'border-brand-400 bg-brand-500/30 text-white'
      : 'border-brand-500 bg-brand-50 text-gray-900'
    const disabledClass = overlay
      ? 'border-white/10 bg-white/5 text-white/40 cursor-not-allowed'
      : 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed'

    return (
      <div className={containerClass}>
        {step.questionText && (
          <h2 className={`text-lg font-semibold ${textColorClass} ${overlay ? 'text-left' : 'text-center'} mb-4`}>
            {step.questionText}
          </h2>
        )}

        {(step.stepType || 'question') === 'question' && (
          <div className={overlay ? '' : 'max-w-md mx-auto'}>
            {/* Single/Button */}
            {((step.questionType || 'single') === 'single' || step.questionType === 'button') && (
              <div className="space-y-2.5">
                {step.options.map((option) => (
                  <button
                    key={option.optionId}
                    onClick={() => selectOption(option)}
                    disabled={submitting || (!showOptions && step.videoUrl !== null)}
                    className={`w-full py-3 px-5 rounded-xl border-2 transition-all ${
                      step.questionType === 'button' ? 'text-center' : 'text-left'
                    } ${
                      showOptions || !step.videoUrl ? optionBorderClass : disabledClass
                    } ${submitting ? 'opacity-50' : ''}`}
                  >
                    <span className="font-medium text-sm">{option.text}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Multiselect */}
            {step.questionType === 'multiselect' && (
              <>
                <div className="space-y-2.5 mb-4">
                  {step.options.map((option) => (
                    <label
                      key={option.optionId}
                      className={`flex items-center w-full py-3 px-5 rounded-xl border-2 cursor-pointer transition-all ${
                        selectedOptions.includes(option.optionId)
                          ? optionSelectedClass
                          : optionBorderClass
                      } ${!showOptions && step.videoUrl ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedOptions.includes(option.optionId)}
                        onChange={() => toggleOption(option.optionId)}
                        disabled={!showOptions && !!step.videoUrl}
                        className="mr-3 h-4 w-4 text-brand-500 rounded"
                      />
                      <span className="font-medium text-sm">{option.text}</span>
                    </label>
                  ))}
                </div>
                <button
                  onClick={submitMultiselect}
                  disabled={selectedOptions.length === 0 || submitting || (!showOptions && !!step.videoUrl)}
                  className="w-full py-3 bg-brand-500 text-white rounded-xl font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-600 transition-colors"
                >
                  {submitting ? 'Submitting...' : `Continue (${selectedOptions.length} selected)`}
                </button>
              </>
            )}
          </div>
        )}

        {/* Capture step — graceful unavailable state when the composite
            feature gate is off (either global env or workspace opt-in).
            The candidate sees a clear message instead of a broken recorder.
            Recording finalize + recruiter playback are intentionally NOT
            gated (in-flight uploads complete; prior recordings stay
            playable). */}
        {step.stepType === 'capture' && !step.captureStepsEnabled && (
          <div className={`${overlay ? '' : 'max-w-md mx-auto'} rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800`}>
            This recording step is temporarily unavailable. Please contact the hiring team if you need to continue.
          </div>
        )}

        {/* Capture step — generic Capture Engine (Phase 1B ships audio mode) */}
        {step.stepType === 'capture' && step.captureStepsEnabled && step.captureConfig && step.captureConfig.mode === 'audio' && (
          <div className={overlay ? '' : 'max-w-md mx-auto'}>
            <CaptureRecorder
              sessionId={sessionId}
              stepId={step.stepId}
              mode="audio"
              prompt={step.captureConfig.prompt ?? step.questionText ?? null}
              allowRetake={step.captureConfig.allowRetake ?? true}
              maxRetakes={step.captureConfig.maxRetakes ?? null}
              maxDurationSec={step.captureConfig.maxDurationSec ?? null}
              minDurationSec={step.captureConfig.minDurationSec ?? null}
              onSubmitted={async () => {
                // After the recorder finalizes the upload, advance the flow
                // the same way info/submission steps do — POST /answer to
                // register completion and either finish or load the next step.
                setSubmitting(true)
                const res = await fetch(`/api/public/sessions/${sessionId}/answer`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ stepId: step.stepId }),
                })
                if (res.ok) {
                  const data = await res.json()
                  if (data.finished) router.push(`/f/${slug}/s/${sessionId}/done`)
                  else fetchStep()
                }
                setSubmitting(false)
              }}
            />
          </div>
        )}

        {/* Capture step — non-audio modes not yet implemented in the UI */}
        {step.stepType === 'capture' && step.captureStepsEnabled && step.captureConfig && step.captureConfig.mode !== 'audio' && (
          <div className={`${overlay ? '' : 'max-w-md mx-auto'} rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800`}>
            This step is configured for a capture mode that isn't available yet. Please contact the hiring team.
          </div>
        )}

        {/* Submission — Continue button */}
        {step.stepType === 'submission' && (
          <div className={`space-y-4 ${overlay ? '' : 'max-w-md mx-auto'}`}>
            <button
              onClick={async () => {
                setSubmitting(true)
                const res = await fetch(`/api/public/sessions/${sessionId}/answer`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ stepId: step.stepId }),
                })
                if (res.ok) { const data = await res.json(); if (data.finished) router.push(`/f/${slug}/s/${sessionId}/done`); else fetchStep() }
                setSubmitting(false)
              }}
              disabled={submitting || (!showOptions && !!step.videoUrl)}
              className={`w-full py-3.5 px-5 rounded-xl border-2 text-center font-semibold transition-all ${
                showOptions || !step.videoUrl
                  ? overlay ? 'border-white/40 hover:bg-white/10 text-white' : 'border-brand-500 bg-brand-50 text-brand-700 hover:bg-brand-100'
                  : 'opacity-40 cursor-not-allowed border-gray-200 text-gray-400'
              }`}
            >
              {submitting ? 'Continuing...' : 'Continue'}
            </button>
          </div>
        )}

        {/* Training Step — candidate must finish the linked training in a
            separate tab. Continue is disabled until the enrollment is
            marked complete server-side; the effect above polls /step so
            the button flips to enabled without a manual refresh. */}
        {step.stepType === 'training' && (
          <div className={overlay ? '' : 'max-w-md mx-auto'}>
            {step.training ? (
              <div className="space-y-4">
                <div className={`rounded-xl border p-4 ${overlay ? 'border-white/30 bg-white/5' : 'border-surface-border bg-white'}`}>
                  <div className={`text-sm font-semibold mb-1 ${textColorClass}`}>{step.training.title}</div>
                  {step.training.description && (
                    <p className={`text-xs ${overlay ? 'text-white/70' : 'text-grey-40'} whitespace-pre-wrap`}>
                      {step.training.description}
                    </p>
                  )}
                </div>
                <a
                  href={step.training.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`block w-full py-3 rounded-xl text-center font-medium text-sm transition-all ${
                    overlay
                      ? 'border-2 border-white/40 hover:bg-white/10 text-white'
                      : 'border-2 border-brand-500 bg-brand-50 text-brand-700 hover:bg-brand-100'
                  }`}
                >
                  {step.training.completed ? 'Review training' : 'Open training'}
                </a>
                <button
                  onClick={async () => {
                    setSubmitting(true)
                    const res = await fetch(`/api/public/sessions/${sessionId}/answer`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ stepId: step.stepId }),
                    })
                    if (res.ok) {
                      const data = await res.json()
                      if (data.finished) router.push(`/f/${slug}/s/${sessionId}/done`)
                      else fetchStep()
                    }
                    setSubmitting(false)
                  }}
                  disabled={submitting || !step.training.completed}
                  className="w-full py-3 bg-brand-500 text-white rounded-xl font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-600 transition-colors"
                >
                  {submitting
                    ? 'Loading...'
                    : step.training.completed
                    ? 'Continue'
                    : 'Finish training to continue'}
                </button>
                {!step.training.completed && (
                  <p className={`text-xs text-center ${overlay ? 'text-white/50' : 'text-grey-40'}`}>
                    We&apos;ll unlock the Continue button as soon as you finish the training.
                  </p>
                )}
              </div>
            ) : (
              <div className={`rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800`}>
                This training step isn&apos;t configured yet. Please contact the hiring team.
              </div>
            )}
          </div>
        )}

        {/* Info Step */}
        {step.stepType === 'info' && (
          <div className={overlay ? '' : 'max-w-md mx-auto'}>
            {step.infoContent && (
              <p className={`text-sm ${textColorClass} mb-4 whitespace-pre-wrap`}>{step.infoContent}</p>
            )}
            <button
              onClick={async () => {
                setSubmitting(true)
                const res = await fetch(`/api/public/sessions/${sessionId}/answer`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ stepId: step.stepId }),
                })
                if (res.ok) {
                  const data = await res.json()
                  if (data.finished) router.push(`/f/${slug}/s/${sessionId}/done`)
                  else fetchStep()
                }
                setSubmitting(false)
              }}
              disabled={submitting}
              className="w-full py-3 bg-brand-500 text-white rounded-xl font-medium text-sm disabled:opacity-50 hover:bg-brand-600 transition-colors"
            >
              {submitting ? 'Loading...' : 'Continue'}
            </button>
          </div>
        )}

        {/* Text Answer Question */}
        {(step.stepType || 'question') === 'question' && step.questionType === 'text' && (
          <div className={overlay ? '' : 'max-w-md mx-auto'}>
            <textarea
              value={textAnswer}
              onChange={(e) => setTextAnswer(e.target.value)}
              rows={4}
              placeholder="Type your answer..."
              className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500 mb-3"
            />
            <button
              onClick={async () => {
                if (!textAnswer.trim()) return
                setSubmitting(true)
                const res = await fetch(`/api/public/sessions/${sessionId}/answer`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ stepId: step.stepId, textAnswer }),
                })
                if (res.ok) {
                  const data = await res.json()
                  if (data.finished) router.push(`/f/${slug}/s/${sessionId}/done`)
                  else fetchStep()
                }
                setSubmitting(false)
              }}
              disabled={!textAnswer.trim() || submitting}
              className="w-full py-3 bg-brand-500 text-white rounded-xl font-medium text-sm disabled:opacity-50 hover:bg-brand-600 transition-colors"
            >
              {submitting ? 'Submitting...' : 'Submit Answer'}
            </button>
          </div>
        )}

        {!showOptions && step.videoUrl && (step.stepType || 'question') === 'question' && step.questionType !== 'text' && (
          <p className={`text-center text-sm ${overlay ? 'text-white/50' : 'text-gray-500'} mt-3`}>
            Watch the video to unlock options
          </p>
        )}

        {/* Progress bar — clickable */}
        {step.progress && (
          <div className="mt-4">
            <div className="flex gap-1">
              {Array.from({ length: step.progress.total }).map((_, i) => (
                <button
                  key={i}
                  onClick={() => {
                    if (step.stepIds && step.stepIds[i] && step.stepIds[i] !== step.stepId) {
                      navigateToStep(step.stepIds[i])
                    }
                  }}
                  className={`flex-1 h-2 rounded-full transition-colors cursor-pointer hover:opacity-80 ${i < step.progress!.current ? 'bg-brand-500' : 'bg-gray-200 hover:bg-gray-300'}`}
                />
              ))}
            </div>
            <p className={`text-center text-xs mt-1 ${overlay ? 'text-white/40' : 'text-gray-400'}`}>
              Step {step.progress.current} of {step.progress.total}
            </p>
          </div>
        )}
      </div>
    )
  }

  // Design variant selection. Classic is the default Hirefunnel Candidate Flow
  // layout — warm off-white, video left, question sidebar right. Cinema and
  // Paper variants from the design handoff remain deferred behind the flag
  // NEXT_PUBLIC_CANDIDATE_FLOW_VARIANT (values: 'cinema' | 'paper'). Set nothing
  // or 'classic' to render the default.
  // const variant = process.env.NEXT_PUBLIC_CANDIDATE_FLOW_VARIANT ?? 'classic'

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)', fontFamily: 'var(--body-font)' }}>
      {/* Classic header — wordmark + company pill + progress + restart. Purely
          presentational; no behavior change. */}
      <header className="w-full px-5 pt-5 pb-4">
        <div className="max-w-[1280px] mx-auto flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white font-bold text-[16px]"
              style={{ background: 'var(--brand-primary)', boxShadow: 'var(--shadow-brand)' }}
            >
              h
            </div>
            <span className="font-semibold text-[15px] text-ink tracking-[-0.01em]">HireFunnel</span>
          </div>
          {step?.progress && (
            <div className="flex-1 min-w-[180px] max-w-[320px]">
              <div className="flex gap-1">
                {Array.from({ length: step.progress.total }).map((_, i) => (
                  <button
                    key={i}
                    onClick={() => { if (step.stepIds?.[i] && step.stepIds[i] !== step.stepId) navigateToStep(step.stepIds[i]) }}
                    className="flex-1 h-1.5 rounded-full transition-colors cursor-pointer hover:opacity-80"
                    style={{
                      background: i < step.progress!.current ? 'var(--brand-primary)' : 'var(--weak-track)',
                    }}
                  />
                ))}
              </div>
              <div className="font-mono text-[10px] uppercase text-grey-35 text-center mt-1.5" style={{ letterSpacing: '0.12em' }}>
                Step {step.progress.current} of {step.progress.total}
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Desktop: side-by-side */}
      {isDesktop && (
      <div className="flex flex-1 max-w-[1280px] w-full mx-auto px-5 pb-10 gap-4">
        {/* Left: Video — warm card wrapper per Classic variant */}
        <div
          className="flex-1 flex items-center justify-center overflow-hidden rounded-[20px] border border-surface-border relative"
          style={{ background: '#0f0e0c', boxShadow: 'var(--shadow-card)' }}
        >
          {(() => {
            const videoUrl = step.videoUrl || step.combinedStep?.videoUrl
            const videoSegments = step.videoUrl ? step.segments : step.combinedStep?.segments
            const videoCaptionsEnabled = step.videoUrl ? step.captionsEnabled : step.combinedStep?.captionsEnabled
            if (videoUrl) {
              return (
                <div className="w-full h-full flex items-center justify-center">
                  <CaptionedVideo
                    key={`desktop-${step.stepId}`}
                    src={videoUrl}
                    segments={videoSegments || []}
                    captionsEnabled={videoCaptionsEnabled || false}
                    captionStyle={(step.captionStyle as CaptionStyle) || DEFAULT_CAPTION_STYLE}
                    autoPlay
                    onEnded={handleVideoEnd}
                    className="rounded-[20px]"
                    videoClassName="max-h-[calc(100vh-120px)] w-auto max-w-full"
                  />
                </div>
              )
            }
            return (
              <div className="text-white/90 text-center px-8">
                <div className="font-mono text-[10px] uppercase text-white/50 mb-2" style={{ letterSpacing: '0.14em' }}>Question</div>
                <h2 className="text-[22px] font-semibold tracking-tight2">{step.title}</h2>
              </div>
            )
          })()}
        </div>

        {/* Right: Questions — warm sidebar card per Classic variant */}
        <div
          className="w-[420px] shrink-0 bg-white rounded-[20px] border border-surface-border flex flex-col justify-center p-8 overflow-y-auto"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          {(() => {
            const cs = step.combinedStep
            const questionStep = cs && (cs.stepType === 'question' || cs.options.length > 0) ? cs : null
            const displayTitle = questionStep ? cs!.title : step.title
            const displayQuestion = questionStep ? cs!.questionText : step.questionText

            const submitCombinedOption = async (opt: StepOption) => {
              if (!step) return
              setSubmitting(true)
              const res = await fetch(`/api/public/sessions/${sessionId}/answer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stepId: cs!.stepId, optionId: opt.optionId }),
              })
              if (res.ok) {
                const data = await res.json()
                if (data.finished) router.push(`/f/${slug}/s/${sessionId}/done`)
                else fetchStep()
              }
              setSubmitting(false)
            }

            return (
              <>
                {displayTitle && (
                  <div className="font-mono text-[11px] uppercase text-grey-35 mb-3" style={{ letterSpacing: '0.12em' }}>
                    {displayTitle}
                  </div>
                )}
                {questionStep && displayQuestion && (
                  <h3 className="text-[22px] font-semibold text-ink mb-5 leading-tight tracking-tight2">{displayQuestion}</h3>
                )}
                {questionStep ? (
                  <div className="space-y-2">
                    {questionStep.options.map((opt) => {
                      const locked = !videoEnded && !!(step.videoUrl || cs?.videoUrl)
                      return (
                        <button
                          key={opt.optionId}
                          onClick={() => submitCombinedOption(opt)}
                          disabled={submitting || locked}
                          className={`w-full py-3 px-4 rounded-[10px] border text-left text-ink font-medium text-[14px] transition-all ${
                            locked
                              ? 'opacity-40 cursor-not-allowed border-surface-border bg-white'
                              : 'border-surface-border bg-white hover:border-[color:var(--brand-primary)] hover:bg-brand-50'
                          } ${submitting ? 'opacity-50' : ''}`}
                        >
                          {opt.text}
                        </button>
                      )
                    })}
                    {!videoEnded && (step.videoUrl || cs?.videoUrl) && (
                      <p className="text-center font-mono text-[10px] uppercase text-grey-50 mt-3" style={{ letterSpacing: '0.12em' }}>
                        Watch the video to unlock
                      </p>
                    )}
                  </div>
                ) : (
                  renderQuestionContent(false)
                )}
              </>
            )
          })()}
        </div>
      </div>
      )}

      {/* Mobile: video with overlay questions */}
      {!isDesktop && (
      <div className="flex flex-col min-h-screen">
        <div className="flex-1 relative flex items-center justify-center">
          {step.videoUrl ? (
            <div className="w-full h-full">
              <CaptionedVideo
                key={`mobile-${step.stepId}`}
                src={step.videoUrl}
                segments={step.segments || []}
                captionsEnabled={step.captionsEnabled || false}
                captionStyle={(step.captionStyle as CaptionStyle) || DEFAULT_CAPTION_STYLE}
                autoPlay
                onEnded={handleVideoEnd}
                className="w-full h-full object-cover"
              />
              {/* Overlay questions on mobile */}
              {renderQuestionContent(true)}
            </div>
          ) : (
            <div className="text-white text-center p-6">
              <h2 className="text-2xl font-semibold mb-6">{step.title}</h2>
              <div className="bg-white rounded-2xl p-6">
                {renderQuestionContent(false)}
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
