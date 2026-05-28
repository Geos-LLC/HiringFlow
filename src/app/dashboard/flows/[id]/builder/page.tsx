'use client'

import { useState, useEffect, useRef } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import FlowSchemaView from '@/components/FlowSchemaView'
import StepEditorPanel from '@/components/StepEditorPanel'
import StepPreviewModal from '@/components/StepPreviewModal'
import BrandingEditor from '@/components/BrandingEditor'
import { type BrandingConfig } from '@/lib/branding'
import { validateCaptureConfig } from '@/lib/capture/capture-config'
import CaptureStepConfigPanel from './_CaptureStepConfigPanel'
import { useUploads } from '../../../_components/UploadProvider'

interface Video {
  id: string
  filename: string
  url: string
  displayName?: string | null
}

interface Option {
  id: string
  optionText: string
  nextStepId: string | null
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
  infoContent?: string | null
  formEnabled?: boolean
  formConfig?: any
  buttonConfig?: { enabled?: boolean; text?: string; nextStepId?: string | null } | null
  combinedWithId?: string | null
  captionsEnabled?: boolean
  captionStyle?: any
  captureConfig?: unknown
  options: Option[]
}

interface Flow {
  id: string
  name: string
  slug: string
  isPublished: boolean
  startMessage: string
  endMessage: string
  branding: Record<string, unknown> | null
  canvasLayout?: Record<string, { x: number; y: number }> | null
  steps: Step[]
  // Composite flag (global env AND workspace.settings.captureStepsEnabled).
  // Builder hides the Audio Answer tile when this is false. The server is
  // the source of truth — we never read env or workspace settings on the
  // client.
  captureStepsEnabled?: boolean
}

