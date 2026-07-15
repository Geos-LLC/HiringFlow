'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { triggerVideoAnalysis } from '@/lib/upload-client'
import { useUploads } from '@/app/dashboard/_components/UploadProvider'
import CaptionedVideo, { type CaptionStyle, DEFAULT_CAPTION_STYLE } from './CaptionedVideo'
import VideoRecorderModal from './VideoRecorderModal'
import { VideoPickerModal } from './VideoPickerModal'

// Debounced input that keeps cursor position stable
function DebouncedInput({
  value: externalValue,
  onChange,
  delay = 500,
  ...props
}: {
  value: string
  onChange: (value: string) => void
  delay?: number
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  const [localValue, setLocalValue] = useState(externalValue)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)

  // Sync from parent only when not actively typing
  useEffect(() => {
    if (!isTypingRef.current) {
      setLocalValue(externalValue)
    }
  }, [externalValue])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setLocalValue(val)
    isTypingRef.current = true
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      onChange(val)
      isTypingRef.current = false
    }, delay)
  }

  useEffect(() => {
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current) }
  }, [])

  return <input {...props} value={localValue} onChange={handleChange} />
}

function DebouncedTextarea({
  value: externalValue,
  onChange,
  delay = 500,
  ...props
}: {
  value: string
  onChange: (value: string) => void
  delay?: number
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'>) {
  const [localValue, setLocalValue] = useState(externalValue)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)

  useEffect(() => {
    if (!isTypingRef.current) {
      setLocalValue(externalValue)
    }
  }, [externalValue])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setLocalValue(val)
    isTypingRef.current = true
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      onChange(val)
      isTypingRef.current = false
    }, delay)
  }

  useEffect(() => {
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current) }
  }, [])

  return <textarea {...props} value={localValue} onChange={handleChange} />
}

interface Segment {
  start: number
  end: number
  text: string
}

interface Video {
  id: string
  filename: string
  url: string
  displayName?: string | null
  summary?: string | null
  bulletPoints?: string[]
  transcript?: string | null
  segments?: Segment[] | null
  // Same extended fields the flow-builder VideoPickerModal renders.
  kind?: string
  durationSeconds?: number | null
  posterUrl?: string | null
}

interface Option {
  id: string
  optionText: string
  nextStepId: string | null
}

interface FormField {
  id: string
  label: string
  type: 'text' | 'email' | 'phone' | 'textarea'
  required: boolean
  enabled: boolean
  isBuiltIn?: boolean
}

interface FormConfig {
  fields: FormField[]
}

interface Step {
  id: string
  title: string
  videoId: string | null
  video: Video | null
  questionText: string | null
  stepOrder: number
  stepType: string
  questionType: string
  formEnabled?: boolean
  formConfig?: FormConfig | null
  infoContent?: string | null
  captionsEnabled?: boolean
  captionStyle?: CaptionStyle | null
  trainingId?: string | null
  schedulingConfigId?: string | null
  options: Option[]
}

interface Training {
  id: string
  title: string
  slug: string
  isPublished: boolean
}

interface SchedulingConfigLite {
  id: string
  name: string
  isActive: boolean
  isDefault: boolean
  useBuiltInScheduler: boolean
}

const DEFAULT_FORM_CONFIG: FormConfig = {
  fields: [
    { id: 'name', label: 'Full Name', type: 'text', required: true, enabled: true, isBuiltIn: true },
    { id: 'email', label: 'Email', type: 'email', required: true, enabled: true, isBuiltIn: true },
    { id: 'phone', label: 'Phone', type: 'phone', required: false, enabled: false, isBuiltIn: true },
  ],
}

interface StepEditorPanelProps {
  step: Step
  allSteps: Step[]
  videos: Video[]
  hideVideo?: boolean
  onUpdateStep: (stepId: string, data: Partial<Step>) => void
  onDeleteStep: (stepId: string) => void
  onAddOption: (stepId: string) => void
  onUpdateOption: (optionId: string, data: { optionText?: string; nextStepId?: string | null }) => void
  onDeleteOption: (stepId: string, optionId: string) => void
  onVideoUploaded?: (video: Video) => void
  onClose?: () => void
}

