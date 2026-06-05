/**
 * Training editor — three-pane layout per Design/SPEC-training-editor.md.
 *
 *   ┌─ TopNav (global, in dashboard/layout.tsx) ───┐
 *   ├─ Subnav: breadcrumb + badge + Preview/Publish ┤
 *   ├─ Sections ─┬─ Content editor ─┬─ Settings ────┤
 *   │  300px     │  flex 1          │  340px        │
 *
 * All CRUD endpoints from the previous editor are preserved verbatim. This
 * pass is presentational + UX: 3-pane layout, sticky subnav, inline rename,
 * drag-reorder sections, pre-flight publish drawer, autosave indicator.
 *
 * What we intentionally keep from the existing data model:
 *   - Section.contents[] where each content has type 'video' | 'text' and
 *     optional videoId. We present the FIRST video content as "the section's
 *     video" and the FIRST text content as "the section's description".
 *     Existing multi-content sections keep working — additional contents are
 *     just not editable from this screen (edit them from the old flow, or
 *     we can migrate later).
 *   - Quiz model + endpoints unchanged.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useUploads } from '../../_components/UploadProvider'
import { DashboardVideoPreview } from '../../_components/DashboardVideoPreview'
import { Badge, Button, Eyebrow, type BadgeTone } from '@/components/design'

// ───────────────────────── Types (mirrors existing API shape) ─────────────────────────

interface Video { id: string; filename: string; url: string; displayName?: string | null; durationSeconds?: number | null; hlsManifestUrl?: string | null; posterUrl?: string | null; status?: string | null }
interface Content { id: string; type: string; sortOrder: number; videoId: string | null; video: Video | null; requiredWatch: boolean; autoplayNext: boolean; textContent: string | null }
// `options` shape varies by questionType — see api/public/trainings/[slug]/route.ts.
// We hold it as `unknown` here and narrow per-type at the editor boundary so we
// don't fight the type checker across 6 distinct option shapes.
interface Question { id: string; questionText: string; questionType: string; sortOrder: number; options: unknown }
type FeedbackMode = 'none' | 'correctness' | 'explanation'
interface Quiz { id: string; title: string; requiredPassing: boolean; passingGrade: number; feedbackMode: FeedbackMode; questions: Question[] }
type ChoiceOpt = { text?: string; imageUrl?: string; pictureId?: string; isCorrect: boolean; hint?: string }
type TextOpts = { acceptedAnswers: string[]; caseSensitive?: boolean; hint?: string }
type NumberOpts = { value: number; tolerance?: number; hint?: string }
type FileOpts = { acceptedMimeTypes: string[]; maxSizeMb: number }
const isChoiceQ = (t: string) => t === 'single' || t === 'multiselect' || t === 'image'

// Default options shape when switching a question to a new type so the editor
// always has a well-formed payload to render.
function defaultOptionsFor(questionType: string): unknown {
  if (questionType === 'single' || questionType === 'multiselect') {
    return [
      { text: 'Option A', isCorrect: true },
      { text: 'Option B', isCorrect: false },
    ] satisfies ChoiceOpt[]
  }
  if (questionType === 'image') {
    return [] satisfies ChoiceOpt[]
  }
  if (questionType === 'text') {
    return { acceptedAnswers: [''], caseSensitive: false, hint: '' } satisfies TextOpts
  }
  if (questionType === 'number') {
    return { value: 0, tolerance: 0, hint: '' } satisfies NumberOpts
  }
  if (questionType === 'file') {
    return { acceptedMimeTypes: [], maxSizeMb: 25 } satisfies FileOpts
  }
  return null
}
// ───────────────────────── Doc-paste quiz parser ─────────────────────────
//
// Parses a Google-Doc-style quiz into question objects. Expected shape:
//
//   1. Question text?
//    A. Option text
//    B. Option text
//    C. Option text
//   Correct answers: A, B
//
// - Title / instruction lines outside that pattern are ignored.
// - Lines that aren't question / option / correct-answer markers are appended
//   to the previous element they belong to (multi-line questions/options).
// - questionType is 'single' if exactly one option is correct, else 'multiselect'.
// - Letters A–Z are mapped to option indices 0–25.
type ParsedQuestion = { questionText: string; questionType: 'single' | 'multiselect'; options: ChoiceOpt[] }
type ParseResult = { questions: ParsedQuestion[]; errors: string[] }

function parseQuizDoc(text: string): ParseResult {
  const lines = text.split(/\r?\n/)
  const errors: string[] = []
  const questions: ParsedQuestion[] = []

  let current: { text: string; options: { letter: string; text: string }[]; correct: Set<string> } | null = null
  let lastTouched: 'question' | 'option' | null = null

  const flush = (lineNo: number) => {
    if (!current) return
    if (current.options.length === 0) {
      errors.push(`Line ${lineNo}: question "${current.text.slice(0, 40)}…" has no options`)
      current = null
      return
    }
    if (current.correct.size === 0) {
      errors.push(`Line ${lineNo}: question "${current.text.slice(0, 40)}…" has no "Correct answers:" line`)
      current = null
      return
    }
    const opts: ChoiceOpt[] = current.options.map((o) => ({
      text: o.text,
      isCorrect: current!.correct.has(o.letter),
    }))
    questions.push({
      questionText: current.text,
      questionType: current.correct.size > 1 ? 'multiselect' : 'single',
      options: opts,
    })
    current = null
  }

  const reQuestion = /^\s*\d+[.)]\s+(.+)$/
  const reOption = /^\s*([A-Z])[.)]\s+(.+)$/
  const reCorrect = /^\s*(?:correct\s+answers?|answers?)\s*[:\-]\s*(.+)$/i

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line) { lastTouched = null; continue }

    const correctMatch = line.match(reCorrect)
    if (correctMatch && current) {
      const letters = correctMatch[1].split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]$/.test(s))
      letters.forEach((l) => current!.correct.add(l))
      flush(i + 1)
      lastTouched = null
      continue
    }

    const qMatch = line.match(reQuestion)
    if (qMatch) {
      flush(i + 1)
      current = { text: qMatch[1].trim(), options: [], correct: new Set() }
      lastTouched = 'question'
      continue
    }

    const oMatch = line.match(reOption)
    if (oMatch && current) {
      current.options.push({ letter: oMatch[1], text: oMatch[2].trim() })
      lastTouched = 'option'
      continue
    }

    // Continuation line — append to the last question or option text. Skips
    // header / instruction lines that appear before any question is opened.
    if (current && lastTouched === 'option') {
      const last = current.options[current.options.length - 1]
      if (last) last.text += ' ' + line
    } else if (current && lastTouched === 'question') {
      current.text += ' ' + line
    }
  }
  flush(lines.length)

  if (questions.length === 0 && errors.length === 0) {
    errors.push('No questions found. Expected lines like "1. Question?" with "A. Option" choices and a "Correct answers: A, B" line.')
  }
  return { questions, errors }
}

interface Section {
  id: string
  title: string
  kind: 'video' | 'quiz'
  sortOrder: number
  contents: Content[]
  quiz: Quiz | null
}
interface Training {
  id: string
  title: string
  slug: string
  description: string | null
  coverImage: string | null
  isPublished: boolean
  passingGrade: number
  sectionOrder: 'sequential' | 'any'
  sections: Section[]
}

// ───────────────────────── Helpers ─────────────────────────

const fmtDuration = (s?: number | null): string => {
  if (!s || !isFinite(s)) return '—'
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

const videoContent = (sec: Section): Content | null =>
  sec.contents.find((c) => c.type === 'video') ?? null
const textContent = (sec: Section): Content | null =>
  sec.contents.find((c) => c.type === 'text') ?? null

// Contents that the public viewer renders but this editor doesn't surface.
// The editor pins the first video + first text as the section's "video" and
// "description"; anything else is a hidden lesson that still appears to
// candidates. These are usually leftovers from an older multi-content layout.
const extraContents = (sec: Section): Content[] => {
  const firstVideo = sec.contents.find((c) => c.type === 'video')
  const firstText = sec.contents.find((c) => c.type === 'text')
  return sec.contents.filter((c) => c !== firstVideo && c !== firstText)
}

// ───────────────────────── Main component ─────────────────────────

export default function TrainingEditorPage() {
  const params = useParams()
  const trainingId = params.id as string

  const { startUpload } = useUploads()
  const [training, setTraining] = useState<Training | null>(null)
  const [videos, setVideos] = useState<Video[]>([])
  const [loading, setLoading] = useState(true)
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'section' | 'course'>('section')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [showPublishDrawer, setShowPublishDrawer] = useState(false)

  // Drag state
  const [dragSectionId, setDragSectionId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: 'above' | 'below' } | null>(null)

  // Local edit buffers (debounced saves)
  const titleBufferRef = useRef<Record<string, string>>({})
  const descBufferRef = useRef<Record<string, string>>({})
  const debounceTimers = useRef<Record<string, NodeJS.Timeout>>({})

  // Flash the saved chip
  const flashSaved = useCallback(() => {
    setSavedAt(Date.now())
    setTimeout(() => setSavedAt((t) => (t && Date.now() - t >= 900 ? null : t)), 1000)
  }, [])

  // ─────── Data loading ───────

  const loadAll = useCallback(async () => {
    const [t, v] = await Promise.all([
      fetch(`/api/trainings/${trainingId}`).then((r) => r.json()),
      fetch('/api/videos?kind=training').then((r) => r.json()),
    ])
    setTraining(t)
    setVideos(
      (v as Array<Record<string, unknown>>).map((vid) => ({
        id: vid.id as string,
        filename: vid.filename as string,
        url: (vid.url as string) || (vid.storageKey as string),
        displayName: (vid.displayName as string | null) ?? null,
        durationSeconds: (vid.durationSeconds as number | null) ?? null,
        hlsManifestUrl: (vid.hlsManifestUrl as string | null) ?? null,
        posterUrl: (vid.posterUrl as string | null) ?? null,
        status: (vid.status as string | null) ?? null,
      })),
    )
    if (!activeSectionId && t.sections?.length > 0) setActiveSectionId(t.sections[0].id)
    setLoading(false)
  }, [trainingId, activeSectionId])

  useEffect(() => { loadAll() }, [loadAll])

  // Prevent browser from opening dropped files in a new tab (capture phase)
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('[data-dropzone]')) e.preventDefault()
    }
    window.addEventListener('dragover', prevent, true)
    window.addEventListener('drop', prevent, true)
    return () => {
      window.removeEventListener('dragover', prevent, true)
      window.removeEventListener('drop', prevent, true)
    }
  }, [])

  const refresh = async () => {
    const res = await fetch(`/api/trainings/${trainingId}`)
    if (res.ok) setTraining(await res.json())
  }

  // ─────── CRUD wrappers ───────

  const patchTraining = async (data: Partial<Training>) => {
    await fetch(`/api/trainings/${trainingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    flashSaved()
    refresh()
  }

  const addSection = async (kind: 'video' | 'quiz' = 'video') => {
    const res = await fetch(`/api/trainings/${trainingId}/sections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, title: kind === 'quiz' ? 'New quiz' : 'New section' }),
    })
    if (res.ok) {
      const created = await res.json().catch(() => null)
      await refresh()
      if (created?.id) setActiveSectionId(created.id)
      flashSaved()
    }
  }

  const patchSection = async (sectionId: string, data: Record<string, unknown>) => {
    await fetch(`/api/trainings/${trainingId}/sections/${sectionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    flashSaved()
    refresh()
  }

  const reorderSections = async (orderedIds: string[]) => {
    // Optimistic
    setTraining((prev) =>
      prev
        ? {
            ...prev,
            sections: orderedIds
              .map((id, idx) => {
                const s = prev.sections.find((x) => x.id === id)
                return s ? { ...s, sortOrder: idx } : null
              })
              .filter((x): x is Section => x !== null),
          }
        : prev,
    )
    await Promise.all(
      orderedIds.map((id, idx) =>
        fetch(`/api/trainings/${trainingId}/sections/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sortOrder: idx }),
        }),
      ),
    )
    flashSaved()
  }

  const removeSection = async (sectionId: string) => {
    await fetch(`/api/trainings/${trainingId}/sections/${sectionId}`, { method: 'DELETE' })
    if (activeSectionId === sectionId) setActiveSectionId(null)
    flashSaved()
    refresh()
  }

  const upsertContent = async (sectionId: string, data: { type: 'video' | 'text'; videoId?: string | null; textContent?: string | null; requiredWatch?: boolean }) => {
    const existing = training?.sections.find((s) => s.id === sectionId)?.contents.find((c) => c.type === data.type)
    if (existing) {
      await fetch(`/api/trainings/${trainingId}/sections/${sectionId}/contents`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentId: existing.id, ...data }),
      })
    } else {
      await fetch(`/api/trainings/${trainingId}/sections/${sectionId}/contents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    }
    flashSaved()
    refresh()
  }

  const removeContent = async (sectionId: string, contentId: string) => {
    await fetch(`/api/trainings/${trainingId}/sections/${sectionId}/contents`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentId }),
    })
    flashSaved()
    refresh()
  }

  const removeVideoFromSection = async (sectionId: string) => {
    const vc = training?.sections.find((s) => s.id === sectionId)?.contents.find((c) => c.type === 'video')
    if (!vc) return
    await fetch(`/api/trainings/${trainingId}/sections/${sectionId}/contents`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentId: vc.id }),
    })
    flashSaved()
    refresh()
  }

  // Debounced text saves
  const debouncedSaveDescription = (sectionId: string, text: string) => {
    descBufferRef.current[sectionId] = text
    if (debounceTimers.current[`d-${sectionId}`]) clearTimeout(debounceTimers.current[`d-${sectionId}`])
    debounceTimers.current[`d-${sectionId}`] = setTimeout(() => {
      upsertContent(sectionId, { type: 'text', textContent: descBufferRef.current[sectionId] })
    }, 500)
  }

  const debouncedSaveTitle = (sectionId: string, title: string) => {
    titleBufferRef.current[sectionId] = title
    if (debounceTimers.current[`t-${sectionId}`]) clearTimeout(debounceTimers.current[`t-${sectionId}`])
    debounceTimers.current[`t-${sectionId}`] = setTimeout(() => {
      patchSection(sectionId, { title: titleBufferRef.current[sectionId] })
    }, 500)
  }

  // Video upload + attach to section. Routes through the dashboard-level
  // UploadProvider so the upload survives tab navigation and the global
  // banner shows progress while the recruiter is on any other dashboard
  // route. onProgress is still called for the in-card progress bar UX in the
  // section editor — provider + local state both track the same upload.
  const uploadAndAttach = async (sectionId: string, file: File, onProgress: (p: number) => void) => {
    if (!file.type.startsWith('video/')) {
      alert('Please upload a video file (MP4, MOV, WebM)')
      return
    }
    // Local progress mirror — provider fires status updates but they live in
    // its own state. We can't bridge them per-callsite, so the in-section
    // progress bar reads from a side channel: we infer 0→100% by polling
    // GET /api/videos/{id} after upload returns. Simpler approach for now:
    // the provider's banner shows percent, the in-section bar just shows
    // "Uploading…" until the upload-init call returns the videoId, then
    // jumps to 100% once startUpload resolves.
    onProgress(5)
    const result = await startUpload(file, 'training')
    onProgress(100)
    if (result.videoId) {
      setVideos((prev) => [
        { id: result.videoId, filename: result.filename, url: '', displayName: null, durationSeconds: null },
        ...prev,
      ])
      await upsertContent(sectionId, { type: 'video', videoId: result.videoId })
    }
  }

  // Quiz
  const createQuiz = async (sectionId: string) => {
    await fetch(`/api/trainings/${trainingId}/sections/${sectionId}/quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Section quiz', requiredPassing: true, passingGrade: 80 }),
    })
    flashSaved()
    refresh()
  }
  const quizAction = async (sectionId: string, data: Record<string, unknown>) => {
    await fetch(`/api/trainings/${trainingId}/sections/${sectionId}/quiz`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    flashSaved()
    refresh()
  }

  // ─────── Keyboard shortcuts ───────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 's') {
        e.preventDefault()
        flashSaved()
        return
      }
      if (meta && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (!training || training.sections.length === 0) return
        e.preventDefault()
        const idx = training.sections.findIndex((s) => s.id === activeSectionId)
        const next = e.key === 'ArrowUp' ? Math.max(0, idx - 1) : Math.min(training.sections.length - 1, idx + 1)
        setActiveSectionId(training.sections[next].id)
        setViewMode('section')
      }
      if (e.key === 'Escape' && viewMode === 'section') {
        setViewMode('course')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [training, activeSectionId, viewMode, flashSaved])

  // ─────── Loading state ───────

  if (loading || !training) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>Loading editor…</div>
      </div>
    )
  }

  const activeSection = training.sections.find((s) => s.id === activeSectionId) ?? null
  const preflight = computePreflight(training)

  return (
    // The dashboard layout wraps children in a max-width container with
    // px + py. Negate those so the editor goes full-bleed and we can manage
    // our own scroll regions.
    <div className="-mx-6 lg:-mx-[132px] -my-8 flex flex-col" style={{ height: 'calc(100vh - 60px)', background: 'var(--bg)' }}>
      {/* ─────── Subnav ─────── */}
      <div className="shrink-0 bg-white border-b border-surface-border">
        <div className="px-6 py-3.5 flex items-center gap-3">
          <Link href="/dashboard/trainings" className="text-[13px] text-grey-35 hover:text-ink">
            Trainings <span className="text-grey-50 mx-1">/</span>
          </Link>
          <div className="text-[15px] font-semibold text-ink">{training.title}</div>
          <Badge tone={training.isPublished ? 'success' : 'brand'}>
            {training.isPublished ? 'Published' : 'Draft'}
          </Badge>
          <div className="ml-auto flex items-center gap-2.5">
            {savedAt && (
              <div className="font-mono text-[10px] uppercase text-grey-35 transition-opacity" style={{ letterSpacing: '0.12em' }}>
                Saved
              </div>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const qs = new URLSearchParams({ preview: '1' })
                if (viewMode === 'section' && activeSectionId) qs.set('section', activeSectionId)
                window.open(`/t/${training.slug}?${qs.toString()}`, '_blank')
              }}
            >
              Preview
            </Button>
            <Button
              size="sm"
              onClick={() => setShowPublishDrawer(true)}
            >
              {training.isPublished ? 'Update' : 'Publish'}
            </Button>
          </div>
        </div>
      </div>

      {/* ─────── 3-pane body ─────── */}
      <div className="flex-1 flex min-h-0">
        {/* ───── Left: Sections ───── */}
        <aside className="w-[300px] shrink-0 bg-white border-r border-surface-border overflow-y-auto">
          <div className="p-4">
            <div className="flex items-center justify-between mb-2.5">
              <Eyebrow size="xs">Sections · {training.sections.length}</Eyebrow>
              <button
                onClick={() => { setViewMode('course'); setActiveSectionId(null) }}
                className={`text-[10px] uppercase font-mono px-2 py-0.5 rounded-full transition-colors ${
                  viewMode === 'course' ? 'bg-brand-50 text-[color:var(--brand-fg)]' : 'text-grey-35 hover:bg-surface-light'
                }`}
                style={{ letterSpacing: '0.12em' }}
                title="Course settings"
              >
                Course
              </button>
            </div>

            {training.sections.length === 0 ? (
              <div className="text-center py-10 px-2">
                <div className="text-[13px] font-medium text-ink mb-1.5">Your course is empty</div>
                <p className="text-[12px] text-grey-35 mb-4">Add your first section to get started.</p>
                <div className="flex flex-col gap-2">
                  <Button size="sm" onClick={() => addSection('video')}>+ Video section</Button>
                  <Button size="sm" variant="secondary" onClick={() => addSection('quiz')}>+ Quiz section</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                {training.sections.map((s, idx) => {
                  const isActive = viewMode === 'section' && activeSectionId === s.id
                  const vc = videoContent(s)
                  const subtitle = s.kind === 'quiz'
                    ? `Quiz · ${s.quiz?.questions.length ?? 0} Q`
                    : fmtDuration(vc?.video?.durationSeconds ?? null)
                  const isDropTargetAbove = dropTarget?.id === s.id && dropTarget.edge === 'above'
                  const isDropTargetBelow = dropTarget?.id === s.id && dropTarget.edge === 'below'
                  return (
                    <div
                      key={s.id}
                      draggable
                      onDragStart={(e) => {
                        setDragSectionId(s.id)
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', s.id)
                      }}
                      onDragOver={(e) => {
                        if (!dragSectionId || dragSectionId === s.id) return
                        e.preventDefault()
                        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
                        const edge: 'above' | 'below' = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below'
                        setDropTarget({ id: s.id, edge })
                      }}
                      onDragLeave={() => setDropTarget(null)}
                      onDrop={(e) => {
                        e.preventDefault()
                        const src = dragSectionId
                        setDragSectionId(null)
                        setDropTarget(null)
                        if (!src || src === s.id) return
                        const currentOrder = training.sections.map((x) => x.id)
                        const filtered = currentOrder.filter((id) => id !== src)
                        let target = filtered.indexOf(s.id)
                        if (dropTarget?.edge === 'below') target += 1
                        filtered.splice(target, 0, src)
                        reorderSections(filtered)
                      }}
                      onDragEnd={() => { setDragSectionId(null); setDropTarget(null) }}
                      onClick={() => { setActiveSectionId(s.id); setViewMode('section') }}
                      className={`group relative rounded-[8px] px-3 py-2.5 cursor-pointer transition-all border ${
                        isActive
                          ? 'bg-brand-50 border-[color:var(--brand-primary)]'
                          : 'bg-transparent border-transparent hover:bg-surface-weak'
                      }`}
                      style={{ opacity: dragSectionId === s.id ? 0.4 : 1 }}
                    >
                      {isDropTargetAbove && <div className="absolute -top-0.5 left-0 right-0 h-[2px]" style={{ background: 'var(--brand-primary)' }} />}
                      {isDropTargetBelow && <div className="absolute -bottom-0.5 left-0 right-0 h-[2px]" style={{ background: 'var(--brand-primary)' }} />}
                      <div className="flex items-center gap-2.5">
                        <div
                          className="w-[22px] h-[22px] rounded-full shrink-0 flex items-center justify-center font-mono text-[11px] font-semibold"
                          style={{
                            background: isActive ? 'var(--brand-primary)' : '#F1EBE1',
                            color: isActive ? '#fff' : '#59595A',
                          }}
                        >
                          {idx + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-ink truncate">{s.title}</div>
                          <div className="font-mono text-[11px] text-grey-35 truncate" style={{ letterSpacing: '0.02em' }}>{subtitle}</div>
                        </div>
                        {/* Drag handle — visible on hover */}
                        <svg
                          width={14}
                          height={14}
                          viewBox="0 0 14 14"
                          className="opacity-0 group-hover:opacity-100 text-grey-50"
                          style={{ cursor: dragSectionId === s.id ? 'grabbing' : 'grab' }}
                          aria-hidden
                        >
                          <circle cx={4} cy={3} r={1.1} fill="currentColor" />
                          <circle cx={4} cy={7} r={1.1} fill="currentColor" />
                          <circle cx={4} cy={11} r={1.1} fill="currentColor" />
                          <circle cx={10} cy={3} r={1.1} fill="currentColor" />
                          <circle cx={10} cy={7} r={1.1} fill="currentColor" />
                          <circle cx={10} cy={11} r={1.1} fill="currentColor" />
                        </svg>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {training.sections.length > 0 && (
              <div className="mt-3 flex gap-1.5">
                <button
                  onClick={() => addSection('video')}
                  className="flex-1 px-2.5 py-2 rounded-[8px] text-[12px] font-medium text-grey-35 hover:text-ink hover:bg-surface-weak transition-colors text-left"
                >
                  + Video
                </button>
                <button
                  onClick={() => addSection('quiz')}
                  className="flex-1 px-2.5 py-2 rounded-[8px] text-[12px] font-medium text-grey-35 hover:text-ink hover:bg-surface-weak transition-colors text-left"
                >
                  + Quiz
                </button>
              </div>
            )}
          </div>
        </aside>

        {/* ───── Middle: Content editor ───── */}
        <section className="flex-1 min-w-0 overflow-y-auto" style={{ background: 'var(--bg)' }}>
          {viewMode === 'course' || !activeSection ? (
            <CourseSettingsPane
              training={training}
              onUpdate={patchTraining}
              onChooseSection={(id) => { setActiveSectionId(id); setViewMode('section') }}
            />
          ) : activeSection.kind === 'quiz' ? (
            <QuizSectionEditorPane
              key={activeSection.id}
              section={activeSection}
              sectionNumber={training.sections.findIndex((s) => s.id === activeSection.id) + 1}
              onRenameSection={(title) => debouncedSaveTitle(activeSection.id, title)}
              onCreateQuiz={() => createQuiz(activeSection.id)}
              onQuizAction={(data) => quizAction(activeSection.id, data)}
            />
          ) : (
            <SectionEditorPane
              key={activeSection.id}
              section={activeSection}
              sectionNumber={training.sections.findIndex((s) => s.id === activeSection.id) + 1}
              onRenameSection={(title) => debouncedSaveTitle(activeSection.id, title)}
              onDescriptionChange={(text) => debouncedSaveDescription(activeSection.id, text)}
              onUploadVideo={(file, onProgress) => uploadAndAttach(activeSection.id, file, onProgress)}
              onRemoveVideo={() => removeVideoFromSection(activeSection.id)}
              onRemoveContent={(contentId) => removeContent(activeSection.id, contentId)}
            />
          )}
        </section>

        {/* ───── Right: Settings ───── */}
        <aside className="w-[340px] shrink-0 bg-white border-l border-surface-border overflow-y-auto">
          {viewMode === 'section' && activeSection ? (
            <SectionSettingsPane
              section={activeSection}
              videos={videos}
              onAttachVideo={(videoId) => upsertContent(activeSection.id, { type: 'video', videoId })}
              onSetRequiredWatch={(req) => upsertContent(activeSection.id, { type: 'video', requiredWatch: req })}
              onSetQuizPassingGrade={(grade) => quizAction(activeSection.id, { passingGrade: grade })}
              onDeleteSection={async () => {
                if (!confirm(`Delete section ${training.sections.findIndex((s) => s.id === activeSection.id) + 1}?`)) return
                await removeSection(activeSection.id)
              }}
            />
          ) : (
            <CourseSettingsRightPane training={training} onUpdate={patchTraining} />
          )}
        </aside>
      </div>

      {/* ─────── Publish pre-flight drawer ─────── */}
      {showPublishDrawer && (
        <PublishDrawer
          training={training}
          preflight={preflight}
          onClose={() => setShowPublishDrawer(false)}
          onPublish={async () => {
            await patchTraining({ isPublished: true })
            setShowPublishDrawer(false)
          }}
        />
      )}
    </div>
  )
}

// ───────────────────────── Middle pane — Course settings ─────────────────────────

function CourseSettingsPane({
  training,
  onUpdate,
  onChooseSection,
}: {
  training: Training
  onUpdate: (data: Partial<Training>) => void
  onChooseSection: (id: string) => void
}) {
  return (
    <div className="p-8 lg:p-10 max-w-[720px]">
      <Eyebrow size="xs" className="mb-1.5">Course</Eyebrow>
      <h2 className="text-[24px] font-semibold text-ink tracking-tight2 mb-6">{training.title}</h2>

      <p className="text-[13px] text-grey-35 mb-6 leading-relaxed max-w-[580px]">
        Course-level settings live in the right pane. Pick a section to the left to edit its video, description, and quiz — or add a new one.
      </p>

      {training.sections.length > 0 && (
        <div className="mb-8">
          <div className="eyebrow mb-2">Quick jump</div>
          <div className="space-y-2">
            {training.sections.map((s, i) => (
              <button
                key={s.id}
                onClick={() => onChooseSection(s.id)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[10px] border border-surface-border bg-white hover:bg-surface-weak text-left transition-colors"
              >
                <div className="w-[22px] h-[22px] rounded-full font-mono text-[11px] font-semibold flex items-center justify-center text-grey-35" style={{ background: '#F1EBE1' }}>
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate">{s.title}</div>
                  <div className="font-mono text-[11px] text-grey-35 truncate">
                    {s.kind === 'quiz'
                      ? `Quiz · ${s.quiz?.questions.length ?? 0} Q`
                      : fmtDuration(videoContent(s)?.video?.durationSeconds ?? null)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4">
        <label className="block">
          <div className="eyebrow mb-1.5">Title</div>
          <input
            type="text"
            defaultValue={training.title}
            onBlur={(e) => { if (e.target.value !== training.title) onUpdate({ title: e.target.value }) }}
            className="w-full px-3 py-2.5 border border-surface-border rounded-[10px] text-ink text-[14px] focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
        </label>
        <label className="block">
          <div className="eyebrow mb-1.5">Description</div>
          <textarea
            defaultValue={training.description || ''}
            rows={4}
            onBlur={(e) => { if (e.target.value !== (training.description || '')) onUpdate({ description: e.target.value }) }}
            className="w-full px-3 py-2.5 border border-surface-border rounded-[10px] text-ink text-[14px] focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            placeholder="Short description of the course…"
          />
        </label>
      </div>
    </div>
  )
}

// ───────────────────────── Middle pane — Section editor ─────────────────────────

function SectionEditorPane({
  section,
  sectionNumber,
  onRenameSection,
  onDescriptionChange,
  onUploadVideo,
  onRemoveVideo,
  onRemoveContent,
}: {
  section: Section
  sectionNumber: number
  onRenameSection: (title: string) => void
  onDescriptionChange: (text: string) => void
  onUploadVideo: (file: File, onProgress: (p: number) => void) => Promise<void>
  onRemoveVideo: () => void
  onRemoveContent: (contentId: string) => void
}) {
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const vc = videoContent(section)
  const tc = textContent(section)
  const extras = extraContents(section)
  const duration = fmtDuration(vc?.video?.durationSeconds ?? null)

  const extraLabel = (c: Content): string => {
    if (c.type === 'video') return c.video?.displayName || c.video?.filename || 'Untitled video'
    if (c.type === 'text') {
      const t = (c.textContent || '').trim()
      return t ? (t.length > 60 ? t.slice(0, 60) + '…' : t) : 'Empty text block'
    }
    return c.type
  }

  const removeAllExtras = () => {
    if (!confirm(`Remove ${extras.length} hidden lesson${extras.length === 1 ? '' : 's'} from this section? This cannot be undone.`)) return
    extras.forEach((c) => onRemoveContent(c.id))
  }

  const pickFile = () => fileRef.current?.click()
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadProgress(0)
    await onUploadVideo(file, (p) => setUploadProgress(p))
    setUploadProgress(null)
    if (fileRef.current) fileRef.current.value = ''
  }
  const onDropVideo = async (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    setUploadProgress(0)
    await onUploadVideo(file, (p) => setUploadProgress(p))
    setUploadProgress(null)
  }

  return (
    <div className="p-8 lg:p-10 max-w-[720px] mx-auto">
      <Eyebrow size="xs" className="mb-1">
        Section {sectionNumber} · {duration}
      </Eyebrow>

      <InlineEditableHeading
        value={section.title}
        onChange={onRenameSection}
      />

      {/* ─── Hidden-extras warning ─── */}
      {extras.length > 0 && (
        <div className="mb-6 rounded-[12px] border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 mt-0.5 text-amber-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
            </svg>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-medium text-amber-900">
                {extras.length} hidden {extras.length === 1 ? 'lesson is' : 'lessons are'} still shown to candidates
              </div>
              <div className="text-[13px] text-amber-800 leading-relaxed mt-1">
                The candidate viewer renders every content row in this section, but this editor only surfaces the first video and first description. Remove the extras below or they&apos;ll keep appearing in the published training.
              </div>
              <ul className="mt-3 space-y-1.5">
                {extras.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 rounded-[8px] bg-white border border-amber-200 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[10px] uppercase text-amber-700 tracking-wider">{c.type}</div>
                      <div className="text-[13px] text-ink truncate">{extraLabel(c)}</div>
                    </div>
                    <button
                      onClick={() => onRemoveContent(c.id)}
                      className="shrink-0 text-[12px] font-medium px-2.5 py-1 rounded-[8px] hover:bg-[color:var(--danger-bg)] transition-colors"
                      style={{ color: 'var(--danger-fg)' }}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              {extras.length > 1 && (
                <button
                  onClick={removeAllExtras}
                  className="mt-3 text-[12px] font-medium px-3 py-1.5 rounded-[8px] border border-amber-300 bg-white hover:bg-amber-100 text-amber-900"
                >
                  Remove all {extras.length}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Video block ─── */}
      <div className="mb-6">
        {vc?.video ? (
          <div className="relative rounded-[14px] overflow-hidden border border-surface-border bg-[#1a1815] aspect-video">
            {vc.video.status === 'transcoding' || vc.video.status === 'uploading' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
                <div className="w-8 h-8 mb-2 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
                <p className="text-xs font-mono uppercase" style={{ letterSpacing: '0.08em' }}>Transcoding…</p>
              </div>
            ) : (
              // Same player the candidate viewer uses: HLS via hls.js when a
              // manifest exists, raw source URL otherwise.
              /* eslint-disable-next-line jsx-a11y/media-has-caption */
              <DashboardVideoPreview
                src={vc.video.url}
                hlsUrl={vc.video.hlsManifestUrl}
                poster={vc.video.posterUrl || undefined}
                className="w-full h-full object-contain bg-black"
              />
            )}
          </div>
        ) : (
          <div
            data-dropzone
            onClick={pickFile}
            onDragOver={(e) => { e.preventDefault(); (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--brand-primary)' }}
            onDragLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)' }}
            onDrop={onDropVideo}
            className="aspect-video rounded-[14px] border-2 border-dashed cursor-pointer flex flex-col items-center justify-center text-center px-6 transition-colors"
            style={{ borderColor: 'var(--border)', background: '#fff' }}
          >
            {uploadProgress !== null ? (
              <>
                <div className="w-10 h-10 rounded-full border-2 border-brand-200 border-t-[color:var(--brand-primary)] animate-spin mb-3" />
                <div className="font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>
                  Uploading · {uploadProgress}%
                </div>
              </>
            ) : (
              <>
                <svg className="w-8 h-8 text-grey-50 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
                <div className="text-[14px] text-ink font-medium mb-1">Drop a video here or click to browse</div>
                <div className="font-mono text-[11px] uppercase text-grey-50" style={{ letterSpacing: '0.1em' }}>
                  MP4, MOV, WEBM · up to 500MB
                </div>
              </>
            )}
            <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={onFile} />
          </div>
        )}

        {vc?.video && (
          <div className="mt-3 flex items-center gap-2.5">
            <label>
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-surface-border rounded-[10px] text-[12px] font-medium text-ink bg-white hover:bg-surface-light cursor-pointer">
                Replace video
              </span>
              <input type="file" accept="video/*" className="hidden" onChange={onFile} />
            </label>
            <button
              onClick={onRemoveVideo}
              className="text-[12px] font-medium px-3 py-1.5 rounded-[10px] hover:bg-[color:var(--danger-bg)] transition-colors"
              style={{ color: 'var(--danger-fg)' }}
            >
              Remove
            </button>
          </div>
        )}
      </div>

      {/* ─── Description block ─── */}
      <div className="mb-8">
        <div className="eyebrow mb-1.5">Description</div>
        <textarea
          key={section.id /* reset when switching sections */}
          defaultValue={tc?.textContent || ''}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={6}
          className="w-full px-3.5 py-3 border border-surface-border rounded-[10px] text-ink text-[14px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          placeholder="What will candidates learn in this section?"
        />
      </div>

    </div>
  )
}

function QuizSectionEditorPane({
  section,
  sectionNumber,
  onRenameSection,
  onCreateQuiz,
  onQuizAction,
}: {
  section: Section
  sectionNumber: number
  onRenameSection: (title: string) => void
  onCreateQuiz: () => void
  onQuizAction: (data: Record<string, unknown>) => void
}) {
  return (
    <div className="p-8 lg:p-10 max-w-[720px] mx-auto">
      <Eyebrow size="xs" className="mb-1">
        Section {sectionNumber} · Quiz
      </Eyebrow>
      <InlineEditableHeading value={section.title} onChange={onRenameSection} />
      {section.quiz ? (
        <QuizBlock quiz={section.quiz} onQuizAction={onQuizAction} />
      ) : (
        <button
          onClick={onCreateQuiz}
          className="w-full text-left p-4 rounded-[14px] border border-dashed border-surface-border hover:border-[color:var(--brand-primary)] hover:bg-brand-50/40 transition-colors"
        >
          <div className="text-[14px] font-medium text-ink">+ Create quiz</div>
          <div className="text-[12px] text-grey-35 mt-0.5">Add questions candidates must pass to complete this section.</div>
        </button>
      )}
    </div>
  )
}

// ───────────────────────── Inline heading ─────────────────────────

function InlineEditableHeading({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  if (editing) {
    return (
      <input
        autoFocus
        value={local}
        onChange={(e) => { setLocal(e.target.value); onChange(e.target.value) }}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur() }
          if (e.key === 'Escape') { setLocal(value); setEditing(false) }
        }}
        className="w-full text-[24px] font-semibold text-ink tracking-tight2 mb-5 bg-transparent border-b border-surface-border focus:outline-none focus:border-[color:var(--brand-primary)]"
      />
    )
  }
  return (
    <h2
      className="text-[24px] font-semibold text-ink tracking-tight2 mb-5 cursor-text hover:bg-surface-weak rounded-[6px] -mx-1 px-1 transition-colors"
      onClick={() => setEditing(true)}
      title="Click to rename"
    >
      {value}
    </h2>
  )
}

// ───────────────────────── Quiz block ─────────────────────────

function QuizBlock({
  quiz,
  onQuizAction,
}: {
  quiz: Quiz
  onQuizAction: (data: Record<string, unknown>) => void
}) {
  const [showImport, setShowImport] = useState(false)
  return (
    <div className="bg-white border border-surface-border rounded-[14px] p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <Eyebrow size="xs" className="mb-0.5">Questions</Eyebrow>
          <div className="text-[14px] font-semibold text-ink">
            {quiz.questions.length} question{quiz.questions.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowImport(true)}
            className="text-[12px] font-medium text-grey-35 hover:text-ink"
          >
            Paste from doc
          </button>
          <span className="text-grey-50">·</span>
          <button
            onClick={() => onQuizAction({ action: 'add_question', questionText: 'New question', questionType: 'single', options: defaultOptionsFor('single') })}
            className="text-[12px] font-medium text-grey-35 hover:text-ink"
          >
            + Add question
          </button>
        </div>
      </div>
      {showImport && (
        <ImportFromDocModal
          onClose={() => setShowImport(false)}
          onImport={async (questions) => {
            await onQuizAction({ action: 'bulk_add_questions', questions })
            setShowImport(false)
          }}
        />
      )}

      {/* Quiz-level feedback mode */}
      <div className="mb-4 p-3 rounded-[10px] bg-surface-weak border border-surface-border">
        <label className="block text-[12px] font-medium text-ink mb-1">Feedback after submit</label>
        <select
          value={quiz.feedbackMode}
          onChange={(e) => onQuizAction({ feedbackMode: e.target.value as FeedbackMode })}
          className="w-full px-2 py-1.5 text-[13px] bg-white border border-surface-border rounded-[8px] focus:outline-none focus:border-[color:var(--brand-primary)]"
        >
          <option value="none">Hide results — show only pass / fail</option>
          <option value="correctness">Show right vs wrong per question</option>
          <option value="explanation">Show right vs wrong + per-option explanation</option>
        </select>
      </div>

      {quiz.questions.length === 0 ? (
        <div className="text-center py-6 text-[13px] text-grey-35">
          No questions yet. Add one to complete this quiz section.
        </div>
      ) : (
        <div className="space-y-4">
          {quiz.questions.map((q, i) => (
            <QuestionEditor key={q.id} q={q} index={i} onQuizAction={onQuizAction} />
          ))}
        </div>
      )}
    </div>
  )
}

// ───────────────────────── Paste-from-doc importer ─────────────────────────

function ImportFromDocModal({
  onClose,
  onImport,
}: {
  onClose: () => void
  onImport: (questions: ParsedQuestion[]) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [importing, setImporting] = useState(false)
  const result = useMemo<ParseResult | null>(() => (text.trim() ? parseQuizDoc(text) : null), [text])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        className="bg-white rounded-[14px] w-full max-w-[720px] max-h-[85vh] flex flex-col border border-surface-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-surface-border flex items-center justify-between">
          <div>
            <Eyebrow size="xs" className="mb-0.5">Import</Eyebrow>
            <div className="text-[15px] font-semibold text-ink">Paste questions from a doc</div>
          </div>
          <button onClick={onClose} className="text-[12px] text-grey-35 hover:text-ink">Close</button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1">
          <p className="text-[12px] text-grey-35 mb-3 leading-relaxed">
            Copy the body of your Google Doc and paste it below. Expected format:
          </p>
          <pre className="text-[11px] bg-surface-weak border border-surface-border rounded-[8px] p-3 mb-4 text-grey-35 whitespace-pre-wrap font-mono leading-relaxed">{`1. Question text?
 A. Option text
 B. Option text
 C. Option text
Correct answers: A, B`}</pre>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste here…"
            rows={12}
            className="w-full px-3 py-2 text-[13px] bg-white border border-surface-border rounded-[8px] focus:outline-none focus:border-[color:var(--brand-primary)] font-mono leading-relaxed"
          />

          {result && (
            <div className="mt-4">
              {result.questions.length > 0 && (
                <div className="text-[12px] text-ink mb-2">
                  Found <span className="font-semibold">{result.questions.length}</span> question{result.questions.length === 1 ? '' : 's'} ·{' '}
                  {result.questions.filter((q) => q.questionType === 'multiselect').length} multi-select,{' '}
                  {result.questions.filter((q) => q.questionType === 'single').length} single
                </div>
              )}
              {result.errors.length > 0 && (
                <div className="text-[12px] text-red-600 space-y-1 mb-2">
                  {result.errors.map((e, i) => <div key={i}>• {e}</div>)}
                </div>
              )}
              {result.questions.length > 0 && (
                <div className="space-y-2 max-h-[260px] overflow-y-auto">
                  {result.questions.map((q, i) => (
                    <div key={i} className="border border-surface-border rounded-[8px] p-3">
                      <div className="text-[12px] font-medium text-ink mb-1">
                        {i + 1}. {q.questionText}{' '}
                        <span className="font-mono text-[10px] uppercase text-grey-35 ml-1" style={{ letterSpacing: '0.1em' }}>
                          {q.questionType}
                        </span>
                      </div>
                      <ul className="text-[12px] text-grey-35 space-y-0.5">
                        {q.options.map((o, oi) => (
                          <li key={oi} className={o.isCorrect ? 'text-green-600' : ''}>
                            {String.fromCharCode(65 + oi)}. {o.text} {o.isCorrect && <span className="text-[10px]">✓</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-surface-border flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            disabled={!result || result.questions.length === 0 || importing}
            onClick={async () => {
              if (!result || result.questions.length === 0) return
              setImporting(true)
              try {
                await onImport(result.questions)
              } finally {
                setImporting(false)
              }
            }}
          >
            {importing ? 'Importing…' : `Import ${result?.questions.length ?? 0} question${result?.questions.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────── Per-question editor ─────────────────────────

function QuestionEditor({ q, index, onQuizAction }: { q: Question; index: number; onQuizAction: (data: Record<string, unknown>) => void }) {
  const updateOptions = (next: unknown) => onQuizAction({ action: 'update_question', questionId: q.id, options: next })

  const changeType = (next: string) => {
    if (next === q.questionType) return
    onQuizAction({
      action: 'update_question',
      questionId: q.id,
      questionType: next,
      options: defaultOptionsFor(next),
    })
  }

  return (
    <div className="pb-4 border-b border-surface-divider last:border-0 last:pb-0">
      <div className="flex items-start gap-2 mb-2">
        <div className="font-mono text-[11px] text-grey-50 pt-2 w-6" style={{ letterSpacing: '0.08em' }}>Q{index + 1}</div>
        <div className="flex-1 space-y-2">
          <input
            defaultValue={q.questionText}
            onBlur={(e) => { if (e.target.value !== q.questionText) onQuizAction({ action: 'update_question', questionId: q.id, questionText: e.target.value }) }}
            className="w-full px-3 py-1.5 bg-transparent border-b border-surface-border text-[14px] text-ink focus:outline-none focus:border-[color:var(--brand-primary)]"
            placeholder="Question text"
          />
          <select
            value={q.questionType}
            onChange={(e) => changeType(e.target.value)}
            className="px-2 py-1 text-[12px] bg-white border border-surface-border rounded-[6px] focus:outline-none focus:border-[color:var(--brand-primary)]"
          >
            <option value="single">Single choice</option>
            <option value="multiselect">Multiple choice</option>
            <option value="image">Image choice</option>
            <option value="text">Short text answer</option>
            <option value="number">Number answer</option>
            <option value="file">File upload</option>
          </select>
        </div>
        <button
          onClick={() => onQuizAction({ action: 'delete_question', questionId: q.id })}
          className="text-grey-50 hover:text-[color:var(--danger-fg)] text-[18px] px-2"
          title="Delete question"
        >
          ×
        </button>
      </div>
      <div className="ml-8 mt-3">
        {(q.questionType === 'single' || q.questionType === 'multiselect') && (
          <ChoiceOptionsEditor
            options={(q.options as ChoiceOpt[] | null) ?? []}
            multi={q.questionType === 'multiselect'}
            onChange={updateOptions}
          />
        )}
        {q.questionType === 'image' && (
          <ImageChoiceOptionsEditor
            options={(q.options as ChoiceOpt[] | null) ?? []}
            onChange={updateOptions}
          />
        )}
        {q.questionType === 'text' && (
          <TextAnswerEditor
            opts={(q.options as TextOpts | null) ?? { acceptedAnswers: [''] }}
            onChange={updateOptions}
          />
        )}
        {q.questionType === 'number' && (
          <NumberAnswerEditor
            opts={(q.options as NumberOpts | null) ?? { value: 0 }}
            onChange={updateOptions}
          />
        )}
        {q.questionType === 'file' && (
          <FileAnswerEditor
            opts={(q.options as FileOpts | null) ?? { acceptedMimeTypes: [], maxSizeMb: 25 }}
            onChange={updateOptions}
          />
        )}
      </div>
    </div>
  )
}

// ───────────────────────── Per-type option editors ─────────────────────────

function ChoiceOptionsEditor({ options, multi, onChange }: { options: ChoiceOpt[]; multi: boolean; onChange: (next: ChoiceOpt[]) => void }) {
  return (
    <div className="space-y-1.5">
      {options.map((opt, oi) => (
        <div key={oi} className="flex items-center gap-2">
          <input
            type={multi ? 'checkbox' : 'radio'}
            checked={!!opt.isCorrect}
            onChange={() => {
              const next = options.map((o, j) => ({
                ...o,
                isCorrect: multi ? (j === oi ? !o.isCorrect : o.isCorrect) : j === oi,
              }))
              onChange(next)
            }}
            className="accent-[color:var(--brand-primary)]"
            title="Mark correct"
          />
          <input
            defaultValue={opt.text || ''}
            onBlur={(e) => {
              if (e.target.value === (opt.text || '')) return
              onChange(options.map((o, j) => (j === oi ? { ...o, text: e.target.value } : o)))
            }}
            placeholder="Option text"
            className="flex-1 px-2 py-1 text-[13px] text-ink bg-transparent border-b border-surface-border focus:outline-none focus:border-[color:var(--brand-primary)]"
          />
          <input
            defaultValue={opt.hint || ''}
            onBlur={(e) => {
              if (e.target.value === (opt.hint || '')) return
              onChange(options.map((o, j) => (j === oi ? { ...o, hint: e.target.value } : o)))
            }}
            placeholder="Hint (shown in explanation feedback)"
            className="w-[200px] px-2 py-1 text-[12px] text-grey-35 bg-transparent border-b border-surface-border focus:outline-none focus:border-[color:var(--brand-primary)]"
          />
          <button
            onClick={() => onChange(options.filter((_, j) => j !== oi))}
            className="text-grey-50 hover:text-[color:var(--danger-fg)] text-[14px] w-6"
            title="Remove option"
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...options, { text: `Option ${String.fromCharCode(65 + options.length)}`, isCorrect: false }])}
        className="text-[11px] font-mono uppercase text-grey-35 hover:text-ink"
        style={{ letterSpacing: '0.08em' }}
      >
        + Add option
      </button>
    </div>
  )
}

function ImageChoiceOptionsEditor({ options, onChange }: { options: ChoiceOpt[]; onChange: (next: ChoiceOpt[]) => void }) {
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null)

  const uploadAt = async (idx: number, file: File) => {
    setUploadingIdx(idx)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/pictures', { method: 'POST', body: fd })
      if (res.ok) {
        const pic = await res.json()
        onChange(options.map((o, j) => (j === idx ? { ...o, imageUrl: pic.url, pictureId: pic.id } : o)))
      }
    } finally {
      setUploadingIdx(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        {options.map((opt, oi) => (
          <div key={oi} className="border border-surface-border rounded-[10px] p-2 space-y-2 bg-surface-weak">
            <div className="aspect-video rounded-[8px] bg-white border border-surface-border overflow-hidden flex items-center justify-center relative">
              {opt.imageUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={opt.imageUrl} alt={opt.text || 'option'} className="w-full h-full object-contain" />
              ) : (
                <span className="text-[11px] text-grey-50">No image</span>
              )}
              {uploadingIdx === oi && (
                <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
                  <span className="text-[11px] font-mono uppercase text-grey-35">Uploading…</span>
                </div>
              )}
            </div>
            <label className="block">
              <span className="text-[11px] font-mono uppercase text-grey-50 cursor-pointer hover:text-ink">
                {opt.imageUrl ? 'Replace image' : 'Upload image'}
              </span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAt(oi, f) }}
              />
            </label>
            <input
              defaultValue={opt.text || ''}
              onBlur={(e) => {
                if (e.target.value === (opt.text || '')) return
                onChange(options.map((o, j) => (j === oi ? { ...o, text: e.target.value } : o)))
              }}
              placeholder="Caption (optional)"
              className="w-full px-2 py-1 text-[12px] bg-white border border-surface-border rounded-[6px] focus:outline-none focus:border-[color:var(--brand-primary)]"
            />
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-[11px] text-ink">
                <input
                  type="checkbox"
                  checked={!!opt.isCorrect}
                  onChange={() => onChange(options.map((o, j) => (j === oi ? { ...o, isCorrect: !o.isCorrect } : o)))}
                  className="accent-[color:var(--brand-primary)]"
                />
                Correct
              </label>
              <button
                onClick={() => onChange(options.filter((_, j) => j !== oi))}
                className="text-[11px] text-grey-50 hover:text-[color:var(--danger-fg)]"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...options, { isCorrect: false }])}
        className="text-[11px] font-mono uppercase text-grey-35 hover:text-ink"
        style={{ letterSpacing: '0.08em' }}
      >
        + Add image option
      </button>
    </div>
  )
}

function TextAnswerEditor({ opts, onChange }: { opts: TextOpts; onChange: (next: TextOpts) => void }) {
  const accepted = opts.acceptedAnswers ?? ['']
  return (
    <div className="space-y-2 bg-surface-weak border border-surface-border rounded-[10px] p-3">
      <div className="text-[11px] font-mono uppercase text-grey-50 mb-1" style={{ letterSpacing: '0.08em' }}>Accepted answers (any match passes)</div>
      {accepted.map((a, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            defaultValue={a}
            onBlur={(e) => {
              if (e.target.value === a) return
              const next = accepted.map((v, j) => (j === i ? e.target.value : v))
              onChange({ ...opts, acceptedAnswers: next })
            }}
            placeholder="Correct answer"
            className="flex-1 px-2 py-1 text-[13px] bg-white border border-surface-border rounded-[6px] focus:outline-none focus:border-[color:var(--brand-primary)]"
          />
          <button
            onClick={() => onChange({ ...opts, acceptedAnswers: accepted.filter((_, j) => j !== i) })}
            className="text-grey-50 hover:text-[color:var(--danger-fg)] text-[14px] w-6"
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange({ ...opts, acceptedAnswers: [...accepted, ''] })}
        className="text-[11px] font-mono uppercase text-grey-35 hover:text-ink"
        style={{ letterSpacing: '0.08em' }}
      >
        + Add accepted answer
      </button>
      <label className="flex items-center gap-2 text-[12px] text-ink mt-2">
        <input
          type="checkbox"
          checked={!!opts.caseSensitive}
          onChange={() => onChange({ ...opts, caseSensitive: !opts.caseSensitive })}
          className="accent-[color:var(--brand-primary)]"
        />
        Match exact case
      </label>
      <input
        defaultValue={opts.hint || ''}
        onBlur={(e) => onChange({ ...opts, hint: e.target.value })}
        placeholder="Hint (shown in explanation feedback)"
        className="w-full px-2 py-1 text-[12px] bg-white border border-surface-border rounded-[6px] focus:outline-none focus:border-[color:var(--brand-primary)]"
      />
    </div>
  )
}

function NumberAnswerEditor({ opts, onChange }: { opts: NumberOpts; onChange: (next: NumberOpts) => void }) {
  return (
    <div className="space-y-2 bg-surface-weak border border-surface-border rounded-[10px] p-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[11px] font-mono uppercase text-grey-50 mb-1" style={{ letterSpacing: '0.08em' }}>Correct value</div>
          <input
            type="number"
            defaultValue={opts.value}
            onBlur={(e) => {
              const n = Number(e.target.value)
              if (!Number.isFinite(n) || n === opts.value) return
              onChange({ ...opts, value: n })
            }}
            className="w-full px-2 py-1 text-[13px] bg-white border border-surface-border rounded-[6px] focus:outline-none focus:border-[color:var(--brand-primary)]"
          />
        </div>
        <div>
          <div className="text-[11px] font-mono uppercase text-grey-50 mb-1" style={{ letterSpacing: '0.08em' }}>± Tolerance</div>
          <input
            type="number"
            defaultValue={opts.tolerance ?? 0}
            onBlur={(e) => {
              const n = Number(e.target.value)
              if (!Number.isFinite(n) || n === (opts.tolerance ?? 0)) return
              onChange({ ...opts, tolerance: n })
            }}
            className="w-full px-2 py-1 text-[13px] bg-white border border-surface-border rounded-[6px] focus:outline-none focus:border-[color:var(--brand-primary)]"
          />
        </div>
      </div>
      <input
        defaultValue={opts.hint || ''}
        onBlur={(e) => onChange({ ...opts, hint: e.target.value })}
        placeholder="Hint (shown in explanation feedback)"
        className="w-full px-2 py-1 text-[12px] bg-white border border-surface-border rounded-[6px] focus:outline-none focus:border-[color:var(--brand-primary)]"
      />
    </div>
  )
}

function FileAnswerEditor({ opts, onChange }: { opts: FileOpts; onChange: (next: FileOpts) => void }) {
  const COMMON_PRESETS: { label: string; mime: string[] }[] = [
    { label: 'PDF', mime: ['application/pdf'] },
    { label: 'Images', mime: ['image/png', 'image/jpeg', 'image/webp'] },
    { label: 'Word', mime: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
    { label: 'Spreadsheet', mime: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
    { label: 'Any', mime: [] },
  ]
  const accepted = opts.acceptedMimeTypes ?? []
  const isPresetActive = (preset: string[]) => {
    if (preset.length === 0) return accepted.length === 0
    return preset.length === accepted.length && preset.every((m) => accepted.includes(m))
  }
  return (
    <div className="space-y-2 bg-surface-weak border border-surface-border rounded-[10px] p-3">
      <div className="text-[11px] font-mono uppercase text-grey-50 mb-1" style={{ letterSpacing: '0.08em' }}>Accepted file types</div>
      <div className="flex flex-wrap gap-1.5">
        {COMMON_PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => onChange({ ...opts, acceptedMimeTypes: p.mime })}
            className={`text-[11px] px-2.5 py-1 rounded-[6px] border ${isPresetActive(p.mime) ? 'border-[color:var(--brand-primary)] bg-brand-50 text-[color:var(--brand-primary)]' : 'border-surface-border bg-white text-grey-35 hover:text-ink'}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {accepted.length > 0 && (
        <div className="text-[11px] text-grey-50 mt-1">Mime: {accepted.join(', ')}</div>
      )}
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[11px] font-mono uppercase text-grey-50" style={{ letterSpacing: '0.08em' }}>Max size</span>
        <input
          type="number"
          min={1}
          max={50}
          defaultValue={opts.maxSizeMb ?? 25}
          onBlur={(e) => {
            const n = Math.min(50, Math.max(1, Number(e.target.value) || 25))
            if (n === (opts.maxSizeMb ?? 25)) return
            onChange({ ...opts, maxSizeMb: n })
          }}
          className="w-20 px-2 py-1 text-[13px] bg-white border border-surface-border rounded-[6px] focus:outline-none focus:border-[color:var(--brand-primary)]"
        />
        <span className="text-[12px] text-grey-50">MB (server cap: 50MB)</span>
      </div>
      <p className="text-[11px] text-grey-50 italic mt-1">
        File-upload questions auto-pass when the candidate uploads a file matching these constraints.
      </p>
    </div>
  )
}

// ───────────────────────── Right pane — Section settings ─────────────────────────

function SectionSettingsPane({
  section,
  videos,
  onAttachVideo,
  onSetRequiredWatch,
  onSetQuizPassingGrade,
  onDeleteSection,
}: {
  section: Section
  videos: Video[]
  onAttachVideo: (videoId: string) => void
  onSetRequiredWatch: (required: boolean) => void
  onSetQuizPassingGrade: (grade: number) => void
  onDeleteSection: () => void
}) {
  const vc = videoContent(section)
  const isQuiz = section.kind === 'quiz'

  return (
    <div className="p-5">
      <Eyebrow size="xs" className="mb-3">
        {isQuiz ? 'Quiz section' : 'Video section'}
      </Eyebrow>

      {isQuiz ? (
        <>
          <Field label="Passing grade">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                defaultValue={section.quiz?.passingGrade ?? 80}
                onBlur={(e) => {
                  const n = Number(e.target.value)
                  if (section.quiz && n !== section.quiz.passingGrade) onSetQuizPassingGrade(n)
                }}
                className="w-20 px-2.5 py-1.5 border border-surface-border rounded-[10px] text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                disabled={!section.quiz}
              />
              <span className="font-mono text-[11px] text-grey-50">%</span>
            </div>
          </Field>
          <Field label="Questions">
            <div className="font-mono text-[13px] text-ink">
              {section.quiz?.questions.length ?? 0}
            </div>
            {!section.quiz?.questions.length && (
              <div className="mt-1.5 font-mono text-[10px] uppercase text-grey-50" style={{ letterSpacing: '0.08em' }}>
                Add ≥1 question to publish
              </div>
            )}
          </Field>
        </>
      ) : (
        <>
          <Field label="Video source">
            <select
              value={vc?.videoId || ''}
              onChange={(e) => e.target.value && onAttachVideo(e.target.value)}
              className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-[13px] text-ink bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            >
              <option value="">None attached</option>
              {videos.map((v) => {
                const showBoth = v.displayName && v.displayName !== v.filename
                const label = showBoth ? `${v.filename} — ${v.displayName}` : (v.displayName || v.filename)
                return (
                  <option key={v.id} value={v.id}>
                    {label}
                    {v.durationSeconds ? ` · ${fmtDuration(v.durationSeconds)}` : ''}
                  </option>
                )
              })}
            </select>
          </Field>
          <Field label="Watch full video">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <button
                type="button"
                onClick={() => onSetRequiredWatch(!(vc?.requiredWatch ?? true))}
                disabled={!vc}
                className="w-10 h-5 rounded-full transition-colors relative disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: (vc?.requiredWatch ?? true) ? 'var(--brand-primary)' : '#D1CFCA' }}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${(vc?.requiredWatch ?? true) ? 'left-5' : 'left-0.5'}`} />
              </button>
              <span className="text-[13px] text-ink">
                {(vc?.requiredWatch ?? true) ? 'Required' : 'Optional'}
              </span>
            </label>
            <div className="mt-1.5 font-mono text-[10px] uppercase text-grey-50" style={{ letterSpacing: '0.08em' }}>
              {(vc?.requiredWatch ?? true)
                ? 'Candidate must finish the video before continuing'
                : 'Candidate can skip the video'}
            </div>
          </Field>
          <Field label="Estimated duration">
            <div className="font-mono text-[13px] text-ink">
              {fmtDuration(vc?.video?.durationSeconds ?? null)}
            </div>
          </Field>
        </>
      )}

      <div className="mt-6 mb-3"><Eyebrow size="xs">Enrollment</Eyebrow></div>
      <div className="grid grid-cols-2 gap-2">
        <MiniStat label="Enrolled" value="—" />
        <MiniStat label="Completed" value="—" />
        <MiniStat label="Avg. time" value="—" />
        {isQuiz && <MiniStat label="Quiz pass rate" value="—" />}
      </div>

      <div className="mt-6 pt-5 border-t border-surface-divider">
        <button
          onClick={onDeleteSection}
          className="w-full text-[12px] font-medium py-2 rounded-[10px] hover:bg-[color:var(--danger-bg)] transition-colors"
          style={{ color: 'var(--danger-fg)' }}
        >
          Delete section
        </button>
      </div>
    </div>
  )
}

// ───────────────────────── Right pane — Course settings ─────────────────────────

function CourseSettingsRightPane({
  training,
  onUpdate,
}: {
  training: Training
  onUpdate: (data: Partial<Training>) => void
}) {
  const coverRef = useRef<HTMLInputElement>(null)
  const [uploadingCover, setUploadingCover] = useState(false)

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingCover(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/uploads/logo', { method: 'POST', body: formData })
      if (res.ok) {
        const { url } = await res.json()
        onUpdate({ coverImage: url })
      }
    } finally {
      setUploadingCover(false)
      if (coverRef.current) coverRef.current.value = ''
    }
  }

  return (
    <div className="p-5">
      <Eyebrow size="xs" className="mb-3">Course settings</Eyebrow>

      <Field label="Cover image">
        {training.coverImage ? (
          <div className="relative rounded-[10px] overflow-hidden border border-surface-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={training.coverImage} alt="Cover" className="w-full h-28 object-cover" />
            <button
              onClick={() => onUpdate({ coverImage: null })}
              className="absolute top-2 right-2 w-6 h-6 bg-black/50 text-white rounded-full text-xs"
            >
              ×
            </button>
          </div>
        ) : (
          <label className="block w-full h-24 border-2 border-dashed border-surface-border rounded-[10px] cursor-pointer hover:border-[color:var(--brand-primary)] transition-colors flex items-center justify-center">
            <span className="text-[11px] text-grey-35">{uploadingCover ? 'Uploading…' : 'Upload image'}</span>
            <input ref={coverRef} type="file" accept="image/*" onChange={handleCoverUpload} className="hidden" disabled={uploadingCover} />
          </label>
        )}
      </Field>

      <Field label="Public slug">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] text-grey-50">/t/</span>
          <input
            type="text"
            defaultValue={training.slug}
            onBlur={(e) => { if (e.target.value !== training.slug) onUpdate({ slug: e.target.value } as Partial<Training>) }}
            className="flex-1 px-2.5 py-1.5 border border-surface-border rounded-[10px] text-[13px] text-ink font-mono focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
        </div>
      </Field>

      <Field label="Passing grade">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={100}
            defaultValue={training.passingGrade}
            onBlur={(e) => {
              const n = Number(e.target.value)
              if (n !== training.passingGrade) onUpdate({ passingGrade: n } as Partial<Training>)
            }}
            className="w-20 px-2.5 py-1.5 border border-surface-border rounded-[10px] text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
          <span className="font-mono text-[11px] text-grey-50">%</span>
        </div>
      </Field>

      <Field label="Section order">
        <div className="inline-flex w-full rounded-[10px] bg-surface-weak p-0.5">
          {([
            { v: 'sequential' as const, l: 'Sequential' },
            { v: 'any' as const, l: 'Any order' },
          ]).map((o) => (
            <button
              key={o.v}
              onClick={() => onUpdate({ sectionOrder: o.v } as Partial<Training>)}
              className={`flex-1 px-2 py-1.5 text-[12px] font-medium rounded-[8px] transition-colors ${
                training.sectionOrder === o.v ? 'bg-white text-ink shadow-sm' : 'text-grey-35 hover:text-ink'
              }`}
            >
              {o.l}
            </button>
          ))}
        </div>
        <div className="mt-1.5 font-mono text-[10px] uppercase text-grey-50" style={{ letterSpacing: '0.08em' }}>
          {training.sectionOrder === 'sequential'
            ? 'Candidates finish each section before unlocking the next'
            : 'Candidates can start any section in any order'}
        </div>
      </Field>

      <Field label="Status">
        <Badge tone={training.isPublished ? 'success' : 'brand'}>
          {training.isPublished ? 'Published' : 'Draft'}
        </Badge>
      </Field>
    </div>
  )
}

// ───────────────────────── Small helpers ─────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-4">
      <div className="font-mono text-[10px] uppercase text-grey-35 mb-1.5" style={{ letterSpacing: '0.1em' }}>
        {label}
      </div>
      {children}
    </label>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] p-2.5" style={{ background: '#F7F3EB' }}>
      <div className="font-mono text-[10px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>
        {label}
      </div>
      <div className="text-[15px] font-semibold text-ink mt-0.5">{value}</div>
    </div>
  )
}

// ───────────────────────── Publish pre-flight ─────────────────────────

type PreflightCheck = { label: string; ok: boolean; blocking: boolean; sectionHint?: string }

function computePreflight(training: Training): PreflightCheck[] {
  const checks: PreflightCheck[] = []
  for (let i = 0; i < training.sections.length; i++) {
    const s = training.sections[i]
    if (s.kind === 'quiz') {
      const count = s.quiz?.questions.length ?? 0
      checks.push({
        label: `Section ${i + 1} quiz has ≥1 question`,
        ok: count >= 1,
        blocking: true,
        sectionHint: count >= 1 ? undefined : s.title,
      })
    } else {
      const hasVideo = !!videoContent(s)?.videoId
      checks.push({
        label: `Section ${i + 1} has a video`,
        ok: hasVideo,
        blocking: true,
        sectionHint: hasVideo ? undefined : s.title,
      })
    }
  }
  checks.push({ label: 'Cover image set', ok: !!training.coverImage, blocking: false })
  checks.push({ label: 'Public slug set', ok: !!training.slug, blocking: true })
  return checks
}

function PublishDrawer({
  training,
  preflight,
  onClose,
  onPublish,
}: {
  training: Training
  preflight: PreflightCheck[]
  onClose: () => void
  onPublish: () => Promise<void>
}) {
  const blocked = preflight.some((c) => c.blocking && !c.ok)
  const [busy, setBusy] = useState(false)
  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-[14px] border border-surface-border w-full max-w-[480px] p-6"
        style={{ boxShadow: 'var(--shadow-raised)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <Eyebrow size="xs" className="mb-1">Pre-flight</Eyebrow>
        <h3 className="text-[20px] font-semibold text-ink mb-4 tracking-tight2">
          {training.isPublished ? 'Update this training' : 'Publish this training'}
        </h3>

        <div className="space-y-2 mb-5">
          {preflight.map((c, i) => {
            const tone: BadgeTone = c.ok ? 'success' : c.blocking ? 'danger' : 'warn'
            return (
              <div key={i} className="flex items-center justify-between gap-3 py-1.5 border-b border-surface-divider last:border-0">
                <div className="text-[13px] text-ink">{c.label}</div>
                <Badge tone={tone}>{c.ok ? 'OK' : c.blocking ? 'Block' : 'Warn'}</Badge>
              </div>
            )
          })}
        </div>

        <div className="flex gap-2 justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            disabled={blocked || busy}
            onClick={async () => { setBusy(true); await onPublish(); setBusy(false) }}
          >
            {busy ? 'Publishing…' : training.isPublished ? 'Update now' : 'Publish now'}
          </Button>
        </div>
      </div>
    </div>
  )
}