export default function FlowBuilderPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const flowId = params.id as string
  const { startUpload } = useUploads()

  const [flow, setFlow] = useState<Flow | null>(null)
  const [videos, setVideos] = useState<Video[]>([])
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [viewMode, setViewMode] = useState<'editor' | 'schema' | 'branding'>(
    searchParams.get('view') === 'schema' ? 'schema' : 'editor'
  )
  const [popupStepId, setPopupStepId] = useState<string | null>(null)
  // True while the capture popup panel has unresolved validation errors. The
  // popup's Save button is disabled in this state — replaces the prior
  // alert()-on-bad-config UX.
  const [capturePanelInvalid, setCapturePanelInvalid] = useState(false)
  // Reset capture validity whenever the popup closes or jumps to a different
  // step, so a previously-invalid state never leaks into the next popup.
  useEffect(() => {
    if (!popupStepId) setCapturePanelInvalid(false)
    else setCapturePanelInvalid(false)
  }, [popupStepId])
  const [combineEnabled, setCombineEnabled] = useState(false)
  const [previewStepId, setPreviewStepId] = useState<string | null>(null)
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    fetchFlow()
    fetchVideos()
  }, [flowId])

  // Mirror the Media library's display preference so video pickers/labels
  // here show the same names the user picked over there.
  const [useAutoName, setUseAutoName] = useState(true)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem('media:useAutoName')
    if (stored === 'false') setUseAutoName(false)
    else if (stored === 'true') setUseAutoName(true)
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'media:useAutoName') setUseAutoName(e.newValue !== 'false')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const videoLabel = (v: { displayName?: string | null; filename: string }) =>
    useAutoName ? (v.displayName || v.filename) : v.filename

  const fetchFlow = async () => {
    const res = await fetch(`/api/flows/${flowId}`)
    if (res.ok) {
      const data = await res.json()
      setFlow(data)
      if (data.steps.length > 0 && !selectedStepId) {
        setSelectedStepId(data.steps[0].id)
      }
    }
  }

  const fetchVideos = async () => {
    const res = await fetch('/api/videos?kind=interview')
    if (res.ok) {
      const data = await res.json()
      setVideos(data)
    }
  }

  const selectedStep = flow?.steps.find((s) => s.id === selectedStepId)
  const popupStep = flow?.steps.find((s) => s.id === popupStepId)

  const markChanged = () => {
    setHasChanges(true)
    if (flow?.isPublished) {
      setFlow((f) => f ? { ...f, isPublished: false } : null)
      // Unpublish on backend
      fetch(`/api/flows/${flowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublished: false }),
      })
    }
  }

  const [showAddStepModal, setShowAddStepModal] = useState(false)
  const [modalPos, setModalPos] = useState({ x: 0, y: 0 })
  const [isDraggingModal, setIsDraggingModal] = useState(false)
  const modalDragStart = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)

  useEffect(() => {
    if (!isDraggingModal) return
    const handleMove = (e: MouseEvent) => {
      if (!modalDragStart.current) return
      setModalPos({
        x: modalDragStart.current.startX + (e.clientX - modalDragStart.current.x),
        y: modalDragStart.current.startY + (e.clientY - modalDragStart.current.y),
      })
    }
    const handleUp = () => { setIsDraggingModal(false); modalDragStart.current = null }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => { window.removeEventListener('mousemove', handleMove); window.removeEventListener('mouseup', handleUp) }
  }, [isDraggingModal])
  const [addStepType, setAddStepType] = useState<string | null>(null)
  const [addStepTitle, setAddStepTitle] = useState('')
  const [addStepVideoId, setAddStepVideoId] = useState('')
  const [addStepQuestion, setAddStepQuestion] = useState('')
  const [addStepOptions, setAddStepOptions] = useState<Array<{ text: string; nextStepId: string | null }>>([{ text: '', nextStepId: null }, { text: '', nextStepId: null }])
  const [addStepQuestionType, setAddStepQuestionType] = useState('single')
  const [addStepFormFields, setAddStepFormFields] = useState([
    { id: 'name', label: 'Full Name', type: 'text', required: true, enabled: true, isBuiltIn: true },
    { id: 'email', label: 'Email', type: 'email', required: true, enabled: true, isBuiltIn: true },
    { id: 'phone', label: 'Phone', type: 'phone', required: false, enabled: true, isBuiltIn: true },
  ])
  const [addStepInfoText, setAddStepInfoText] = useState('')
  const [addStepImageUrl, setAddStepImageUrl] = useState<string | null>(null)
  // Capture step (Phase 1C ships audio mode). The recruiter never touches the
  // raw JSON — these fields feed validateCaptureConfig() before persistence so
  // a malformed config can never reach the DB.
  const [addStepCapturePrompt, setAddStepCapturePrompt] = useState('')
  const [addStepCaptureRequired, setAddStepCaptureRequired] = useState(true)
  const [addStepCaptureMinDuration, setAddStepCaptureMinDuration] = useState<string>('')
  const [addStepCaptureMaxDuration, setAddStepCaptureMaxDuration] = useState<string>('120')
  const [addStepCaptureAllowRetake, setAddStepCaptureAllowRetake] = useState(true)
  const [addStepCaptureMaxRetakes, setAddStepCaptureMaxRetakes] = useState<string>('2')
  const [addStepCaptureError, setAddStepCaptureError] = useState<string | null>(null)
  const [addStepButtonEnabled, setAddStepButtonEnabled] = useState(false)
  const [addStepButtonText, setAddStepButtonText] = useState('Continue')
  // Action-button "next step" target. null = auto, '__end__' = End, else stepId.
  const [addStepButtonNextStepId, setAddStepButtonNextStepId] = useState<string | null>(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [uploadingStepVideo, setUploadingStepVideo] = useState(false)
  const [stepVideoProgress, setStepVideoProgress] = useState(0)
  const [autoTitleEnabled, setAutoTitleEnabled] = useState(true)
  const [combineAfterCreateId, setCombineAfterCreateId] = useState<string | null>(null)
  const [pendingArrowInsertion, setPendingArrowInsertion] = useState<
    | { kind: 'option'; optionId: string; fromStepId: string; toStepId: string }
    | { kind: 'button'; fromStepId: string; toStepId: string }
    | { kind: 'start'; toStepId: string }
    | { kind: 'end'; fromStepId: string }
    | null
  >(null)
  const [titleWarning, setTitleWarning] = useState(false)
  const stepVideoInputRef = useRef<HTMLInputElement>(null)

  // When the user clicks "+" on a connection, pre-populate the new step's
  // outgoing target with the current connection's destination so the modal
  // already shows where the new step will route to. Runs after addStep()'s
  // resets because effects fire after state commits.
  useEffect(() => {
    if (!pendingArrowInsertion) return
    const target =
      pendingArrowInsertion.kind === 'end'
        ? '__end__'
        : (pendingArrowInsertion as { toStepId?: string }).toStepId ?? null
    if (target == null) return
    setAddStepButtonNextStepId(target)
    setAddStepOptions((prev) =>
      prev.length > 0 ? prev.map((o, i) => (i === 0 ? { ...o, nextStepId: target } : o)) : prev
    )
  }, [pendingArrowInsertion])

  const createStep = async (stepType: string, config?: Record<string, unknown>) => {
    markChanged()
    const stepNum = (flow?.steps.length || 0) + 1
    const defaults: Record<string, Record<string, unknown>> = {
      question: { title: `Question ${stepNum}`, stepType: 'question', questionType: 'single' },
      submission: { title: `Video ${stepNum}`, stepType: 'submission' },
      form: { title: `Application Form`, stepType: 'form', formEnabled: true, formConfig: { fields: [
        { id: 'name', label: 'Full Name', type: 'text', required: true, enabled: true, isBuiltIn: true },
        { id: 'email', label: 'Email', type: 'email', required: true, enabled: true, isBuiltIn: true },
        { id: 'phone', label: 'Phone', type: 'phone', required: false, enabled: true, isBuiltIn: true },
      ] } },
      info: { title: `Welcome`, stepType: 'info', infoContent: '' },
      capture: {
        title: `Audio answer ${stepNum}`,
        stepType: 'capture',
        // Default config is intentionally permissive — recruiter can tune
        // duration / retake limits in the edit panel after creation.
        captureConfig: {
          mode: 'audio',
          required: true,
          allowRetake: true,
          maxRetakes: 2,
          maxDurationSec: 120,
          transcriptionEnabled: false,
          aiAnalysisEnabled: false,
        },
      },
    }
    const body = { ...defaults[stepType], ...config }

    const res = await fetch(`/api/flows/${flowId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const newStep = await res.json()
      setShowAddStepModal(false)

      // Auto-combine if triggered from Combine dropdown
      if (combineAfterCreateId) {
        await fetch(`/api/steps/${combineAfterCreateId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ combinedWithId: newStep.id }),
        })
        setCombineAfterCreateId(null)
      }

      // Auto-wire connections when triggered from "+" on a connection
      if (pendingArrowInsertion) {
        const info = pendingArrowInsertion

        // For 'start' insert, the new step must become the new first step.
        // The API gave it stepOrder = max+1, so PATCH it to (currentMin - 1).
        if (info.kind === 'start') {
          const minOrder = Math.min(...(flow?.steps ?? []).map((s) => s.stepOrder), newStep.stepOrder) - 1
          await fetch(`/api/steps/${newStep.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stepOrder: minOrder }),
          })
        }

        // After: route the new step forward to the original target. Skip for
        // 'end' inserts — the new step is now the last step, so the implicit
        // last → End arrow takes care of forwarding.
        // Also skip if the user already routed the step via the modal (the
        // pre-populated dropdown / first option), which is the common path.
        const afterTargetId = info.kind === 'end' ? null : info.toStepId
        if (afterTargetId) {
          if (newStep.stepType === 'question') {
            const alreadyRouted = (newStep.options ?? []).some(
              (o: { nextStepId?: string | null }) => o.nextStepId === afterTargetId
            )
            if (!alreadyRouted) {
              await fetch(`/api/steps/${newStep.id}/options`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ optionText: 'Continue', nextStepId: afterTargetId }),
              })
            }
          } else if (!newStep.buttonConfig?.nextStepId) {
            await fetch(`/api/steps/${newStep.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                buttonConfig: {
                  ...(newStep.buttonConfig ?? {}),
                  enabled: true,
                  text: newStep.buttonConfig?.text || 'Continue',
                  nextStepId: afterTargetId,
                },
              }),
            })
          }
        }

        // Before: re-point the source connection to the new step
        if (info.kind === 'option') {
          await fetch(`/api/options/${info.optionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nextStepId: newStep.id }),
          })
        } else if (info.kind === 'button') {
          const sourceStep = flow?.steps.find((s) => s.id === info.fromStepId)
          await fetch(`/api/steps/${info.fromStepId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              buttonConfig: {
                ...(sourceStep?.buttonConfig ?? { enabled: true, text: 'Continue' }),
                nextStepId: newStep.id,
              },
            }),
          })
        } else if (info.kind === 'end') {
          // The original "last step" is no longer last — wire it explicitly to
          // the new step via buttonConfig (or an option for question types) so
          // the player still moves forward to the new last step.
          const sourceStep = flow?.steps.find((s) => s.id === info.fromStepId)
          if (sourceStep?.stepType === 'question') {
            await fetch(`/api/steps/${info.fromStepId}/options`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ optionText: 'Continue', nextStepId: newStep.id }),
            })
          } else {
            await fetch(`/api/steps/${info.fromStepId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                buttonConfig: {
                  ...(sourceStep?.buttonConfig ?? { enabled: true, text: 'Continue' }),
                  nextStepId: newStep.id,
                },
              }),
            })
          }
        }
        // For 'start' insert: no source wiring needed (Start is implicit
        // because new step is now the first by stepOrder).

        setPendingArrowInsertion(null)
      }

      await fetchFlow()
      setSelectedStepId(newStep.id)
    }
  }

  const addStep = () => {
    setAddStepType(null)
    setAddStepTitle('')
    setAddStepVideoId('')
    setAddStepQuestion('')
    setAddStepOptions([{ text: '', nextStepId: null }, { text: '', nextStepId: null }])
    setAddStepQuestionType('single')
    setAddStepInfoText('')
    setAddStepImageUrl(null)
    setAddStepButtonEnabled(false)
    setAddStepButtonText('Continue')
    setAddStepButtonNextStepId(null)
    setUploadingImage(false)
    setAddStepFormFields([
      { id: 'name', label: 'Full Name', type: 'text', required: true, enabled: true, isBuiltIn: true },
      { id: 'email', label: 'Email', type: 'email', required: true, enabled: true, isBuiltIn: true },
      { id: 'phone', label: 'Phone', type: 'phone', required: false, enabled: true, isBuiltIn: true },
    ])
    setShowAddStepModal(true)
  }

  const handleStepVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('video/')) return
    setUploadingStepVideo(true)
    setStepVideoProgress(5)
    try {
      const result = await startUpload(file, 'interview')
      setStepVideoProgress(100)
      if (result.videoId) {
        setAddStepVideoId(result.videoId)
        setVideos(prev => [{ id: result.videoId, filename: result.filename, url: '', displayName: null }, ...prev])
        if (!autoTitleEnabled && !addStepTitle) setAddStepTitle(file.name.replace(/\.[^.]+$/, ''))
        // Auto-generate title from transcript if toggle is on
        if (autoTitleEnabled) generateTitleFromVideo(result.videoId)
      }
    } catch {}
    setUploadingStepVideo(false)
    if (stepVideoInputRef.current) stepVideoInputRef.current.value = ''
  }

  const generateTitleFromVideo = async (videoId: string) => {
    try {
      // First check if video already has a displayName
      const vidRes = await fetch(`/api/videos/${videoId}`)
      if (vidRes.ok) {
        const vid = await vidRes.json()
        if (vid.displayName) { setAddStepTitle(vid.displayName); return }
        if (vid.transcript) {
          // Generate title from existing transcript
          const titleRes = await fetch('/api/ai/generate-title', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcript: vid.transcript, summary: vid.summary, bulletPoints: vid.bulletPoints?.join(', ') }),
          })
          if (titleRes.ok) { const { title } = await titleRes.json(); if (title) setAddStepTitle(title) }
          return
        }
      }
      // If no transcript yet, wait for analysis then generate
      setAddStepTitle('Generating title...')
      const analyzeRes = await fetch(`/api/videos/${videoId}/analyze`, { method: 'POST' })
      if (analyzeRes.ok) {
        const data = await analyzeRes.json()
        if (data.displayName) setAddStepTitle(data.displayName)
        else if (data.transcript) {
          const titleRes = await fetch('/api/ai/generate-title', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcript: data.transcript, summary: data.summary }),
          })
          if (titleRes.ok) { const { title } = await titleRes.json(); if (title) setAddStepTitle(title) }
        }
      }
    } catch { /* keep whatever title we have */ }
  }

  const submitAddStep = () => {
    if (!addStepType) return
    // Validate title
    if (!addStepTitle.trim() && !autoTitleEnabled) {
      setTitleWarning(true)
      return
    }
    // Check for duplicate title
    const config: Record<string, unknown> = {}

    // Auto-generate title from content
    const existingTitles = flow?.steps.map(s => s.title.toLowerCase()) || []
    const makeUnique = (base: string) => {
      let title = base
      let n = 2
      while (existingTitles.includes(title.toLowerCase())) {
        title = `${base} ${n}`
        n++
      }
      return title
    }

    let finalTitle = ''
    if (addStepType === 'submission') {
      const videoName = addStepVideoId ? (videos.find(v => v.id === addStepVideoId)?.displayName || videos.find(v => v.id === addStepVideoId)?.filename?.replace(/\.[^.]+$/, '') || '') : ''
      finalTitle = addStepTitle.trim() || videoName || 'Video'
    } else if (addStepType === 'question') {
      const questionTitle = addStepQuestion.trim() ? addStepQuestion.trim().slice(0, 60) + (addStepQuestion.trim().length > 60 ? '...' : '') : ''
      finalTitle = addStepTitle.trim() || questionTitle || 'Question'
    } else if (addStepType === 'form') {
      finalTitle = addStepTitle.trim() || 'Application Form'
    } else if (addStepType === 'info') {
      finalTitle = addStepTitle.trim() || 'Welcome'
    } else if (addStepType === 'capture') {
      const promptSnippet = addStepCapturePrompt.trim() ? addStepCapturePrompt.trim().slice(0, 50) : ''
      finalTitle = addStepTitle.trim() || promptSnippet || 'Audio answer'
    }
    finalTitle = makeUnique(finalTitle)
    setTitleWarning(false)

    const buttonNext = addStepButtonNextStepId
    const buttonConfigBase = (): Record<string, unknown> => ({
      enabled: true,
      text: addStepButtonText || 'Continue',
      ...(buttonNext != null && { nextStepId: buttonNext }),
    })

    if (addStepType === 'submission') {
      config.title = finalTitle
      config.videoId = addStepVideoId || undefined
      if (addStepButtonEnabled) config.buttonConfig = buttonConfigBase()
    } else if (addStepType === 'question') {
      config.title = finalTitle
      config.questionText = addStepQuestion
      config.questionType = addStepQuestionType
      config.options = addStepOptions.filter(o => o.text.trim()).map(o => ({ text: o.text, nextStepId: o.nextStepId === '__end__' ? null : o.nextStepId }))
    } else if (addStepType === 'form') {
      config.title = addStepTitle.trim() || 'Application Form'
      config.formConfig = { fields: addStepFormFields }
    } else if (addStepType === 'info') {
      config.title = addStepTitle.trim() || 'Welcome'
      config.infoContent = addStepInfoText
      if (addStepImageUrl) config.formConfig = { imageUrl: addStepImageUrl }
      if (addStepButtonEnabled) config.buttonConfig = buttonConfigBase()
    } else if (addStepType === 'capture') {
      // Build a CaptureConfig draft from form state and run it through the
      // Zod validator before we send. Empty number fields become undefined
      // so the schema doesn't have to deal with NaN.
      const draft: Record<string, unknown> = {
        mode: 'audio',
        prompt: addStepCapturePrompt.trim() || undefined,
        required: addStepCaptureRequired,
        allowRetake: addStepCaptureAllowRetake,
        transcriptionEnabled: false,
        aiAnalysisEnabled: false,
      }
      const minD = parseInt(addStepCaptureMinDuration, 10)
      if (Number.isFinite(minD) && minD > 0) draft.minDurationSec = minD
      const maxD = parseInt(addStepCaptureMaxDuration, 10)
      if (Number.isFinite(maxD) && maxD > 0) draft.maxDurationSec = maxD
      if (addStepCaptureAllowRetake) {
        const r = parseInt(addStepCaptureMaxRetakes, 10)
        if (Number.isFinite(r) && r > 0) draft.maxRetakes = r
      }
      const parsed = validateCaptureConfig(draft)
      if (!parsed.ok) {
        setAddStepCaptureError(parsed.errors.join('; '))
        return
      }
      setAddStepCaptureError(null)
      config.title = finalTitle
      config.captureConfig = parsed.value
    }
    createStep(addStepType, config)
  }

  const updateStep = async (stepId: string, data: Partial<Step>) => {
    markChanged()
    setSaving(true)
    const res = await fetch(`/api/steps/${stepId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (res.ok) {
      const updated = await res.json()
      setFlow((f) =>
        f
          ? {
              ...f,
              steps: f.steps.map((s) => (s.id === stepId ? { ...s, ...updated } : s)),
            }
          : null
      )
    }
    setSaving(false)
  }

  const deleteStep = (stepId: string) => {
    markChanged()

    // Identify steps that reference the deleted one via JSON / non-FK fields,
    // so we can also clear those on the server (DB only auto-clears option.nextStepId).
    const buttonRefStepIds = (flow?.steps ?? [])
      .filter((s) => s.id !== stepId && s.buttonConfig?.nextStepId === stepId)
      .map((s) => s.id)
    const combinedRefStepIds = (flow?.steps ?? [])
      .filter((s) => s.id !== stepId && s.combinedWithId === stepId)
      .map((s) => s.id)

    // Optimistic UI update — remove the step and clear every reference to it
    setFlow((f) =>
      f
        ? {
            ...f,
            steps: f.steps
              .filter((s) => s.id !== stepId)
              .map((s) => ({
                ...s,
                options: s.options.map((o) =>
                  o.nextStepId === stepId ? { ...o, nextStepId: null } : o
                ),
                buttonConfig:
                  s.buttonConfig?.nextStepId === stepId
                    ? { ...s.buttonConfig, nextStepId: null }
                    : s.buttonConfig,
                combinedWithId: s.combinedWithId === stepId ? null : s.combinedWithId,
              })),
          }
        : null
    )
    if (selectedStepId === stepId) setSelectedStepId(null)
    if (popupStepId === stepId) setPopupStepId(null)

    // Server: delete the step (FK SetNull clears option.nextStepId automatically)
    fetch(`/api/steps/${stepId}`, { method: 'DELETE' })

    // Server: clear non-FK references that the DB won't auto-clean
    for (const refId of buttonRefStepIds) {
      const ref = flow?.steps.find((s) => s.id === refId)
      if (!ref) continue
      fetch(`/api/steps/${refId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buttonConfig: { ...(ref.buttonConfig ?? {}), nextStepId: null },
        }),
      })
    }
    for (const refId of combinedRefStepIds) {
      fetch(`/api/steps/${refId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ combinedWithId: null }),
      })
    }
  }

  const changeFirstStep = (newFirstStepId: string) => {
    markChanged()
    if (!flow) return
    const sorted = [...flow.steps].sort((a, b) => a.stepOrder - b.stepOrder)
    if (sorted[0]?.id === newFirstStepId) return

    // Give the new first step order -1 (before all others) instead of swapping
    const minOrder = Math.min(...flow.steps.map((s) => s.stepOrder)) - 1
    setFlow((f) =>
      f
        ? {
            ...f,
            steps: f.steps.map((s) =>
              s.id === newFirstStepId ? { ...s, stepOrder: minOrder } : s
            ),
          }
        : null
    )

    fetch(`/api/steps/${newFirstStepId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepOrder: minOrder }),
    })
  }

  const changeEndStep = (newEndStepId: string) => {
    markChanged()
    if (!flow) return
    const sorted = [...flow.steps].sort((a, b) => a.stepOrder - b.stepOrder)
    if (sorted[sorted.length - 1]?.id === newEndStepId) return

    // Give the new end step order maxOrder + 1 (after all others)
    const maxOrder = Math.max(...flow.steps.map((s) => s.stepOrder)) + 1
    setFlow((f) =>
      f
        ? {
            ...f,
            steps: f.steps.map((s) =>
              s.id === newEndStepId ? { ...s, stepOrder: maxOrder } : s
            ),
          }
        : null
    )

    fetch(`/api/steps/${newEndStepId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepOrder: maxOrder }),
    })
  }

  const addOption = async (stepId: string) => {
    markChanged()
    const res = await fetch(`/api/steps/${stepId}/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionText: 'New Option' }),
    })
    if (res.ok) {
      const newOption = await res.json()
      setFlow((f) =>
        f
          ? {
              ...f,
              steps: f.steps.map((s) =>
                s.id === stepId ? { ...s, options: [...s.options, newOption] } : s
              ),
            }
          : null
      )
    }
  }

  const updateOption = async (
    optionId: string,
    data: { optionText?: string; nextStepId?: string | null }
  ) => {
    markChanged()
    const res = await fetch(`/api/options/${optionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (res.ok) {
      const updated = await res.json()
      setFlow((f) =>
        f
          ? {
              ...f,
              steps: f.steps.map((s) => ({
                ...s,
                options: s.options.map((o) => (o.id === optionId ? { ...o, ...updated } : o)),
              })),
            }
          : null
      )
    }
  }

  const connectSteps = async (fromStepId: string, toStepId: string) => {
    markChanged()
    // Create a new option on the source step pointing to the target
    const res = await fetch(`/api/steps/${fromStepId}/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionText: 'Continue' }),
    })
    if (res.ok) {
      const newOption = await res.json()
      // Set the nextStepId
      await fetch(`/api/options/${newOption.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nextStepId: toStepId }),
      })
      // Optimistic update
      setFlow((f) =>
        f
          ? {
              ...f,
              steps: f.steps.map((s) =>
                s.id === fromStepId
                  ? { ...s, options: [...s.options, { ...newOption, nextStepId: toStepId }] }
                  : s
              ),
            }
          : null
      )
    }
  }

  const updateButtonConfigNext = async (stepId: string, nextStepId: string | null) => {
    if (!flow) return
    markChanged()
    const step = flow.steps.find((s) => s.id === stepId)
    const newButton = {
      ...(step?.buttonConfig ?? { enabled: true, text: 'Continue' }),
      nextStepId,
    }
    setFlow((f) =>
      f
        ? {
            ...f,
            steps: f.steps.map((s) =>
              s.id === stepId ? { ...s, buttonConfig: newButton } : s
            ),
          }
        : null
    )
    await fetch(`/api/steps/${stepId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buttonConfig: newButton }),
    })
  }

  const insertStepOnArrow = (
    info:
      | { kind: 'option'; optionId: string; fromStepId: string; toStepId: string }
      | { kind: 'button'; fromStepId: string; toStepId: string }
      | { kind: 'start'; toStepId: string }
      | { kind: 'end'; fromStepId: string }
  ) => {
    // Stash the connection wiring; open the regular Add Step modal so the
    // user picks the step type. After creation, createStep() applies the wiring.
    setPendingArrowInsertion(info)
    addStep()
  }

  const deleteOption = async (stepId: string, optionId: string) => {
    markChanged()
    await fetch(`/api/options/${optionId}`, { method: 'DELETE' })
    setFlow((f) =>
      f
        ? {
            ...f,
            steps: f.steps.map((s) =>
              s.id === stepId
                ? { ...s, options: s.options.filter((o) => o.id !== optionId) }
                : s
            ),
          }
        : null
    )
  }

  const updateFlow = async (data: { startMessage?: string; endMessage?: string }) => {
    markChanged()
    setSaving(true)
    const res = await fetch(`/api/flows/${flowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (res.ok) {
      const updated = await res.json()
      setFlow((f) => (f ? { ...f, ...updated } : null))
    }
    setSaving(false)
  }

  // Debounced save of the schema-view canvas layout. Fires from the schema
  // view after every drag-end with the full positions map; we only push to
  // the server once the user pauses for 400ms so a series of drags doesn't
  // spam the API.
  const savePositionsTimerRef = useRef<NodeJS.Timeout | null>(null)
  const savePositions = (positions: Record<string, { x: number; y: number }>) => {
    setFlow((f) => (f ? { ...f, canvasLayout: positions } : null))
    if (savePositionsTimerRef.current) clearTimeout(savePositionsTimerRef.current)
    savePositionsTimerRef.current = setTimeout(() => {
      fetch(`/api/flows/${flowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasLayout: positions }),
      }).catch(() => {})
    }, 400)
  }

  const handleCancel = () => {
    // Reload from server to discard local changes
    fetchFlow()
    setHasChanges(false)
    setPopupStepId(null)
  }

  const handleSave = () => {
    // All changes are already persisted via individual API calls
    setHasChanges(false)
  }

  const handlePublish = async () => {
    const res = await fetch(`/api/flows/${flowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: true }),
    })
    if (res.ok) {
      setFlow((f) => (f ? { ...f, isPublished: true } : null))
      setHasChanges(false)
    }
  }

  const handleUnpublish = async () => {
    const res = await fetch(`/api/flows/${flowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: false }),
    })
    if (res.ok) {
      setFlow((f) => (f ? { ...f, isPublished: false } : null))
    }
  }

  const copyShareLink = () => {
    if (!flow) return
    const url = `${window.location.origin}/f/${flow.slug}`
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!flow) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  // --- Shared editor content for Start/End screens ---
  const renderButtonConfig = (step: Step) => {
    const btnCfg = (step as any).buttonConfig as { enabled?: boolean; text?: string; nextStepId?: string | null } | null | undefined
    const isEnabled = btnCfg?.enabled ?? false
    const updateBtnConfig = (updates: Record<string, unknown>) => {
      const newCfg = { ...(btnCfg || {}), enabled: true, text: btnCfg?.text || 'Continue', ...updates }
      updateStep(step.id, { buttonConfig: newCfg } as any)
    }
    return (
      <div className="border-t border-surface-border pt-4 mt-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-grey-20">Action Button</label>
          <button
            onClick={() => updateStep(step.id, { buttonConfig: { ...(btnCfg || {}), enabled: !isEnabled, text: btnCfg?.text || 'Continue' } } as any)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${isEnabled ? 'bg-[#FF9500]' : 'bg-gray-300'}`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {isEnabled && (
          <div className="space-y-2">
            <input
              key={`btn-${step.id}`}
              type="text"
              defaultValue={btnCfg?.text || 'Continue'}
              onBlur={(e) => updateBtnConfig({ text: e.target.value })}
              placeholder="Button text"
              className="w-full px-4 py-2.5 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <select
              value={btnCfg?.nextStepId || ''}
              onChange={(e) => updateBtnConfig({ nextStepId: e.target.value || null })}
              className="w-full px-3 py-1.5 text-xs border border-surface-border rounded-[8px] text-grey-40 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="">→ Next step (auto)</option>
              <option value="__end__">→ End</option>
              {[...(flow?.steps ?? [])]
                .sort((a, b) => a.stepOrder - b.stepOrder)
                .map((s, i) => ({ s, idx: i + 1 }))
                .filter(({ s }) => s.id !== step.id)
                .map(({ s, idx }) => (
                  <option key={s.id} value={s.id}>→ {idx}. {s.title}</option>
                ))}
            </select>
          </div>
        )}
      </div>
    )
  }

  const renderCombineConfig = (step: Step) => {
    const forwardId = step.combinedWithId || null
    const reverseStep = flow?.steps.find(s => s.combinedWithId === step.id) || null
    const combinedId = forwardId || reverseStep?.id || null
    const isCombined = !!combinedId
    const otherSteps = flow?.steps.filter(s =>
      s.id !== step.id
      && !s.combinedWithId
      && !flow.steps.some(o => o.combinedWithId === s.id)
    ) || []

    return (
      <div className="border-t border-surface-border pt-4 mt-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-grey-20">Combine with</label>
          <button
            onClick={() => {
              if (isCombined || combineEnabled) {
                // Turn off — separate (clear both directions of the relationship)
                setCombineEnabled(false)
                if (forwardId) updateStep(step.id, { combinedWithId: null } as any)
                if (reverseStep) updateStep(reverseStep.id, { combinedWithId: null } as any)
              } else {
                // Turn on — show dropdown
                setCombineEnabled(true)
              }
            }}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${(isCombined || combineEnabled) ? 'bg-[#FF9500]' : 'bg-gray-300'}`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${(isCombined || combineEnabled) ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {(combineEnabled && !isCombined) && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value === '__create__') { setCombineEnabled(false); setCombineAfterCreateId(step.id); addStep(); return }
              if (e.target.value) { updateStep(step.id, { combinedWithId: e.target.value } as any); setCombineEnabled(false) }
            }}
            className="w-full px-3 py-2 text-sm border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="">Select step to combine with...</option>
            {(() => {
              const groups = [
                { type: 'submission', label: 'Video' },
                { type: 'question', label: 'Question' },
                { type: 'form', label: 'Form' },
                { type: 'info', label: 'Screen' },
              ]
              return groups.map(g => {
                const groupSteps = otherSteps.filter(s => s.stepType === g.type)
                if (groupSteps.length === 0) return null
                return (
                  <optgroup key={g.type} label={g.label}>
                    {groupSteps.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </optgroup>
                )
              })
            })()}
            <optgroup label="—">
              <option value="__create__">+ Create new step...</option>
            </optgroup>
          </select>
        )}
        {isCombined && (() => {
          const partner = flow?.steps.find(s => s.id === combinedId)
          return partner ? (
            <div className="flex items-center gap-2 p-2.5 bg-brand-50 rounded-[8px] border border-brand-200">
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-brand-100 text-brand-600">
                {partner.stepType === 'submission' ? 'Video' : partner.stepType === 'question' ? 'Question' : partner.stepType === 'form' ? 'Form' : partner.stepType === 'capture' ? 'Audio Answer' : 'Screen'}
              </span>
              <span className="text-sm text-grey-15 flex-1 truncate">{partner.title}</span>
            </div>
          ) : null
        })()}
      </div>
    )
  }

  const renderScreenEditor = (type: 'start' | 'end') => {
    const message = type === 'start' ? flow.startMessage : flow.endMessage
    const setMessage = (val: string) => updateFlow(type === 'start' ? { startMessage: val } : { endMessage: val })
    const branding = (flow.branding as Record<string, unknown>) || {}
    const screenKey = type === 'start' ? 'startScreenImage' : 'endScreenImage'
    const imageUrl = (branding as Record<string, string>)[screenKey] || null

    const uploadImage = async (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/uploads/logo', { method: 'POST', body: formData })
      if (res.ok) {
        const { url } = await res.json()
        updateFlow({ branding: { ...branding, [screenKey]: url } } as any)
      }
    }

    return (
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-grey-20 mb-1.5">
            {type === 'start' ? 'Welcome Message' : 'Completion Message'}
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            placeholder={type === 'start' ? 'Welcome! Please complete the following steps.' : 'Thank you for your participation!'}
            className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-grey-20 mb-1.5">Background Image (optional)</label>
          {imageUrl ? (
            <div className="relative rounded-[8px] overflow-hidden">
              <img src={imageUrl} alt="" className="w-full h-32 object-cover rounded-[8px]" />
              <button
                onClick={() => updateFlow({ branding: { ...branding, [screenKey]: null } } as any)}
                className="absolute top-2 right-2 w-6 h-6 bg-black/50 text-white rounded-full text-xs flex items-center justify-center hover:bg-black/70"
              >&times;</button>
            </div>
          ) : (
            <label className="block w-full p-4 border-2 border-dashed border-surface-divider rounded-[8px] text-center cursor-pointer hover:border-brand-400">
              <svg className="w-8 h-8 mx-auto text-grey-50 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              <span className="text-xs text-grey-40">Upload image</span>
              <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f) }} />
            </label>
          )}
        </div>
        {/* Start screen fields config */}
        {type === 'start' && (() => {
          const startConfig = (branding as Record<string, unknown>).startScreenConfig as {
            showNameField?: boolean
            showEmailField?: boolean
            showPhoneField?: boolean
            buttonText?: string
            nameRequired?: boolean
            emailRequired?: boolean
          } | null || {}
          const updateStartConfig = (updates: Record<string, unknown>) => {
            updateFlow({ branding: { ...branding, startScreenConfig: { ...startConfig, ...updates } } } as any)
          }
          return (
            <div className="border-t border-surface-border pt-4 space-y-3">
              <label className="text-sm font-medium text-grey-20 block">Fields on Start Screen</label>
              {[
                { key: 'showNameField', label: 'Name', reqKey: 'nameRequired', default: true },
                { key: 'showEmailField', label: 'Email', reqKey: 'emailRequired', default: false },
                { key: 'showPhoneField', label: 'Phone', reqKey: null, default: false },
              ].map(({ key, label, reqKey, default: def }) => {
                const isOn = (startConfig as Record<string, unknown>)[key] ?? def
                return (
                  <div key={key} className="flex items-center gap-3 p-3 rounded-[8px] border border-surface-border">
                    <button
                      onClick={() => updateStartConfig({ [key]: !isOn })}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${isOn ? 'bg-[#FF9500]' : 'bg-gray-300'}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${isOn ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                    <span className="text-sm text-grey-15 flex-1">{label}</span>
                    {reqKey && isOn && (
                      <label className="flex items-center gap-1.5 text-xs text-grey-40">
                        <input type="checkbox" checked={(startConfig as Record<string, unknown>)[reqKey] as boolean ?? false} onChange={() => updateStartConfig({ [reqKey]: !(startConfig as Record<string, unknown>)[reqKey] })} className="rounded accent-[#FF9500]" />
                        Required
                      </label>
                    )}
                  </div>
                )
              })}
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Button Text</label>
                <input
                  type="text"
                  defaultValue={(startConfig as Record<string, unknown>).buttonText as string || 'Start'}
                  onBlur={(e) => updateStartConfig({ buttonText: e.target.value })}
                  placeholder="Start"
                  className="w-full px-4 py-2.5 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
          )
        })()}

        {/* End screen button */}
        {type === 'end' && (
          <div className="border-t border-surface-border pt-4">
            <label className="block text-sm font-medium text-grey-20 mb-1.5">Button Text (optional)</label>
            <input
              type="text"
              defaultValue={((branding as Record<string, unknown>).endButtonText as string) || ''}
              onBlur={(e) => updateFlow({ branding: { ...branding, endButtonText: e.target.value } } as any)}
              placeholder="e.g. Visit our website"
              className="w-full px-4 py-2.5 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        )}
      </div>
    )
  }

  const renderStartEditor = () => renderScreenEditor('start')

  const renderEndEditor = () => renderScreenEditor('end')

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 pb-4 border-b">
        <div className="flex items-center space-x-4">
          <Link href="/dashboard/flows" className="text-gray-500 hover:text-gray-700">
            &larr; Back
          </Link>
          <h1 className="text-xl font-bold text-gray-900">{flow.name}</h1>
        </div>
        <div className="flex items-center space-x-3">
          <div className="flex rounded-md border border-gray-300 overflow-hidden">
            <button
              onClick={() => setViewMode('editor')}
              className={`px-3 py-1.5 text-sm ${
                viewMode === 'editor'
                  ? 'bg-brand-500 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Editor
            </button>
            <button
              onClick={() => setViewMode('schema')}
              className={`px-3 py-1.5 text-sm ${
                viewMode === 'schema'
                  ? 'bg-brand-500 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Schema
            </button>
            <button
              onClick={() => setViewMode('branding')}
              className={`px-3 py-1.5 text-sm ${
                viewMode === 'branding'
                  ? 'bg-brand-500 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Branding
            </button>
          </div>
          <button
            onClick={() => window.open(`/f/${flow.slug}?preview=true`, '_blank')}
            className="px-3 py-1.5 text-sm border border-purple-300 text-purple-600 rounded-md hover:bg-purple-50"
          >
            Preview
          </button>
          <button
            onClick={copyShareLink}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
          >
            {copied ? 'Copied!' : 'Copy Link'}
          </button>

          {/* Status badge */}
          <span
            className={`px-3 py-1.5 text-sm rounded-md ${
              flow.isPublished
                ? 'bg-green-100 text-green-700'
                : hasChanges
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-gray-100 text-gray-700'
            }`}
          >
            {flow.isPublished ? 'Published' : hasChanges ? 'Unsaved changes' : 'Draft'}
          </span>

          {/* Action buttons */}
          {hasChanges ? (
            <>
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                className="px-3 py-1.5 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900"
              >
                Save
              </button>
              <button
                onClick={handlePublish}
                className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded-md hover:bg-brand-600"
              >
                Publish
              </button>
            </>
          ) : flow.isPublished ? (
            <button
              onClick={handleUnpublish}
              className="px-3 py-1.5 text-sm border border-red-200 text-red-600 rounded-md hover:bg-red-50"
            >
              Unpublish
            </button>
          ) : (
            <button
              onClick={handlePublish}
              className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded-md hover:bg-brand-600"
            >
              Publish
            </button>
          )}
        </div>
      </div>

      {viewMode === 'branding' ? (
        <div className="flex-1 min-h-0 p-4 overflow-y-auto">
          <BrandingEditor
            branding={flow.branding as Partial<BrandingConfig> | null}
            onUpdate={(branding) => {
              fetch(`/api/flows/${flow.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ branding }),
              }).then(() => fetchFlow())
            }}
            flowName={flow.name}
            startMessage={flow.startMessage}
            endMessage={flow.endMessage}
          />
        </div>
      ) : viewMode === 'schema' ? (
        <div className="flex-1" style={{ minHeight: '500px' }}>
          <FlowSchemaView
            steps={flow.steps}
            startMessage={flow.startMessage}
            endMessage={flow.endMessage}
            selectedStepId={popupStepId || selectedStepId}
            onStepClick={(stepId) => {
              // Don't activate removed screens
              if (stepId === '__start__' && flow.startMessage === '') return
              if (stepId === '__end__' && flow.endMessage === '') return

              if (selectedStepId === stepId) {
                // Clicking the already-active card opens the editor.
                setPopupStepId(stepId)
                setModalPos({ x: 0, y: 0 })
                setCombineEnabled(false)
              } else {
                // First click activates the card so it can be dragged.
                setSelectedStepId(stepId)
                setCombineEnabled(false)
              }
            }}
            onStepPreview={(stepId) => {
              if (stepId === '__start__' && flow.startMessage === '') return
              if (stepId === '__end__' && flow.endMessage === '') return
              // Double-click also opens the editor.
              setSelectedStepId(stepId)
              setPopupStepId(stepId)
              setModalPos({ x: 0, y: 0 })
              setCombineEnabled(false)
              setPreviewStepId(null)
            }}
            onDeleteStep={(stepId) => {
              deleteStep(stepId)
              setPopupStepId(null)
            }}
            onOptionUpdate={(optionId, data) => {
              updateOption(optionId, data)
            }}
            onConnectSteps={connectSteps}
            onChangeFirstStep={changeFirstStep}
            onChangeEndStep={changeEndStep}
            onAddStep={addStep}
            onInsertStepOnArrow={insertStepOnArrow}
            onButtonConfigUpdate={updateButtonConfigNext}
            onClearStartScreen={() => updateFlow({ startMessage: '' })}
            onClearEndScreen={() => updateFlow({ endMessage: '' })}
            initialPositions={flow.canvasLayout ?? null}
            onPositionsChange={savePositions}
          />

          {/* Popup editor overlay — key forces re-render on flow change */}
          {popupStepId && (
            <div
              key={`popup-${popupStepId}-${flow.steps.map(s => s.title).join(',')}`}
              className="absolute inset-0 flex items-center justify-center z-30 bg-black/30 backdrop-blur-[2px]"
            >
              <div
                className="bg-white rounded-[12px] shadow-2xl border border-surface-border w-full max-w-[480px] max-h-[85vh] overflow-y-auto p-5"
                style={{ cursor: isDraggingModal ? 'grabbing' : 'default', transform: `translate(${modalPos.x}px, ${modalPos.y}px)` }}
                onClick={(e) => e.stopPropagation()}
              >
                <div
                  className="flex items-center justify-between mb-4 cursor-grab active:cursor-grabbing select-none"
                  onMouseDown={(e) => {
                    setIsDraggingModal(true)
                    modalDragStart.current = { x: e.clientX, y: e.clientY, startX: modalPos.x, startY: modalPos.y }
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-brand-50 text-brand-500">
                      {popupStepId === '__start__' ? 'Start' :
                       popupStepId === '__end__' ? 'End' :
                       popupStep?.stepType === 'submission' ? 'Video' :
                       popupStep?.stepType === 'question' ? 'Question' :
                       popupStep?.stepType === 'form' ? 'Form' :
                       popupStep?.stepType === 'info' ? 'Screen' :
                       popupStep?.stepType === 'capture' ? 'Audio Answer' : 'Step'}
                    </span>
                    {popupStepId === '__start__' && (
                      <span className="text-lg font-semibold text-grey-15">Start Screen</span>
                    )}
                    {popupStepId === '__end__' && (
                      <span className="text-lg font-semibold text-grey-15">End Screen</span>
                    )}
                    {popupStep && (
                      <input
                        key={`popup-title-${popupStep.id}`}
                        type="text"
                        defaultValue={popupStep.title}
                        onBlur={(e) => { if (e.target.value !== popupStep.title) updateStep(popupStep.id, { title: e.target.value }) }}
                        className="text-lg font-semibold text-grey-15 bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-brand-400 focus:bg-brand-50 rounded px-1"
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {popupStepId === '__start__' && (
                      <button onClick={() => { updateFlow({ startMessage: '' }); setPopupStepId(null) }} className="text-xs text-brand-500 hover:text-brand-600">Remove</button>
                    )}
                    {popupStepId === '__end__' && (
                      <button onClick={() => { updateFlow({ endMessage: '' }); setPopupStepId(null) }} className="text-xs text-brand-500 hover:text-brand-600">Remove</button>
                    )}
                    {popupStep && (
                      <button onClick={() => { deleteStep(popupStep.id); setPopupStepId(null) }} className="text-xs text-brand-500 hover:text-brand-600">Delete</button>
                    )}
                    <button onClick={() => setPopupStepId(null)} className="text-grey-40 hover:text-grey-15 text-xl leading-none">&times;</button>
                  </div>
                </div>

                {popupStepId === '__start__' ? (
                  renderStartEditor()
                ) : popupStepId === '__end__' ? (
                  renderEndEditor()
                ) : popupStep ? (
                  <div className="space-y-4">
                    {/* === VIDEO STEP === */}
                    {popupStep.stepType === 'submission' && (
                      <div className="space-y-4">
                        {/* Video select + upload */}
                        <div>
                          <label className="block text-sm font-medium text-grey-20 mb-1.5">Video</label>
                          <div className="flex gap-2">
                            <select
                              value={popupStep.videoId || ''}
                              onChange={(e) => updateStep(popupStep.id, { videoId: e.target.value || null })}
                              className="flex-1 px-4 py-2.5 text-sm border border-surface-border rounded-[8px] focus:outline-none focus:ring-2 focus:ring-brand-500"
                            >
                              <option value="">Select video...</option>
                              {videos.map(v => <option key={v.id} value={v.id}>{videoLabel(v)}</option>)}
                            </select>
                            <label className="px-4 py-2.5 text-xs font-medium bg-brand-50 text-brand-600 border border-brand-200 rounded-[8px] hover:bg-brand-100 cursor-pointer">
                              Upload
                              <input type="file" accept="video/*" className="hidden" onChange={async (e) => {
                                const file = e.target.files?.[0]; if (!file) return
                                const result = await startUpload(file, 'interview')
                                if (result.videoId) {
                                  setVideos(prev => [{ id: result.videoId, filename: result.filename, url: '', displayName: null }, ...prev])
                                  updateStep(popupStep.id, { videoId: result.videoId })
                                }
                              }} />
                            </label>
                          </div>
                        </div>
                        {/* Video preview — hide when preview modal is open */}
                        {popupStep.video?.url && !previewStepId && (
                          <video src={popupStep.video.url} controls className="w-full rounded-[8px] max-h-[50vh] object-contain" />
                        )}
                        {renderButtonConfig(popupStep)}
                        {renderCombineConfig(popupStep)}
                      </div>
                    )}

                    {/* === QUESTION STEP === */}
                    {popupStep.stepType === 'question' && (
                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-grey-20 mb-1.5">Question</label>
                          <textarea
                            key={`q-${popupStep.id}`}
                            defaultValue={popupStep.questionText || ''}
                            onBlur={(e) => updateStep(popupStep.id, { questionText: e.target.value })}
                            rows={2}
                            placeholder="e.g. What experience do you have?"
                            className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-grey-20 mb-1.5">Question Type</label>
                          <div className="grid grid-cols-3 gap-2">
                            {[{ v: 'single', l: 'Single Choice' }, { v: 'multiselect', l: 'Multi Choice' }, { v: 'yesno', l: 'Yes / No' }].map(({ v, l }) => (
                              <button key={v} onClick={() => updateStep(popupStep.id, { questionType: v })} className={`py-2 text-xs rounded-[8px] border font-medium ${popupStep.questionType === v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-35'}`}>{l}</button>
                            ))}
                          </div>
                        </div>
                        {/* Options */}
                        {popupStep.questionType !== 'yesno' && (
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <label className="text-sm font-medium text-grey-20">Answer Options</label>
                              <button onClick={() => addOption(popupStep.id)} className="text-xs text-brand-500 hover:text-brand-600 font-medium">+ Add option</button>
                            </div>
                            <div className="space-y-2">
                              {popupStep.options.map((opt) => (
                                <div key={opt.id} className="space-y-1.5">
                                  <div className="flex items-center gap-2">
                                    <input
                                      key={`opt-${opt.id}`}
                                      type="text"
                                      defaultValue={opt.optionText}
                                      onBlur={(e) => updateOption(opt.id, { optionText: e.target.value })}
                                      placeholder="Option text"
                                      className="flex-1 px-3 py-2.5 text-sm border border-surface-border rounded-[8px] focus:outline-none focus:ring-2 focus:ring-brand-500"
                                    />
                                    <button onClick={() => deleteOption(popupStep.id, opt.id)} className="text-brand-400 hover:text-brand-600 text-lg">&times;</button>
                                  </div>
                                  <select
                                    value={opt.nextStepId || ''}
                                    onChange={(e) => updateOption(opt.id, { nextStepId: e.target.value === '__end__' ? null : (e.target.value || null) })}
                                    className="w-full px-3 py-1.5 text-xs border border-surface-border rounded-[8px] text-grey-40 focus:outline-none focus:ring-1 focus:ring-brand-500"
                                  >
                                    <option value="">→ Next step (auto)</option>
                                    <option value="__end__">→ End</option>
                                    {[...flow.steps]
                                      .sort((a, b) => a.stepOrder - b.stepOrder)
                                      .map((s, i) => ({ s, idx: i + 1 }))
                                      .filter(({ s }) => s.id !== popupStep.id)
                                      .map(({ s, idx }) => (
                                        <option key={s.id} value={s.id}>→ {idx}. {s.title}</option>
                                      ))}
                                  </select>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {renderCombineConfig(popupStep)}
                      </div>
                    )}

                    {/* === FORM STEP === */}
                    {popupStep.stepType === 'form' && (() => {
                      const formConfig = (popupStep.formConfig as { fields: Array<{ id: string; label: string; type: string; required: boolean; enabled: boolean; isBuiltIn?: boolean }> }) || { fields: [
                        { id: 'name', label: 'Full Name', type: 'text', required: true, enabled: true, isBuiltIn: true },
                        { id: 'email', label: 'Email', type: 'email', required: true, enabled: true, isBuiltIn: true },
                        { id: 'phone', label: 'Phone', type: 'phone', required: false, enabled: true, isBuiltIn: true },
                      ] }
                      const updateFormFields = (fields: typeof formConfig.fields) => {
                        updateStep(popupStep.id, { formConfig: { fields } } as any)
                      }
                      return (
                        <div className="space-y-4">
                          <div>
                            <label className="block text-sm font-medium text-grey-20 mb-2">Fields</label>
                            <div className="space-y-2">
                              {formConfig.fields.map((field, i) => (
                                <div key={field.id} className="p-3 rounded-[8px] border border-surface-border space-y-2">
                                  <div className="flex items-center gap-3">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                      <input type="checkbox" checked={field.enabled} onChange={() => { const n = [...formConfig.fields]; n[i] = { ...n[i], enabled: !n[i].enabled }; updateFormFields(n) }} className="rounded accent-[#FF9500]" />
                                    </label>
                                    {field.isBuiltIn ? (
                                      <span className="text-sm text-grey-15 flex-1">{field.label}</span>
                                    ) : (
                                      <input
                                        key={`field-label-${field.id}-${popupStep.id}`}
                                        type="text"
                                        defaultValue={field.label}
                                        onBlur={(e) => { if (e.target.value !== field.label) { const n = [...formConfig.fields]; n[i] = { ...n[i], label: e.target.value }; updateFormFields(n) } }}
                                        placeholder="Field name"
                                        className="flex-1 px-2 py-1 text-sm border border-surface-border rounded-[8px] focus:outline-none focus:ring-1 focus:ring-brand-500"
                                      />
                                    )}
                                    <label className="flex items-center gap-1.5 text-xs text-grey-40">
                                      <input type="checkbox" checked={field.required} onChange={() => { const n = [...formConfig.fields]; n[i] = { ...n[i], required: !n[i].required }; updateFormFields(n) }} className="rounded accent-[#FF9500]" />
                                      Required
                                    </label>
                                    {!field.isBuiltIn && (
                                      <button onClick={() => updateFormFields(formConfig.fields.filter((_, j) => j !== i))} className="text-brand-400 hover:text-brand-600 text-lg">&times;</button>
                                    )}
                                  </div>
                                  {!field.isBuiltIn && (
                                    <div className="flex gap-1 ml-7">
                                      {[
                                        { value: 'text', label: 'Text' },
                                        { value: 'radio', label: 'Radio' },
                                        { value: 'multiselect', label: 'Multi' },
                                        { value: 'button', label: 'Button' },
                                      ].map(t => (
                                        <button key={t.value} onClick={() => { const n = [...formConfig.fields]; n[i] = { ...n[i], type: t.value }; updateFormFields(n) }} className={`px-2.5 py-1 text-[10px] rounded-[6px] border font-medium ${field.type === t.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-40'}`}>
                                          {t.label}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  {!field.isBuiltIn && (field.type === 'radio' || field.type === 'multiselect' || field.type === 'button') && (
                                    <div className="ml-7 space-y-1">
                                      {((field as any).options || ['Option 1', 'Option 2']).map((opt: string, j: number) => (
                                        <div key={j} className="flex gap-1">
                                          <input
                                            key={`opt-${field.id}-${j}`}
                                            type="text"
                                            defaultValue={opt}
                                            onBlur={(e) => {
                                              const n = [...formConfig.fields]
                                              const opts = [...((n[i] as any).options || ['Option 1', 'Option 2'])]
                                              opts[j] = e.target.value
                                              n[i] = { ...n[i], options: opts } as any
                                              updateFormFields(n)
                                            }}
                                            placeholder={`Option ${j + 1}`}
                                            className="flex-1 px-2 py-1 text-xs border border-surface-border rounded-[6px] focus:outline-none focus:ring-1 focus:ring-brand-500"
                                          />
                                          {((field as any).options || []).length > 2 && (
                                            <button onClick={() => {
                                              const n = [...formConfig.fields]
                                              const opts = [...((n[i] as any).options || [])].filter((_: any, k: number) => k !== j)
                                              n[i] = { ...n[i], options: opts } as any
                                              updateFormFields(n)
                                            }} className="text-grey-50 hover:text-red-500 text-xs">&times;</button>
                                          )}
                                        </div>
                                      ))}
                                      <button onClick={() => {
                                        const n = [...formConfig.fields]
                                        const opts = [...((n[i] as any).options || ['Option 1', 'Option 2']), '']
                                        n[i] = { ...n[i], options: opts } as any
                                        updateFormFields(n)
                                      }} className="text-[10px] text-brand-500 hover:text-brand-600">+ Add option</button>
                                    </div>
                                  )}
                                </div>
                              ))}
                              <button onClick={() => updateFormFields([...formConfig.fields, { id: `custom_${Date.now()}`, label: 'Custom Field', type: 'text', required: false, enabled: true, isBuiltIn: false }])} className="text-xs text-brand-500 hover:text-brand-600 font-medium">+ Add custom field</button>
                            </div>
                          </div>
                          {renderButtonConfig(popupStep)}
                        {renderCombineConfig(popupStep)}
                        </div>
                      )
                    })()}

                    {/* === INFO/SCREEN STEP === */}
                    {/* === CAPTURE STEP (audio answer) === */}
                    {popupStep.stepType === 'capture' && (
                      <CaptureStepConfigPanel
                        stepId={popupStep.id}
                        captureConfig={(popupStep as any).captureConfig}
                        onPatch={(cfg) => updateStep(popupStep.id, { captureConfig: cfg } as any)}
                        onValidityChange={(invalid) => setCapturePanelInvalid(invalid)}
                      />
                    )}

                    {popupStep.stepType === 'info' && (
                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-grey-20 mb-1.5">Content</label>
                          <textarea
                            key={`info-${popupStep.id}`}
                            defaultValue={popupStep.infoContent || ''}
                            onBlur={(e) => updateStep(popupStep.id, { infoContent: e.target.value })}
                            rows={6}
                            placeholder="Instructions, welcome message, or any information..."
                            className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-grey-20 mb-1.5">Background Image (optional)</label>
                          {(popupStep.formConfig as any)?.imageUrl ? (
                            <div className="relative rounded-[8px] overflow-hidden">
                              <img src={(popupStep.formConfig as any).imageUrl} alt="" className="w-full h-32 object-cover rounded-[8px]" />
                              <button
                                onClick={() => updateStep(popupStep.id, { formConfig: { imageUrl: null } } as any)}
                                className="absolute top-2 right-2 w-6 h-6 bg-black/50 text-white rounded-full text-xs flex items-center justify-center hover:bg-black/70"
                              >&times;</button>
                            </div>
                          ) : (
                            <label className="block w-full p-4 border-2 border-dashed border-surface-divider rounded-[8px] text-center cursor-pointer hover:border-brand-400">
                              <svg className="w-8 h-8 mx-auto text-grey-50 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                              <span className="text-xs text-grey-40">Upload image</span>
                              <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                                const file = e.target.files?.[0]
                                if (!file) return
                                const formData = new FormData()
                                formData.append('file', file)
                                const res = await fetch('/api/uploads/logo', { method: 'POST', body: formData })
                                if (res.ok) {
                                  const { url } = await res.json()
                                  updateStep(popupStep.id, { formConfig: { imageUrl: url } } as any)
                                }
                              }} />
                            </label>
                          )}
                        </div>
                        {renderButtonConfig(popupStep)}
                        {renderCombineConfig(popupStep)}
                      </div>
                    )}
                  </div>
                ) : null}

                {/* Save / Cancel bar */}
                <div className="mt-6 pt-4 border-t border-surface-border space-y-2">
                  {capturePanelInvalid && (
                    <div className="text-[12px] text-red-600">
                      Fix the highlighted fields before saving.
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button
                      onClick={() => setPopupStepId(null)}
                      className="flex-1 py-2.5 text-sm border border-surface-border rounded-[8px] text-grey-35 hover:bg-surface font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => { fetchFlow(); setPopupStepId(null) }}
                      disabled={capturePanelInvalid}
                      className="flex-1 py-2.5 text-sm bg-brand-500 text-white rounded-[8px] hover:bg-brand-600 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step Preview Modal */}
          {previewStepId && (
            <StepPreviewModal
              previewId={previewStepId}
              step={flow.steps.find((s) => s.id === previewStepId) || null}
              allSteps={flow.steps}
              flowName={flow.name}
              startMessage={flow.startMessage}
              endMessage={flow.endMessage}
              onClose={() => setPreviewStepId(null)}
              onNavigate={(nextId) => {
                setPreviewStepId(nextId)
                setSelectedStepId(nextId)
              }}
            />
          )}
        </div>
      ) : (
        <div className="flex flex-1 gap-4 min-h-0">
          {/* Steps List */}
          <div className="w-64 bg-white rounded-lg shadow p-4 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-gray-900">Steps</h2>
              <button onClick={addStep} className="text-brand-500 hover:text-brand-800 text-sm">
                + Add
              </button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2">
              {/* Start Screen */}
              <button
                onClick={() => setSelectedStepId('__start__')}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                  selectedStepId === '__start__'
                    ? 'bg-green-50 text-green-700 border border-green-200'
                    : 'hover:bg-gray-50 border border-transparent'
                }`}
              >
                <div className="font-medium">Start Screen</div>
                <div className="text-xs text-gray-500">Welcome message</div>
              </button>

              <div className="border-t border-gray-100 my-1" />

              {flow.steps.map((step) => (
                <button
                  key={step.id}
                  onClick={() => setSelectedStepId(step.id)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                    selectedStepId === step.id
                      ? 'bg-brand-50 text-brand-700 border border-brand-200'
                      : 'hover:bg-gray-50 border border-transparent'
                  }`}
                >
                  <div className="font-medium truncate">{step.title}</div>
                  <div className="text-xs text-gray-500">
                    {step.stepType === 'submission' ? (
                      <span className="text-purple-600">Submission</span>
                    ) : step.stepType === 'capture' ? (
                      <span className="text-brand-600">Audio answer</span>
                    ) : (
                      <>
                        {step.options.length} option{step.options.length !== 1 && 's'}
                        {step.questionType === 'multiselect' && ' (multi)'}
                      </>
                    )}
                  </div>
                </button>
              ))}

              <div className="border-t border-gray-100 my-1" />

              {/* End Screen */}
              <button
                onClick={() => setSelectedStepId('__end__')}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                  selectedStepId === '__end__'
                    ? 'bg-red-50 text-red-700 border border-red-200'
                    : 'hover:bg-gray-50 border border-transparent'
                }`}
              >
                <div className="font-medium">End Screen</div>
                <div className="text-xs text-gray-500">Completion message</div>
              </button>
            </div>
          </div>

          {/* Step Editor */}
          <div className="flex-1 bg-white rounded-lg shadow p-6 overflow-y-auto">
            {selectedStepId === '__start__' ? (
              renderStartEditor()
            ) : selectedStepId === '__end__' ? (
              renderEndEditor()
            ) : selectedStep ? (
              <StepEditorPanel
                step={selectedStep}
                allSteps={flow.steps}
                videos={videos}
                hideVideo={!!previewStepId}
                onUpdateStep={updateStep}
                onDeleteStep={deleteStep}
                onAddOption={addOption}
                onUpdateOption={updateOption}
                onDeleteOption={deleteOption}
                onVideoUploaded={(video) => {
                  setVideos((prev) => [video, ...prev])
                  fetchFlow()
                }}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">
                {flow.steps.length === 0
                  ? 'Add your first step to get started'
                  : 'Select a step to edit'}
              </div>
            )}
          </div>
        </div>
      )}

      {saving && (
        <div className="fixed bottom-4 right-4 bg-gray-800 text-white px-4 py-2 rounded-md text-sm">
          Saving...
        </div>
      )}

      {/* Add Step Modal */}
      {showAddStepModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-white rounded-[12px] shadow-2xl w-full max-w-[560px] max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-6 pb-0">
              <div className="flex items-center gap-3">
                {addStepType && (
                  <button onClick={() => setAddStepType(null)} className="text-grey-40 hover:text-grey-15">&larr;</button>
                )}
                <h2 className="text-xl font-semibold text-grey-15">
                  {!addStepType ? 'Add Step' : addStepType === 'submission' ? 'Video Step' : addStepType === 'question' ? 'Question Step' : addStepType === 'form' ? 'Form Step' : addStepType === 'capture' ? 'Audio Answer Step' : 'Screen Step'}
                </h2>
              </div>
              <button onClick={() => { setShowAddStepModal(false); setPendingArrowInsertion(null) }} className="text-grey-40 hover:text-grey-15 text-xl">&times;</button>
            </div>

            <div className="p-6">
              {/* Phase 1: Choose type */}
              {!addStepType && (
                <>
                  <p className="text-sm text-grey-35 mb-5">Choose what type of step to add.</p>
                  {/* Re-add removed screens */}
                  {(flow.startMessage === '' || flow.endMessage === '') && (
                    <div className="flex gap-2 mb-4">
                      {flow.startMessage === '' && (
                        <button onClick={() => { updateFlow({ startMessage: 'Welcome! Please complete the following steps.' }); setShowAddStepModal(false) }} className="flex-1 py-2 text-xs border border-brand-200 rounded-[8px] text-brand-500 hover:bg-brand-50">+ Add Start Screen</button>
                      )}
                      {flow.endMessage === '' && (
                        <button onClick={() => { updateFlow({ endMessage: 'Thank you for your participation!' }); setShowAddStepModal(false) }} className="flex-1 py-2 text-xs border border-brand-200 rounded-[8px] text-brand-500 hover:bg-brand-50">+ Add End Screen</button>
                      )}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    {[
                      { type: 'submission', label: 'Video', desc: 'Upload video + continue button', color: 'brand', icon: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z' },
                      { type: 'question', label: 'Question', desc: 'Quiz with options', color: 'blue', icon: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
                      { type: 'form', label: 'Form', desc: 'Collect candidate info', color: 'green', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
                      { type: 'info', label: 'Screen', desc: 'Text, instructions, image', color: 'purple', icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
                      // `color` is part of the templated class names above; we reuse
                      // an already-emitted palette ('brand') so the JIT picks up the
                      // classes without a tailwind safelist change.
                      // Audio Answer tile is hidden when EITHER the global
                      // env flag is off OR the workspace's
                      // settings.captureStepsEnabled !== true. The server
                      // composites both into flow.captureStepsEnabled so the
                      // client just reads one boolean. Existing capture
                      // steps in the flow keep rendering; the recruiter
                      // just can't add new ones while the gate is closed.
                      ...(flow.captureStepsEnabled
                        ? [{ type: 'capture', label: 'Audio Answer', desc: 'Candidate records spoken answer', color: 'brand', icon: 'M19 11a7 7 0 01-14 0m7 7v3m-4 0h8M12 4a3 3 0 00-3 3v4a3 3 0 006 0V7a3 3 0 00-3-3z' }]
                        : []),
                    ].map(({ type, label, desc, color, icon }) => (
                      <button
                        key={type}
                        onClick={() => { setAddStepType(type); if (type === 'submission') { setAddStepButtonEnabled(true); setAddStepButtonText('Continue') } }}
                        className={`flex flex-col items-center gap-3 p-6 rounded-[12px] border-2 border-surface-border hover:border-brand-500 hover:bg-brand-50 transition-all group`}
                      >
                        <div className={`w-14 h-14 rounded-[12px] bg-${color}-50 group-hover:bg-${color}-100 flex items-center justify-center`}>
                          <svg className={`w-7 h-7 text-${color}-500`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={icon} />
                          </svg>
                        </div>
                        <div className="text-center">
                          <div className="font-semibold text-grey-15 text-sm">{label}</div>
                          <div className="text-[11px] text-grey-40 mt-0.5">{desc}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Phase 2: Video config — matches edit modal layout */}
              {addStepType === 'submission' && (
                <div className="space-y-4">
                  {/* Video — drag & drop + select + upload */}
                  <div>
                    <label className="block text-sm font-medium text-grey-20 mb-1.5">Video</label>
                    {!addStepVideoId && !uploadingStepVideo ? (
                      <div
                        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-brand-500', 'bg-brand-50') }}
                        onDragLeave={(e) => { e.preventDefault(); e.currentTarget.classList.remove('border-brand-500', 'bg-brand-50') }}
                        onDrop={async (e) => {
                          e.preventDefault()
                          e.currentTarget.classList.remove('border-brand-500', 'bg-brand-50')
                          const file = e.dataTransfer.files[0]
                          if (file && file.type.startsWith('video/')) {
                            setUploadingStepVideo(true); setStepVideoProgress(5)
                            try {
                              const result = await startUpload(file, 'interview')
                              setStepVideoProgress(100)
                              if (result.videoId) {
                                setAddStepVideoId(result.videoId)
                                setVideos(prev => [{ id: result.videoId, filename: result.filename, url: '', displayName: null }, ...prev])
                              }
                            } catch {}
                            setUploadingStepVideo(false)
                          }
                        }}
                        className="border-2 border-dashed border-surface-border rounded-[8px] p-6 text-center transition-colors cursor-pointer hover:border-brand-400"
                        onClick={() => stepVideoInputRef.current?.click()}
                      >
                        <svg className="w-10 h-10 mx-auto text-grey-50 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                        <p className="text-sm text-grey-40 mb-1">Drag & drop video here</p>
                        <p className="text-xs text-grey-50">or click to browse</p>
                        <input ref={stepVideoInputRef} type="file" accept="video/*" onChange={handleStepVideoUpload} className="hidden" />
                      </div>
                    ) : uploadingStepVideo ? (
                      <div className="border-2 border-brand-300 bg-brand-50 rounded-[8px] p-6 text-center">
                        <div className="w-10 h-10 mx-auto mb-3 border-3 border-brand-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-sm font-medium text-brand-700">Uploading... {stepVideoProgress}%</span>
                        <div className="w-full bg-brand-200 rounded-full h-2 mt-3">
                          <div className="bg-brand-500 h-2 rounded-full transition-all duration-300" style={{ width: `${stepVideoProgress}%` }} />
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 p-3 bg-brand-50 rounded-[8px] border border-brand-200">
                        <svg className="w-5 h-5 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        <span className="text-sm text-brand-700 font-medium flex-1 truncate">{(() => { const sv = videos.find(v => v.id === addStepVideoId); return sv ? videoLabel(sv) : 'Video selected' })()}</span>
                        <button onClick={() => setAddStepVideoId('')} className="text-xs text-brand-500 hover:text-brand-600">Change</button>
                      </div>
                    )}
                    {!uploadingStepVideo && (
                      <div className="mt-2">
                        <select
                          value={addStepVideoId}
                          onChange={(e) => { setAddStepVideoId(e.target.value) }}
                          className="w-full px-3 py-2 text-xs border border-surface-border rounded-[8px] text-grey-40 focus:outline-none focus:ring-1 focus:ring-brand-500"
                        >
                          <option value="">Or select from library...</option>
                          {videos.map(v => <option key={v.id} value={v.id}>{videoLabel(v)}</option>)}
                        </select>
                      </div>
                    )}
                  </div>

                  {/* Video preview — same as edit */}
                  {addStepVideoId && (() => {
                    const vid = videos.find(v => v.id === addStepVideoId)
                    return vid?.url ? <video src={vid.url} controls className="w-full rounded-[8px] max-h-[50vh] object-contain" /> : null
                  })()}

                  {/* Action Button */}
                  <div className="border-t border-surface-border pt-4">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium text-grey-20">Action Button</label>
                      <button
                        onClick={() => setAddStepButtonEnabled(!addStepButtonEnabled)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${addStepButtonEnabled ? 'bg-[#FF9500]' : 'bg-gray-300'}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${addStepButtonEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                    </div>
                    {addStepButtonEnabled && (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={addStepButtonText}
                          onChange={(e) => setAddStepButtonText(e.target.value)}
                          placeholder="Continue"
                          className="w-full px-4 py-2.5 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                        <select
                          value={addStepButtonNextStepId ?? ''}
                          onChange={(e) => setAddStepButtonNextStepId(e.target.value || null)}
                          className="w-full px-3 py-1.5 text-xs border border-surface-border rounded-[8px] text-grey-40"
                        >
                          <option value="">→ Next step (auto)</option>
                          <option value="__end__">→ End</option>
                          {[...(flow?.steps ?? [])]
                            .sort((a, b) => a.stepOrder - b.stepOrder)
                            .map((s, i) => (
                              <option key={s.id} value={s.id}>→ {i + 1}. {s.title}</option>
                            ))}
                        </select>
                      </div>
                    )}
                  </div>

                  {/* Combine with */}
                  <div className="border-t border-surface-border pt-4">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium text-grey-20">Combine with</label>
                      <button
                        onClick={() => setCombineEnabled(!combineEnabled)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${combineEnabled ? 'bg-[#FF9500]' : 'bg-gray-300'}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${combineEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                    </div>
                    {combineEnabled && flow && flow.steps.length > 0 && (
                      <select className="w-full px-3 py-1.5 text-xs border border-surface-border rounded-[8px] text-grey-40">
                        <option value="">Select step to combine with...</option>
                        {flow.steps.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                      </select>
                    )}
                  </div>

                  <div className="flex gap-3 pt-2">
                    <button onClick={() => { setShowAddStepModal(false); setPendingArrowInsertion(null) }} className="btn-secondary flex-1">Cancel</button>
                    <button onClick={submitAddStep} disabled={uploadingStepVideo} className="btn-primary flex-1 disabled:opacity-50">Save</button>
                  </div>
                </div>
              )}

              {/* Phase 2: Question config */}
              {addStepType === 'question' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-grey-20 mb-1.5">Question</label>
                    <textarea value={addStepQuestion} onChange={(e) => setAddStepQuestion(e.target.value)} rows={2} placeholder="e.g. What experience do you have?" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-grey-20 mb-1.5">Question Type</label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { value: 'single', label: 'Single Choice' },
                        { value: 'multiselect', label: 'Multi Choice' },
                        { value: 'yesno', label: 'Yes / No' },
                      ].map(({ value, label }) => (
                        <button key={value} onClick={() => setAddStepQuestionType(value)} className={`py-2 text-xs rounded-[8px] border font-medium ${addStepQuestionType === value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-35'}`}>{label}</button>
                      ))}
                    </div>
                  </div>
                  {addStepQuestionType !== 'yesno' && (
                    <div>
                      <label className="block text-sm font-medium text-grey-20 mb-1.5">Answer Options</label>
                      <div className="space-y-2">
                        {addStepOptions.map((opt, i) => (
                          <div key={i} className="space-y-1">
                            <div className="flex gap-2">
                              <input type="text" value={opt.text} onChange={(e) => { const n = [...addStepOptions]; n[i] = { ...n[i], text: e.target.value }; setAddStepOptions(n) }} placeholder={`Option ${i + 1}`} className="flex-1 px-3 py-2 text-sm border border-surface-border rounded-[8px] focus:outline-none focus:ring-1 focus:ring-brand-500" />
                              {addStepOptions.length > 2 && (
                                <button onClick={() => setAddStepOptions(addStepOptions.filter((_, j) => j !== i))} className="text-brand-400 hover:text-brand-600 text-sm px-2">&times;</button>
                              )}
                            </div>
                            <select
                              value={opt.nextStepId || ''}
                              onChange={(e) => { const n = [...addStepOptions]; n[i] = { ...n[i], nextStepId: e.target.value || null }; setAddStepOptions(n) }}
                              className="w-full px-3 py-1.5 text-xs border border-surface-border rounded-[6px] text-grey-40"
                            >
                              <option value="">→ Next step (auto)</option>
                              <option value="__end__">→ End</option>
                              {[...(flow?.steps ?? [])]
                                .sort((a, b) => a.stepOrder - b.stepOrder)
                                .map((s, j) => (
                                  <option key={s.id} value={s.id}>→ {j + 1}. {s.title}</option>
                                ))}
                            </select>
                          </div>
                        ))}
                        <button onClick={() => setAddStepOptions([...addStepOptions, { text: '', nextStepId: null }])} className="text-xs text-brand-500 hover:text-brand-600 font-medium">+ Add option</button>
                      </div>
                    </div>
                  )}
                  <div className="flex gap-3 pt-2">
                    <button onClick={() => { setShowAddStepModal(false); setPendingArrowInsertion(null) }} className="btn-secondary flex-1">Cancel</button>
                    <button onClick={submitAddStep} className="btn-primary flex-1">Save</button>
                  </div>
                </div>
              )}

              {/* Phase 2: Form config */}
              {addStepType === 'form' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-grey-20 mb-1.5">Form Title</label>
                    <input type="text" value={addStepTitle} onChange={(e) => setAddStepTitle(e.target.value)} placeholder="e.g. Candidate Information" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-grey-20 mb-2">Fields</label>
                    <div className="space-y-2">
                      {addStepFormFields.map((field, i) => (
                        <div key={field.id} className="p-3 rounded-[8px] border border-surface-border space-y-2">
                          <div className="flex items-center gap-3">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={field.enabled} onChange={() => { const n = [...addStepFormFields]; n[i] = { ...n[i], enabled: !n[i].enabled }; setAddStepFormFields(n) }} className="rounded accent-[#FF9500]" />
                            </label>
                            {field.isBuiltIn ? (
                              <span className="text-sm text-grey-15 flex-1">{field.label}</span>
                            ) : (
                              <input
                                type="text"
                                value={field.label}
                                onChange={(e) => { const n = [...addStepFormFields]; n[i] = { ...n[i], label: e.target.value }; setAddStepFormFields(n) }}
                                placeholder="Field name"
                                className="flex-1 px-2 py-1 text-sm border border-surface-border rounded-[8px] focus:outline-none focus:ring-1 focus:ring-brand-500"
                              />
                            )}
                            <label className="flex items-center gap-1.5 text-xs text-grey-40">
                              <input type="checkbox" checked={field.required} onChange={() => { const n = [...addStepFormFields]; n[i] = { ...n[i], required: !n[i].required }; setAddStepFormFields(n) }} className="rounded accent-[#FF9500]" />
                              Required
                            </label>
                            {!field.isBuiltIn && (
                              <button onClick={() => setAddStepFormFields(addStepFormFields.filter((_, j) => j !== i))} className="text-brand-400 hover:text-brand-600 text-sm">&times;</button>
                            )}
                          </div>
                          {!field.isBuiltIn && (
                            <div className="flex gap-1 ml-7">
                              {[
                                { value: 'text', label: 'Text' },
                                { value: 'radio', label: 'Radio' },
                                { value: 'multiselect', label: 'Multi' },
                                { value: 'button', label: 'Button' },
                              ].map(t => (
                                <button key={t.value} onClick={() => { const n = [...addStepFormFields]; n[i] = { ...n[i], type: t.value }; setAddStepFormFields(n) }} className={`px-2.5 py-1 text-[10px] rounded-[6px] border font-medium ${field.type === t.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-40'}`}>
                                  {t.label}
                                </button>
                              ))}
                            </div>
                          )}
                          {!field.isBuiltIn && (field.type === 'radio' || field.type === 'multiselect' || field.type === 'button') && (
                            <div className="ml-7 space-y-1">
                              {((field as any).options || ['Option 1', 'Option 2']).map((opt: string, j: number) => (
                                <div key={j} className="flex gap-1">
                                  <input
                                    type="text"
                                    value={opt}
                                    onChange={(e) => {
                                      const n = [...addStepFormFields]
                                      const opts = [...((n[i] as any).options || ['Option 1', 'Option 2'])]
                                      opts[j] = e.target.value
                                      n[i] = { ...n[i], options: opts } as any
                                      setAddStepFormFields(n)
                                    }}
                                    placeholder={`Option ${j + 1}`}
                                    className="flex-1 px-2 py-1 text-xs border border-surface-border rounded-[6px] focus:outline-none focus:ring-1 focus:ring-brand-500"
                                  />
                                  {((field as any).options || []).length > 2 && (
                                    <button onClick={() => {
                                      const n = [...addStepFormFields]
                                      const opts = [...((n[i] as any).options || [])].filter((_: any, k: number) => k !== j)
                                      n[i] = { ...n[i], options: opts } as any
                                      setAddStepFormFields(n)
                                    }} className="text-grey-50 hover:text-red-500 text-xs">&times;</button>
                                  )}
                                </div>
                              ))}
                              <button onClick={() => {
                                const n = [...addStepFormFields]
                                const opts = [...((n[i] as any).options || ['Option 1', 'Option 2']), '']
                                n[i] = { ...n[i], options: opts } as any
                                setAddStepFormFields(n)
                              }} className="text-[10px] text-brand-500 hover:text-brand-600">+ Add option</button>
                            </div>
                          )}
                        </div>
                      ))}
                      <button onClick={() => setAddStepFormFields([...addStepFormFields, { id: `custom_${Date.now()}`, label: 'Custom Field', type: 'text', required: false, enabled: true, isBuiltIn: false }])} className="text-xs text-brand-500 hover:text-brand-600 font-medium">+ Add custom field</button>
                    </div>
                  </div>
                  <button onClick={submitAddStep} className="w-full btn-primary py-3">Add Form Step</button>
                </div>
              )}

              {/* Phase 2: Screen / Info config */}
              {addStepType === 'info' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-grey-20 mb-1.5">Screen Title</label>
                    <input type="text" value={addStepTitle} onChange={(e) => setAddStepTitle(e.target.value)} placeholder="e.g. Welcome, Next Steps, Thank You" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-grey-20 mb-1.5">Content Text</label>
                    <textarea value={addStepInfoText} onChange={(e) => setAddStepInfoText(e.target.value)} rows={5} placeholder="Instructions, welcome message, or any information to show the candidate..." className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-grey-20 mb-1.5">Background Image (optional)</label>
                    {addStepImageUrl ? (
                      <div className="relative rounded-[8px] overflow-hidden">
                        <img src={addStepImageUrl} alt="" className="w-full h-32 object-cover rounded-[8px]" />
                        <button onClick={() => setAddStepImageUrl(null)} className="absolute top-2 right-2 w-6 h-6 bg-black/50 text-white rounded-full text-xs flex items-center justify-center hover:bg-black/70">&times;</button>
                      </div>
                    ) : (
                      <label className={`block w-full p-4 border-2 border-dashed rounded-[8px] text-center cursor-pointer transition-colors ${uploadingImage ? 'border-brand-300 bg-brand-50' : 'border-surface-divider hover:border-brand-400'}`}>
                        <svg className="w-8 h-8 mx-auto text-grey-50 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                        <span className="text-xs text-grey-40">{uploadingImage ? 'Uploading...' : 'Upload image'}</span>
                        <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          console.log('[Screen image] uploading', file.name, file.size)
                          setUploadingImage(true)
                          try {
                            const formData = new FormData()
                            formData.append('file', file)
                            const res = await fetch('/api/uploads/logo', { method: 'POST', body: formData })
                            console.log('[Screen image] response status:', res.status)
                            if (res.ok) {
                              const data = await res.json()
                              console.log('[Screen image] uploaded:', data.url)
                              setAddStepImageUrl(data.url)
                            } else {
                              const err = await res.json()
                              console.error('[Screen image] error:', err)
                              alert(`Upload failed: ${err.error}`)
                            }
                          } catch (err) {
                            console.error('[Screen image] exception:', err)
                            alert('Upload failed — check console')
                          }
                          setUploadingImage(false)
                        }} />
                      </label>
                    )}
                  </div>
                  {/* Action button */}
                  <div className="border-t border-surface-border pt-4">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium text-grey-20">Action Button</label>
                      <button
                        onClick={() => setAddStepButtonEnabled(!addStepButtonEnabled)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${addStepButtonEnabled ? 'bg-[#FF9500]' : 'bg-gray-300'}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${addStepButtonEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                    </div>
                    {addStepButtonEnabled && (
                      <input
                        type="text"
                        value={addStepButtonText}
                        onChange={(e) => setAddStepButtonText(e.target.value)}
                        placeholder="Button text"
                        className="w-full px-4 py-2.5 border border-surface-border rounded-[8px] text-sm text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    )}
                  </div>
                  <button onClick={submitAddStep} className="w-full btn-primary py-3">Add Screen Step</button>
                </div>
              )}

              {/* Phase 2: Capture (audio answer) config */}
              {addStepType === 'capture' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-grey-20 mb-1.5">Step Title</label>
                    <input
                      type="text"
                      value={addStepTitle}
                      onChange={(e) => setAddStepTitle(e.target.value)}
                      placeholder="e.g. Tell us about yourself"
                      className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-grey-20 mb-1.5">Prompt for candidate</label>
                    <textarea
                      value={addStepCapturePrompt}
                      onChange={(e) => setAddStepCapturePrompt(e.target.value)}
                      rows={3}
                      placeholder="e.g. Record a 30-second introduction about your experience and what motivates you."
                      className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <p className="text-[11px] text-grey-50 mt-1">Shown above the recorder. The candidate can preview before submitting.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-grey-20 mb-1.5">Min duration (sec)</label>
                      <input
                        type="number"
                        min={0}
                        value={addStepCaptureMinDuration}
                        onChange={(e) => setAddStepCaptureMinDuration(e.target.value)}
                        placeholder="optional"
                        className="w-full px-4 py-2.5 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-grey-20 mb-1.5">Max duration (sec)</label>
                      <input
                        type="number"
                        min={1}
                        value={addStepCaptureMaxDuration}
                        onChange={(e) => setAddStepCaptureMaxDuration(e.target.value)}
                        placeholder="e.g. 120"
                        className="w-full px-4 py-2.5 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    </div>
                  </div>
                  <div className="border-t border-surface-border pt-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-grey-20">Required</label>
                      <button
                        onClick={() => setAddStepCaptureRequired(!addStepCaptureRequired)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${addStepCaptureRequired ? 'bg-[#FF9500]' : 'bg-gray-300'}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${addStepCaptureRequired ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-grey-20">Allow retakes</label>
                      <button
                        onClick={() => setAddStepCaptureAllowRetake(!addStepCaptureAllowRetake)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${addStepCaptureAllowRetake ? 'bg-[#FF9500]' : 'bg-gray-300'}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${addStepCaptureAllowRetake ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                    </div>
                    {addStepCaptureAllowRetake && (
                      <div>
                        <label className="block text-sm font-medium text-grey-20 mb-1.5">Max retakes</label>
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={addStepCaptureMaxRetakes}
                          onChange={(e) => setAddStepCaptureMaxRetakes(e.target.value)}
                          placeholder="leave blank for unlimited"
                          className="w-full px-4 py-2.5 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                        <p className="text-[11px] text-grey-50 mt-1">Retakes beyond the first attempt. Leave blank for unlimited.</p>
                      </div>
                    )}
                  </div>
                  <div className="border-t border-surface-border pt-4 space-y-2">
                    <div className="flex items-center justify-between opacity-60">
                      <label className="text-sm text-grey-35">
                        Auto-transcribe answers
                        <span className="ml-2 text-[11px] uppercase tracking-wide text-grey-40">Coming soon</span>
                      </label>
                      <button
                        disabled
                        className="relative inline-flex h-5 w-9 items-center rounded-full bg-gray-300 cursor-not-allowed"
                      >
                        <span className="inline-block h-3.5 w-3.5 transform rounded-full bg-white translate-x-0.5" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between opacity-60">
                      <label className="text-sm text-grey-35">
                        AI analysis &amp; score
                        <span className="ml-2 text-[11px] uppercase tracking-wide text-grey-40">Coming soon</span>
                      </label>
                      <button
                        disabled
                        className="relative inline-flex h-5 w-9 items-center rounded-full bg-gray-300 cursor-not-allowed"
                      >
                        <span className="inline-block h-3.5 w-3.5 transform rounded-full bg-white translate-x-0.5" />
                      </button>
                    </div>
                  </div>
                  {addStepCaptureError && (
                    <div className="rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      {addStepCaptureError}
                    </div>
                  )}
                  <div className="flex gap-3 pt-2">
                    <button onClick={() => { setShowAddStepModal(false); setPendingArrowInsertion(null); setAddStepCaptureError(null) }} className="btn-secondary flex-1">Cancel</button>
                    {(() => {
                      // Re-validate live so the button toggles as the user
                      // fixes inputs, not just after they click submit.
                      const draft: Record<string, unknown> = {
                        mode: 'audio',
                        prompt: addStepCapturePrompt.trim() || undefined,
                        required: addStepCaptureRequired,
                        allowRetake: addStepCaptureAllowRetake,
                        transcriptionEnabled: false,
                        aiAnalysisEnabled: false,
                      }
                      const minD = parseInt(addStepCaptureMinDuration, 10)
                      if (Number.isFinite(minD) && minD > 0) draft.minDurationSec = minD
                      const maxD = parseInt(addStepCaptureMaxDuration, 10)
                      if (Number.isFinite(maxD) && maxD > 0) draft.maxDurationSec = maxD
                      if (addStepCaptureAllowRetake) {
                        const r = parseInt(addStepCaptureMaxRetakes, 10)
                        if (Number.isFinite(r) && r > 0) draft.maxRetakes = r
                      }
                      const live = validateCaptureConfig(draft)
                      const disabled = !live.ok
                      return (
                        <button
                          onClick={submitAddStep}
                          disabled={disabled}
                          className="btn-primary flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Add Audio Step
                        </button>
                      )
                    })()}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