export default function StepEditorPanel({
  step,
  allSteps,
  videos,
  hideVideo,
  onUpdateStep,
  onDeleteStep,
  onAddOption,
  onUpdateOption,
  onDeleteOption,
  onVideoUploaded,
  onClose,
}: StepEditorPanelProps) {
  const { startUpload } = useUploads()
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [transcribing, setTranscribing] = useState(false)
  const [transcript, setTranscript] = useState<{ text: string; segments: Array<{ start: number; end: number; text: string }> } | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestion, setSuggestion] = useState<{ question: string; options: Array<{ text: string; isEndFlow: boolean }> } | null>(null)
  const [activeTab, setActiveTab] = useState<'question' | 'form'>('question')
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [captionsEnabled, setCaptionsEnabledState] = useState(step.captionsEnabled || false)
  const [captionStyle, setCaptionStyleState] = useState<CaptionStyle>(
    (step.captionStyle as CaptionStyle) || DEFAULT_CAPTION_STYLE
  )
  const [trainings, setTrainings] = useState<Training[]>([])
  useEffect(() => {
    // Only fetch when the training panel actually needs the list; avoids
    // hitting /api/trainings for every video/question step edit.
    if (step.stepType !== 'training') return
    let cancelled = false
    fetch('/api/trainings').then(async (r) => {
      if (!r.ok || cancelled) return
      const data = await r.json()
      if (!cancelled) setTrainings(data)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [step.stepType])
  const [schedulingConfigs, setSchedulingConfigs] = useState<SchedulingConfigLite[]>([])
  useEffect(() => {
    // Same lazy-fetch pattern as trainings: only load configs when this
    // step actually needs them.
    if (step.stepType !== 'scheduling') return
    let cancelled = false
    fetch('/api/scheduling').then(async (r) => {
      if (!r.ok || cancelled) return
      const data = await r.json()
      if (!cancelled) setSchedulingConfigs(data)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [step.stepType])

  // Load segments from video record on mount
  const videoSegments = step.video?.segments as Segment[] | null | undefined
  const fileInputRef = useRef<HTMLInputElement>(null)

  const formConfig: FormConfig = (step.formConfig as FormConfig) || DEFAULT_FORM_CONFIG

  // Persist caption settings to step
  const setCaptionsEnabled = (enabled: boolean) => {
    setCaptionsEnabledState(enabled)
    onUpdateStep(step.id, { captionsEnabled: enabled } as Partial<Step>)
  }
  const setCaptionStyle = (style: CaptionStyle) => {
    setCaptionStyleState(style)
    onUpdateStep(step.id, { captionStyle: style } as Partial<Step>)
  }

  const processVideoFile = async (file: File) => {
    setUploading(true)
    setUploadProgress(5)

    try {
      // Route through the dashboard-level UploadProvider so this upload shows
      // up in the global banner and survives if the recruiter navigates to
      // another step or page mid-upload.
      const result = await startUpload(file, 'interview')
      setUploadProgress(100)

      if (result.videoId) {
        const video = { id: result.videoId, filename: result.filename, url: '' }
        onVideoUploaded?.(video)
        onUpdateStep(step.id, { videoId: result.videoId })

        // Auto-trigger analysis (transcription + AI summary) in background
        setAnalyzing(true)
        setAnalysisError(null)
        triggerVideoAnalysis(
          result.videoId,
          (analysis) => {
            setAnalyzing(false)
            setTranscript({ text: analysis.transcript, segments: analysis.segments || [] })
            if (analysis.segments?.length > 0) setCaptionsEnabled(true)
            // Auto-set step title from video analysis
            if (analysis.displayName) {
              onUpdateStep(step.id, { title: analysis.displayName })
            }
            onVideoUploaded?.({
              ...video,
              displayName: analysis.displayName,
              summary: analysis.summary,
              bulletPoints: analysis.bulletPoints,
              transcript: analysis.transcript,
            })
          },
          (error) => {
            setAnalyzing(false)
            setAnalysisError(error)
          }
        )
      }
    } catch {
      // Upload failed silently
    } finally {
      setUploading(false)
    }
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('video/')) {
      alert('Please select a video file')
      return
    }
    try {
      await processVideoFile(file)
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const [recorderOpen, setRecorderOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const handleRecorded = async (file: File) => {
    setRecorderOpen(false)
    await processVideoFile(file)
  }

  const handleTranscribe = async () => {
    if (!step.videoId) return
    setTranscribing(true)
    try {
      const res = await fetch(`/api/videos/${step.videoId}/transcribe`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setTranscript(data)
        setCaptionsEnabled(true)
      }
    } catch {}
    setTranscribing(false)
  }

  const handleSuggestQuestions = async () => {
    setSuggesting(true)
    setSuggestion(null)
    try {
      const res = await fetch('/api/ai/suggest-questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: transcript?.text || step.video?.transcript || null,
          stepTitle: step.title,
          flowContext: `This is step ${step.stepOrder + 1} in an application flow.`,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setSuggestion(data)
      }
    } catch {}
    setSuggesting(false)
  }

  const applySuggestion = () => {
    if (!suggestion) return
    onUpdateStep(step.id, { questionText: suggestion.question })
    setSuggestion(null)
  }

  const toggleFormEnabled = () => {
    const newEnabled = !step.formEnabled
    onUpdateStep(step.id, {
      formEnabled: newEnabled,
      formConfig: newEnabled && !step.formConfig ? DEFAULT_FORM_CONFIG : step.formConfig,
    } as Partial<Step>)
  }

  const updateFormField = (fieldId: string, updates: Partial<FormField>) => {
    const newFields = formConfig.fields.map((f) =>
      f.id === fieldId ? { ...f, ...updates } : f
    )
    onUpdateStep(step.id, { formConfig: { fields: newFields } } as Partial<Step>)
  }

  const addCustomField = () => {
    const newField: FormField = {
      id: `custom_${Date.now()}`,
      label: 'New Field',
      type: 'text',
      required: false,
      enabled: true,
      isBuiltIn: false,
    }
    const newFields = [...formConfig.fields, newField]
    onUpdateStep(step.id, { formConfig: { fields: newFields } } as Partial<Step>)
  }

  const removeCustomField = (fieldId: string) => {
    const newFields = formConfig.fields.filter((f) => f.id !== fieldId)
    onUpdateStep(step.id, { formConfig: { fields: newFields } } as Partial<Step>)
  }

  const [colorTarget, setColorTarget] = useState<'text' | 'bg' | null>(null)
  const [generatingTitle, setGeneratingTitle] = useState(false)
  const handleGenerateTitle = async () => {
    // If video already has a displayName from analysis, use it directly
    if (step.video?.displayName) {
      onUpdateStep(step.id, { title: step.video.displayName })
      return
    }

    setGeneratingTitle(true)
    try {
      const videoTranscript = transcript?.text || step.video?.transcript || ''
      const videoSummary = step.video?.summary || ''
      const bulletPoints = step.video?.bulletPoints?.join(', ') || ''
      const res = await fetch('/api/ai/generate-title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: videoTranscript, summary: videoSummary, bulletPoints }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.title) onUpdateStep(step.id, { title: data.title })
      }
    } catch {}
    setGeneratingTitle(false)
  }

  const aiSparkIcon = (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 2L9 12l-7 0 5.5 4.5L5 22l7-5 7 5-2.5-5.5L22 12h-7L12 2z" />
    </svg>
  )

  return (
    <div className="space-y-4">
      {/* Header with Save/Cancel */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          {(() => {
            // Match the sidebar's step-number pill — same orange chip, same
            // index calc (allSteps comes pre-sorted by stepOrder asc).
            const idx = allSteps.findIndex((s) => s.id === step.id)
            if (idx < 0) return null
            return (
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-brand-500 text-white text-[12px] font-semibold leading-none flex-shrink-0">
                {idx + 1}
              </span>
            )
          })()}
          <span>Edit Step</span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onDeleteStep(step.id)}
            className="text-red-600 hover:text-red-800 text-xs"
          >
            Delete
          </button>
          {onClose && (
            <>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors"
              >
                Done
              </button>
            </>
          )}
        </div>
      </div>

      {/* Desktop: side-by-side | Mobile: stacked */}
      <div className="flex flex-col lg:flex-row gap-6 min-w-0">
        {/* Left: Video only */}
        <div className="lg:w-1/2 min-w-0">
          <label className="block text-sm font-medium text-gray-700 mb-1">Video</label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex-1 min-w-[140px] px-3 py-2 text-sm border border-gray-300 rounded-md text-left flex items-center justify-between hover:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <span className={step.videoId ? 'text-gray-900 truncate' : 'text-gray-400'}>
                {(() => {
                  const sv = videos.find(v => v.id === step.videoId)
                  return sv ? (sv.displayName || sv.filename) : 'Browse library…'
                })()}
              </span>
              <svg className="w-4 h-4 text-gray-400 flex-shrink-0 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7"/></svg>
            </button>
            <label className={`px-3 py-2 rounded-md text-sm font-medium cursor-pointer transition-colors whitespace-nowrap ${
              uploading
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-brand-50 text-brand-500 hover:bg-brand-100 border border-brand-200'
            }`}>
              {uploading ? `${uploadProgress}%` : 'Upload'}
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                onChange={handleUpload}
                disabled={uploading}
                className="hidden"
              />
            </label>
            <button
              type="button"
              onClick={() => setRecorderOpen(true)}
              disabled={uploading}
              className={`px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap inline-flex items-center gap-1.5 transition-colors ${
                uploading
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-brand-50 text-brand-500 hover:bg-brand-100 border border-brand-200'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-red-500" />
              Record
            </button>
          </div>

          {uploading && (
            <div className="mt-2">
              <div className="w-full bg-gray-200 rounded-full h-1.5">
                <div
                  className="bg-brand-500 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">Uploading video...</p>
            </div>
          )}

          {step.video && !hideVideo && (
            <div className="mt-2">
              <CaptionedVideo
                src={step.video.url}
                hlsUrl={(step.video as { hlsUrl?: string | null }).hlsUrl}
                status={(step.video as { status?: string | null }).status}
                videoId={step.video.id}
                segments={transcript?.segments || videoSegments || []}
                captionsEnabled={captionsEnabled}
                captionStyle={captionStyle}
                onStyleChange={setCaptionStyle}
                showStyleEditor={false}
              />
            </div>
          )}
        </div>

        {/* Right: Title, Transcription/Captions, Question/Form */}
        <div className="lg:w-1/2 min-w-0 space-y-4">
          {/* Title with AI generate */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700">Title</label>
              {(transcript?.text || step.video?.transcript) && (
                <button
                  onClick={handleGenerateTitle}
                  disabled={generatingTitle}
                  className="flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 disabled:opacity-50"
                >
                  {aiSparkIcon}
                  {generatingTitle ? 'Generating...' : 'AI Generate'}
                </button>
              )}
            </div>
            <DebouncedInput
              type="text"
              value={step.title}
              onChange={(val) => onUpdateStep(step.id, { title: val })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          {/* Analyzing indicator */}
          {analyzing && (
            <div className="flex items-center gap-2 text-sm text-purple-600">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Analyzing video — transcribing &amp; generating summary...
            </div>
          )}

          {/* Analysis error */}
          {analysisError && (
            <div className="bg-red-50 rounded-md p-3 border border-red-200">
              <p className="text-xs text-red-700">{analysisError}</p>
              <button onClick={() => setAnalysisError(null)} className="text-xs text-red-500 hover:text-red-700 mt-1">Dismiss</button>
            </div>
          )}

          {/* Video analysis info */}
          {step.video?.displayName && (
            <div className="bg-brand-50 rounded-md p-3 border border-brand-200">
              <p className="text-sm font-medium text-brand-800">{step.video.displayName}</p>
              {step.video.summary && <p className="text-xs text-brand-700 mt-1">{step.video.summary}</p>}
              {step.video.bulletPoints && step.video.bulletPoints.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {step.video.bulletPoints.map((bp, i) => (
                    <li key={i} className="text-xs text-brand-500 flex items-start gap-1.5">
                      <span className="mt-1 w-1 h-1 bg-brand-400 rounded-full flex-shrink-0" />
                      {bp}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Transcription & Captions controls */}
          {step.video && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleTranscribe}
                  disabled={transcribing || analyzing}
                  className="px-3 py-1.5 text-xs bg-purple-50 text-purple-700 border border-purple-200 rounded-md hover:bg-purple-100 disabled:opacity-50 transition-colors"
                >
                  {transcribing ? 'Transcribing...' : transcript || videoSegments?.length ? 'Re-transcribe' : 'Generate Captions'}
                </button>
                {!step.video.displayName && !analyzing && (
                  <button
                    onClick={() => {
                      if (!step.videoId) return
                      setAnalyzing(true)
                      setAnalysisError(null)
                      triggerVideoAnalysis(
                        step.videoId,
                        (analysis) => {
                          setAnalyzing(false)
                          setTranscript({ text: analysis.transcript, segments: analysis.segments || [] })
                          if (analysis.segments?.length > 0) setCaptionsEnabled(true)
                          if (analysis.displayName) onUpdateStep(step.id, { title: analysis.displayName })
                          onVideoUploaded?.({
                            id: step.video!.id, filename: step.video!.filename, url: step.video!.url,
                            displayName: analysis.displayName, summary: analysis.summary,
                            bulletPoints: analysis.bulletPoints, transcript: analysis.transcript,
                          })
                        },
                        (error) => { setAnalyzing(false); setAnalysisError(error) }
                      )
                    }}
                    className="px-3 py-1.5 text-xs bg-brand-50 text-brand-700 border border-brand-200 rounded-md hover:bg-brand-100 transition-colors"
                  >
                    Analyze Video
                  </button>
                )}

                {/* Captions toggle */}
                {((transcript && transcript.segments.length > 0) || (videoSegments && videoSegments.length > 0)) && (
                  <div className="flex items-center gap-2 ml-auto">
                    <button
                      onClick={() => setCaptionsEnabled(!captionsEnabled)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
                        captionsEnabled ? 'bg-brand-500' : 'bg-gray-300'
                      }`}
                    >
                      <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                        captionsEnabled ? 'translate-x-5' : 'translate-x-1'
                      }`} />
                    </button>
                    <span className="text-xs text-gray-600">Captions</span>
                  </div>
                )}
              </div>

              {/* Caption style editor — shown when captions enabled */}
              {captionsEnabled && ((transcript && transcript.segments.length > 0) || (videoSegments && videoSegments.length > 0)) && (() => {
                const PALETTE = [
                  { color: '#ffffff', label: 'White' },
                  { color: '#000000', label: 'Black' },
                  { color: '#f3f4f6', label: 'Light Gray' },
                  { color: '#6b7280', label: 'Gray' },
                  { color: '#374151', label: 'Dark Gray' },
                  { color: '#ef4444', label: 'Red' },
                  { color: '#f97316', label: 'Orange' },
                  { color: '#eab308', label: 'Yellow' },
                  { color: '#22c55e', label: 'Green' },
                  { color: '#14b8a6', label: 'Teal' },
                  { color: '#3b82f6', label: 'Blue' },
                  { color: '#8b5cf6', label: 'Purple' },
                  { color: '#ec4899', label: 'Pink' },
                  { color: '#a855f7', label: 'Violet' },
                  { color: 'transparent', label: 'None' },
                ]
                const OPACITIES = [
                  { value: 1, label: '100%' },
                  { value: 0.9, label: '90%' },
                  { value: 0.75, label: '75%' },
                  { value: 0.5, label: '50%' },
                  { value: 0.3, label: '30%' },
                ]
                const applyPaletteColor = (hex: string, target: 'text' | 'bg') => {
                  if (target === 'text') {
                    setCaptionStyle({ ...captionStyle, color: hex })
                  } else if (hex === 'transparent') {
                    setCaptionStyle({ ...captionStyle, backgroundColor: 'transparent' })
                  } else {
                    const m = captionStyle.backgroundColor.match(/[\d.]+\)$/)
                    const op = m ? parseFloat(m[0]) : 0.75
                    const r = parseInt(hex.slice(1, 3), 16)
                    const g = parseInt(hex.slice(3, 5), 16)
                    const b = parseInt(hex.slice(5, 7), 16)
                    setCaptionStyle({ ...captionStyle, backgroundColor: `rgba(${r}, ${g}, ${b}, ${op})` })
                  }
                }
                const applyOpacity = (op: number) => {
                  const m = captionStyle.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
                  if (m) setCaptionStyle({ ...captionStyle, backgroundColor: `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${op})` })
                }
                const getActiveHex = (target: 'text' | 'bg') => {
                  if (target === 'text') return captionStyle.color
                  if (captionStyle.backgroundColor === 'transparent') return 'transparent'
                  const m = captionStyle.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
                  if (m) return '#' + [m[1], m[2], m[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('')
                  return captionStyle.backgroundColor
                }
                const curOpacity = () => {
                  const m = captionStyle.backgroundColor.match(/([\d.]+)\)$/)
                  return m ? parseFloat(m[1]) : 1
                }

                return (
                <div className="bg-gray-50 rounded-md p-3 border border-gray-200 space-y-3">
                  <span className="text-xs font-medium text-gray-500 uppercase block">Caption Style</span>

                  {/* Font + numeric size */}
                  <div className="flex items-center gap-2">
                    <select
                      value={captionStyle.fontFamily}
                      onChange={e => setCaptionStyle({ ...captionStyle, fontFamily: e.target.value })}
                      className="flex-1 text-xs px-2 py-1.5 border border-gray-300 rounded"
                    >
                      <option value="Arial, sans-serif">Arial</option>
                      <option value="Helvetica, Arial, sans-serif">Helvetica</option>
                      <option value="Georgia, serif">Georgia</option>
                      <option value="'Times New Roman', serif">Times New Roman</option>
                      <option value="'Courier New', monospace">Courier</option>
                      <option value="Verdana, sans-serif">Verdana</option>
                      <option value="Impact, sans-serif">Impact</option>
                    </select>
                    <div className="flex items-center gap-0.5">
                      <button
                        onClick={() => setCaptionStyle({ ...captionStyle, fontSize: Math.max(8, captionStyle.fontSize - 1) })}
                        className="w-6 h-6 flex items-center justify-center text-xs border border-gray-300 rounded hover:bg-gray-100"
                      >−</button>
                      <input
                        type="number"
                        min={8}
                        max={48}
                        value={captionStyle.fontSize}
                        onChange={e => setCaptionStyle({ ...captionStyle, fontSize: Math.max(8, Math.min(48, Number(e.target.value) || 16)) })}
                        className="w-11 text-center text-xs px-0.5 py-1.5 border border-gray-300 rounded"
                      />
                      <button
                        onClick={() => setCaptionStyle({ ...captionStyle, fontSize: Math.min(48, captionStyle.fontSize + 1) })}
                        className="w-6 h-6 flex items-center justify-center text-xs border border-gray-300 rounded hover:bg-gray-100"
                      >+</button>
                    </div>
                  </div>

                  {/* Font Color & Background toggle buttons */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => setColorTarget(colorTarget === 'text' ? null : 'text')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors ${
                        colorTarget === 'text' ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-gray-300 text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      <span className="w-4 h-4 rounded border border-gray-400" style={{ backgroundColor: captionStyle.color }} />
                      Font Color
                    </button>
                    <button
                      onClick={() => setColorTarget(colorTarget === 'bg' ? null : 'bg')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors ${
                        colorTarget === 'bg' ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-gray-300 text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      <span className="w-4 h-4 rounded border border-gray-400" style={{
                        background: captionStyle.backgroundColor === 'transparent'
                          ? 'repeating-conic-gradient(#ccc 0% 25%, white 0% 50%) 50% / 6px 6px'
                          : captionStyle.backgroundColor,
                      }} />
                      Background
                    </button>
                  </div>

                  {/* Shared palette */}
                  {colorTarget && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-1.5">
                        {PALETTE.map(({ color, label }) => (
                          <button
                            key={color}
                            title={label}
                            onClick={() => applyPaletteColor(color, colorTarget)}
                            className={`w-6 h-6 rounded border-2 transition-all ${
                              getActiveHex(colorTarget) === color
                                ? 'border-brand-500 scale-110 ring-1 ring-brand-300'
                                : 'border-gray-300 hover:border-gray-400'
                            }`}
                            style={{
                              background: color === 'transparent'
                                ? 'repeating-conic-gradient(#ccc 0% 25%, white 0% 50%) 50% / 8px 8px'
                                : color,
                            }}
                          />
                        ))}
                      </div>
                      {/* Opacity for background */}
                      {colorTarget === 'bg' && captionStyle.backgroundColor !== 'transparent' && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-gray-500">Opacity:</span>
                          {OPACITIES.map(({ value, label }) => (
                            <button
                              key={value}
                              onClick={() => applyOpacity(value)}
                              className={`text-[10px] px-1.5 py-0.5 rounded ${
                                Math.abs(curOpacity() - value) < 0.05
                                  ? 'bg-brand-500 text-white'
                                  : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                              }`}
                            >{label}</button>
                          ))}
                        </div>
                      )}
                      {/* Custom hex */}
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={getActiveHex(colorTarget) === 'transparent' ? '#000000' : getActiveHex(colorTarget)}
                          onChange={e => applyPaletteColor(e.target.value, colorTarget)}
                          className="w-6 h-6 rounded cursor-pointer border border-gray-300"
                        />
                        <input
                          type="text"
                          value={colorTarget === 'text' ? captionStyle.color : captionStyle.backgroundColor}
                          onChange={e => {
                            if (colorTarget === 'text') setCaptionStyle({ ...captionStyle, color: e.target.value })
                            else setCaptionStyle({ ...captionStyle, backgroundColor: e.target.value })
                          }}
                          className="flex-1 text-xs px-2 py-1 border border-gray-300 rounded font-mono"
                          placeholder="#hex or rgba(...)"
                        />
                      </div>
                    </div>
                  )}
                </div>
                )
              })()}

              {/* Transcript text */}
              {transcript && (
                <div className="bg-gray-50 rounded-md p-3 border border-gray-200">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-500 uppercase">Transcript</span>
                    <button onClick={() => setTranscript(null)} className="text-xs text-gray-400 hover:text-gray-600">Dismiss</button>
                  </div>
                  <div className="space-y-1 max-h-28 overflow-y-auto text-sm">
                    {transcript.segments.length > 0 ? (
                      transcript.segments.map((seg, i) => (
                        <div key={i} className="flex gap-2">
                          <span className="text-gray-400 text-xs font-mono whitespace-nowrap mt-0.5">{formatTime(seg.start)}</span>
                          <span className="text-gray-700">{seg.text}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-gray-600">{transcript.text}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* AI Suggestion */}
          {suggestion && (
            <div className="bg-amber-50 rounded-md p-3 border border-amber-200">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-amber-600 uppercase">AI Suggestion</span>
                <button onClick={() => setSuggestion(null)} className="text-xs text-amber-400 hover:text-amber-600">Dismiss</button>
              </div>
              <p className="text-sm font-medium text-gray-800 mb-2">&ldquo;{suggestion.question}&rdquo;</p>
              <div className="space-y-1 mb-3">
                {suggestion.options.map((opt, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-gray-600">
                    <span className="w-4 h-4 rounded-full border border-gray-300 flex items-center justify-center text-[10px]">{i + 1}</span>
                    {opt.text}
                    {opt.isEndFlow && <span className="text-[10px] text-red-500 font-medium">(End)</span>}
                  </div>
                ))}
              </div>
              <button onClick={applySuggestion} className="px-3 py-1.5 text-xs bg-amber-600 text-white rounded-md hover:bg-amber-700 transition-colors">
                Apply Question
              </button>
            </div>
          )}

          {/* Tabs */}
          <div className="flex border-b border-gray-200 mb-4">
            <button
              onClick={() => setActiveTab('question')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'question'
                  ? 'border-brand-500 text-brand-500'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Question
            </button>
            <button
              onClick={() => setActiveTab('form')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'form'
                  ? 'border-brand-500 text-brand-500'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Form
              {step.formEnabled && (
                <span className="ml-1.5 w-2 h-2 bg-green-500 rounded-full inline-block" />
              )}
            </button>
          </div>

          {/* Question Tab */}
          {activeTab === 'question' && (
            <div className="space-y-4">
              {/* Question */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-gray-700">Question</label>
                  <button
                    onClick={handleSuggestQuestions}
                    disabled={suggesting || analyzing}
                    className="flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 disabled:opacity-50"
                  >
                    {aiSparkIcon}
                    {suggesting ? 'Generating...' : 'AI Generate'}
                  </button>
                </div>
                <DebouncedTextarea
                  value={step.questionText || ''}
                  onChange={(val) => onUpdateStep(step.id, { questionText: val })}
                  rows={2}
                  placeholder="What question should candidates answer?"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              {/* Step Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Step Type</label>
                <select
                  value={step.stepType || 'question'}
                  onChange={(e) => onUpdateStep(step.id, { stepType: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="question">Question Step</option>
                  <option value="form">Form Step (Collect Information)</option>
                  <option value="submission">Video Step (Watch + Continue)</option>
                  <option value="info">Info Step (Instructions/Notice)</option>
                  <option value="training">Training Step (Complete Training)</option>
                  <option value="scheduling">Scheduling Step (Book Meeting)</option>
                </select>
              </div>

              {/* Question Type */}
              {(step.stepType || 'question') === 'question' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Question Type</label>
                  <select
                    value={step.questionType || 'single'}
                    onChange={(e) => onUpdateStep(step.id, { questionType: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="single">Single Choice</option>
                    <option value="multiselect">Multiple Choice</option>
                    <option value="yesno">Yes / No</option>
                    <option value="button">Quick Action (Buttons)</option>
                    <option value="text">Short Text Answer</option>
                  </select>
                </div>
              )}

              {/* Form Step */}
              {step.stepType === 'form' && (
                <div className="bg-brand-50 border border-brand-200 rounded-md p-4">
                  <h4 className="font-medium text-brand-800 mb-2">Form Step</h4>
                  <p className="text-sm text-brand-700 mb-3">
                    Collect candidate information. Toggle fields below in the Form tab.
                  </p>
                  <button onClick={() => setActiveTab('form')} className="text-sm text-brand-500 hover:text-brand-800 font-medium">
                    Configure Form Fields →
                  </button>
                </div>
              )}

              {/* Info Step */}
              {step.stepType === 'info' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Info Content</label>
                  <DebouncedTextarea
                    value={step.infoContent || ''}
                    onChange={(val) => onUpdateStep(step.id, { infoContent: val })}
                    rows={5}
                    placeholder="Instructions, welcome text, or transition notice..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
              )}

              {/* Video Step Info */}
              {step.stepType === 'submission' && (
                <div className="bg-brand-50 border border-brand-200 rounded-md p-4">
                  <h4 className="font-medium text-brand-800 mb-2">Video Step</h4>
                  <p className="text-sm text-brand-700">
                    Candidate watches the video then clicks Continue to proceed.
                  </p>
                </div>
              )}

              {/* Scheduling Step — pick the SchedulingConfig the
                  candidate must book against. The answer route hard-
                  blocks advance until an InterviewMeeting exists for
                  this session + config (cancelledAt=null). Reschedule
                  goes through the standard /book/[id]/reschedule flow —
                  no duplicate UI here. */}
              {step.stepType === 'scheduling' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Scheduling config</label>
                  {step.schedulingConfigId && !schedulingConfigs.find(c => c.id === step.schedulingConfigId) && schedulingConfigs.length > 0 && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 mb-2 text-xs text-amber-800">
                      The scheduling config this step referenced was deleted. Pick a new one.
                    </div>
                  )}
                  <select
                    value={step.schedulingConfigId || ''}
                    onChange={(e) => onUpdateStep(step.id, { schedulingConfigId: e.target.value || null } as Partial<Step>)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="">Select a scheduling config…</option>
                    {schedulingConfigs.filter(c => c.isActive || c.id === step.schedulingConfigId).map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}{!c.isActive ? ' (inactive)' : c.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Candidate must book a meeting before the flow advances. Reschedule uses the standard booking flow.
                  </p>
                </div>
              )}

              {/* Training Step — pick the training the candidate must
                  finish. The flow answer route hard-blocks advance until
                  TrainingEnrollment.completedAt is set for this session +
                  trainingId pair. If the picker shows "missing", the
                  underlying training was deleted (schema is SetNull) and
                  the recruiter needs to pick a new one. */}
              {step.stepType === 'training' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Training</label>
                  {step.trainingId && !trainings.find(t => t.id === step.trainingId) && trainings.length > 0 && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 mb-2 text-xs text-amber-800">
                      The training this step referenced was deleted. Pick a new one.
                    </div>
                  )}
                  <select
                    value={step.trainingId || ''}
                    onChange={(e) => onUpdateStep(step.id, { trainingId: e.target.value || null } as Partial<Step>)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="">Select a training…</option>
                    {trainings.filter(t => t.isPublished || t.id === step.trainingId).map(t => (
                      <option key={t.id} value={t.id}>
                        {t.title}{!t.isPublished ? ' (draft)' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Candidate must finish this training before the flow advances. Progress is tracked automatically.
                  </p>
                </div>
              )}

              {/* Options */}
              {(step.stepType || 'question') === 'question' && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-gray-700">Answer Options</label>
                    <button onClick={() => onAddOption(step.id)} className="text-brand-500 hover:text-brand-800 text-sm">
                      + Add Option
                    </button>
                  </div>
                  <div className="space-y-3">
                    {step.options.map((option) => (
                      <div key={option.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-md">
                        <div className="flex-1 space-y-2">
                          <DebouncedInput
                            type="text"
                            value={option.optionText}
                            onChange={(val) => onUpdateOption(option.id, { optionText: val })}
                            placeholder="Option text"
                            className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
                          />
                          <select
                            value={option.nextStepId || ''}
                            onChange={(e) => onUpdateOption(option.id, { nextStepId: e.target.value === '__end__' ? null : (e.target.value || null) })}
                            className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
                          >
                            <option value="">→ Next step (auto)</option>
                            <option value="__end__">→ End</option>
                            {[...allSteps]
                              .sort((a, b) => a.stepOrder - b.stepOrder)
                              .map((s, i) => ({ s, idx: i + 1 }))
                              .filter(({ s }) => s.id !== step.id)
                              .map(({ s, idx }) => (
                                <option key={s.id} value={s.id}>→ {idx}. {s.title}</option>
                              ))}
                          </select>
                        </div>
                        <button onClick={() => onDeleteOption(step.id, option.id)} className="text-red-500 hover:text-red-700 p-1">
                          &times;
                        </button>
                      </div>
                    ))}
                    {step.options.length === 0 && (
                      <div className="text-sm text-gray-500 text-center py-4">
                        No options yet. Add options for candidates to choose from.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Form Tab */}
          {activeTab === 'form' && (
            <div className="space-y-4">
              {/* Enable Switch */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-700">Collect Information</p>
                  <p className="text-xs text-gray-500">Show a form after this step</p>
                </div>
                <button
                  onClick={toggleFormEnabled}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    step.formEnabled ? 'bg-brand-500' : 'bg-gray-300'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      step.formEnabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {step.formEnabled && (
                <>
                  {/* Built-in Fields */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Fields</label>
                    <div className="space-y-2">
                      {formConfig.fields.map((field) => (
                        <div key={field.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-md">
                          {/* Enable toggle */}
                          <button
                            onClick={() => updateFormField(field.id, { enabled: !field.enabled })}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
                              field.enabled ? 'bg-brand-500' : 'bg-gray-300'
                            }`}
                          >
                            <span
                              className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                                field.enabled ? 'translate-x-5' : 'translate-x-1'
                              }`}
                            />
                          </button>

                          {/* Field label */}
                          {field.isBuiltIn ? (
                            <div className="flex-1">
                              <span className="text-sm text-gray-700">{field.label}</span>
                              <span className="ml-2 text-xs text-gray-400">{field.type}</span>
                            </div>
                          ) : (
                            <DebouncedInput
                              type="text"
                              value={field.label}
                              onChange={(val) => updateFormField(field.id, { label: val })}
                              className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                          )}

                          {/* Required toggle */}
                          {field.enabled && (
                            <button
                              onClick={() => updateFormField(field.id, { required: !field.required })}
                              className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
                                field.required
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-gray-100 text-gray-500'
                              }`}
                            >
                              {field.required ? 'Required' : 'Optional'}
                            </button>
                          )}

                          {/* Type selector for custom fields */}
                          {!field.isBuiltIn && (
                            <select
                              value={field.type}
                              onChange={(e) => updateFormField(field.id, { type: e.target.value as FormField['type'] })}
                              className="text-xs px-2 py-1 border border-gray-300 rounded"
                            >
                              <option value="text">Text</option>
                              <option value="email">Email</option>
                              <option value="phone">Phone</option>
                              <option value="textarea">Long Text</option>
                            </select>
                          )}

                          {/* Delete custom field */}
                          {!field.isBuiltIn && (
                            <button
                              onClick={() => removeCustomField(field.id)}
                              className="text-red-500 hover:text-red-700 text-sm"
                            >
                              &times;
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Add Custom Field */}
                  <button
                    onClick={addCustomField}
                    className="w-full py-2 border-2 border-dashed border-gray-300 rounded-md text-sm text-gray-500 hover:border-brand-400 hover:text-brand-500 transition-colors"
                  >
                    + Add Custom Field
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <VideoRecorderModal
        open={recorderOpen}
        onClose={() => setRecorderOpen(false)}
        onAccept={handleRecorded}
        filenameStem={`step-${step.stepOrder + 1}-recording`}
      />
      <VideoPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        videos={videos}
        selectedId={step.videoId}
        onSelect={(v) => {
          const updates: Partial<Step> = { videoId: v.id }
          // Match the previous auto-title behavior — only overwrite when
          // the step still has a placeholder title.
          if (v.displayName && (!step.title || step.title === 'New Step' || step.title === 'Untitled Step')) {
            updates.title = v.displayName
          }
          onUpdateStep(step.id, updates)
        }}
      />
    </div>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
