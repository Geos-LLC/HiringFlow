/**
 * Trainings list — refreshed 3-col grid with large gradient cover (fallback
 * when no coverImage) + sections / enrolled count, matching
 * Design/design_handoff_hirefunnel.
 */

'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import Link from 'next/link'
import { SubNav } from '../_components/SubNav'
import { Badge, Button, Card, Eyebrow, PageHeader, WipBadge, WipSection } from '@/components/design'

const TRAINING_NAV = [
  { href: '/dashboard/trainings', label: 'Trainings' },
  { href: '/dashboard/ai-calls', label: 'AI Calls' },
]

interface Training {
  id: string
  title: string
  slug: string
  description: string | null
  coverImage: string | null
  isPublished: boolean
  accessMode: string
  timeLimit: { type: string; value?: number; date?: string } | null
  pricing: { type: string; price?: number; currency?: string } | null
  createdAt: string
  sections: Array<{ id: string; _count: { contents: number } }>
  _count: { enrollments: number }
}

export default function TrainingsPage() {
  const [trainings, setTrainings] = useState<Training[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  // List view state — search + status tab + which top-level tab is active.
  // Trainings doesn't have an explicit "archived" column today, so that tab
  // is WIP. Active = isPublished, Draft = !isPublished.
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'draft' | 'archived'>('all')
  const [primaryTab, setPrimaryTab] = useState<'list' | 'analytics'>('list')
  const [newTitle, setNewTitle] = useState('')
  const [newTimeLimit, setNewTimeLimit] = useState<{ type: string; value?: number }>({ type: 'unlimited' })
  const [newPricing, setNewPricing] = useState<{ type: string; price?: number }>({ type: 'free' })
  const [newCoverImage, setNewCoverImage] = useState<string | null>(null)
  const [uploadingCover, setUploadingCover] = useState(false)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const [creating, setCreating] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Training | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null)

  const copyShareUrl = (slug: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/t/${slug}`)
    setCopiedSlug(slug)
    setTimeout(() => setCopiedSlug(null), 2000)
  }

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
        setNewCoverImage(url)
      }
    } catch { /* ignore */ }
    setUploadingCover(false)
    if (coverInputRef.current) coverInputRef.current.value = ''
  }

  useEffect(() => { fetchTrainings() }, [])

  const fetchTrainings = async () => {
    const res = await fetch('/api/trainings')
    if (res.ok) setTrainings(await res.json())
    setLoading(false)
  }

  const createTraining = async () => {
    if (!newTitle.trim()) return
    setCreating(true)
    const res = await fetch('/api/trainings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle, timeLimit: newTimeLimit, pricing: newPricing, coverImage: newCoverImage }),
    })
    if (res.ok) {
      setShowCreate(false)
      setNewTitle('')
      setNewTimeLimit({ type: 'unlimited' })
      setNewPricing({ type: 'free' })
      setNewCoverImage(null)
      fetchTrainings()
    }
    setCreating(false)
  }

  const deleteTraining = async (id: string) => {
    if (!confirm('Delete this training?')) return
    await fetch(`/api/trainings/${id}`, { method: 'DELETE' })
    fetchTrainings()
  }

  const openRename = (t: Training) => {
    setRenameTarget(t)
    setRenameValue(t.title)
  }

  const submitRename = async () => {
    if (!renameTarget || !renameValue.trim() || renameValue.trim() === renameTarget.title) {
      setRenameTarget(null)
      return
    }
    setRenaming(true)
    const res = await fetch(`/api/trainings/${renameTarget.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: renameValue.trim() }),
    })
    setRenaming(false)
    if (res.ok) {
      setRenameTarget(null)
      fetchTrainings()
    }
  }

  // Apply search + tab filter before render.
  const filteredTrainings = useMemo(() => {
    const q = search.trim().toLowerCase()
    return trainings.filter((t) => {
      if (statusFilter === 'active' && !t.isPublished) return false
      if (statusFilter === 'draft' && t.isPublished) return false
      if (statusFilter === 'archived') return false // archived not modeled yet
      if (q && !(t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))) return false
      return true
    })
  }, [trainings, search, statusFilter])

  // Tab counts use the unfiltered list so the badges reflect totals, not
  // current selection.
  const statusCounts = useMemo(() => {
    const active = trainings.filter((t) => t.isPublished).length
    const draft = trainings.length - active
    return { all: trainings.length, active, draft, archived: 0 }
  }, [trainings])

  if (loading) {
    return <div className="py-14 text-center font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>Loading…</div>
  }

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow={`${trainings.length} training${trainings.length === 1 ? '' : 's'}`}
        title="Trainings"
        description="Teach candidates — onboarding, compliance, and up-skilling courses."
        actions={<Button size="sm" onClick={() => setShowCreate(true)}>+ New Training</Button>}
      />

      <div className="px-8 pt-5">
        <SubNav items={TRAINING_NAV} />
      </div>

      <div className="px-8 py-4">
        {/* Primary tab: list vs. analytics. Analytics is a placeholder per
            spec — drop-off point, average score, and average time aren't
            aggregated yet. The full TrainingEnrollment table has the raw
            data so this is a UI-only build-out once the aggregator lands. */}
        <div className="flex gap-1 mb-4 border-b border-surface-border">
          {([
            { key: 'list' as const,      label: 'Trainings' },
            { key: 'analytics' as const, label: 'Analytics' },
          ]).map((t) => (
            <button
              key={t.key}
              onClick={() => setPrimaryTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                primaryTab === t.key ? 'border-brand-500 text-brand-600' : 'border-transparent text-grey-40 hover:text-grey-20'
              }`}
            >
              {t.label}
              {t.key === 'analytics' && <span className="ml-1.5"><WipBadge label="WIP" /></span>}
            </button>
          ))}
        </div>

        {primaryTab === 'analytics' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <WipSection
              title="Started vs. completed"
              description="Funnel of who started each training vs. who finished. The TrainingEnrollment table already records both — just needs aggregation."
            />
            <WipSection
              title="Average score"
              description="Across all quizzes per training."
            />
            <WipSection
              title="Drop-off point"
              description="Section the average candidate stops at — flags where the course is too long or unclear."
            />
            <WipSection
              title="Average time"
              description="Median time to complete from start."
            />
          </div>
        )}

        {primaryTab === 'list' && <>
        {/* Search + status tabs */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-[400px]">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-grey-35" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search trainings"
              className="w-full pl-9 pr-3 py-2 rounded-[10px] border border-surface-border text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-primary"
            />
          </div>
          <div className="flex gap-1">
            {([
              { k: 'all'      as const, l: 'All' },
              { k: 'active'   as const, l: 'Active' },
              { k: 'draft'    as const, l: 'Draft' },
              { k: 'archived' as const, l: 'Archived' },
            ]).map((t) => {
              const isActive = statusFilter === t.k
              return (
                <button
                  key={t.k}
                  onClick={() => setStatusFilter(t.k)}
                  disabled={t.k === 'archived'}
                  title={t.k === 'archived' ? 'Archived status not modeled yet' : undefined}
                  className={`px-3 py-2 rounded-[10px] text-[13px] font-medium transition-colors ${
                    isActive ? 'bg-ink text-white'
                      : t.k === 'archived' ? 'text-grey-50 cursor-not-allowed'
                      : 'text-grey-35 hover:text-ink hover:bg-surface-light'
                  }`}
                >
                  {t.l}
                  <span className={`ml-1.5 font-mono text-[11px] tabular-nums ${isActive ? 'text-white/80' : 'text-grey-50'}`}>
                    {statusCounts[t.k]}
                  </span>
                  {t.k === 'archived' && <span className="ml-1.5"><WipBadge label="WIP" /></span>}
                </button>
              )
            })}
          </div>
        </div>

        {filteredTrainings.length === 0 && trainings.length > 0 ? (
          <Card padding={32} className="text-center">
            <p className="text-[13px] text-grey-35">No trainings match the current filter.</p>
          </Card>
        ) : trainings.length === 0 ? (
          <Card padding={48} className="text-center">
            <div className="w-16 h-16 mx-auto mb-4 bg-brand-50 rounded-xl flex items-center justify-center">
              <svg className="w-8 h-8" style={{ color: 'var(--brand-primary)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
            </div>
            <h2 className="text-[20px] font-semibold text-ink mb-2">No trainings yet</h2>
            <p className="text-grey-35 mb-5 text-[14px]">Create your first training program.</p>
            <Button size="sm" onClick={() => setShowCreate(true)}>+ New training</Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {filteredTrainings.map((t) => {
              const paid = (t.pricing as { type: string })?.type === 'paid'
              const price = (t.pricing as { price?: number })?.price || 0
              const limitType = (t.timeLimit as { type: string })?.type
              return (
                <Card key={t.id} padding={0} className="overflow-hidden group">
                  <Link href={`/dashboard/trainings/${t.id}`}>
                    {t.coverImage ? (
                      <img src={t.coverImage} alt={t.title} className="w-full h-40 object-cover" />
                    ) : (
                      <div
                        className="w-full h-40 relative"
                        style={{
                          background: `
                            linear-gradient(135deg, rgba(255,149,0,0.22), rgba(255,149,0,0.08)),
                            repeating-linear-gradient(45deg, rgba(26,24,21,0.04) 0 14px, transparent 14px 28px)`,
                        }}
                      >
                        <div className="absolute bottom-3 left-3">
                          <Eyebrow size="xs">{t.sections.length} section{t.sections.length === 1 ? '' : 's'} · {t._count.enrollments} enrolled</Eyebrow>
                        </div>
                      </div>
                    )}
                  </Link>
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <Link href={`/dashboard/trainings/${t.id}`} className="text-[15px] font-semibold text-ink hover:text-[color:var(--brand-primary)] leading-snug">
                        {t.title}
                      </Link>
                      <div className="flex gap-1 shrink-0">
                        {t.accessMode === 'invitation_only' && <Badge tone="info">Gated</Badge>}
                        <Badge tone={t.isPublished ? 'success' : 'warn'}>{t.isPublished ? 'Published' : 'Draft'}</Badge>
                      </div>
                    </div>
                    {t.description && <p className="text-[12px] text-grey-35 line-clamp-2 mb-3">{t.description}</p>}
                    <div className="flex items-center justify-between text-[11px] text-grey-35 font-mono pt-3 border-t border-surface-divider">
                      <span>{t.sections.length} sections · {t._count.enrollments} enrolled</span>
                      <span className="flex items-center gap-2">
                        <span>{paid ? `$${price}` : 'Free'}</span>
                        <span className="text-grey-50">·</span>
                        <span>{limitType === 'unlimited' ? 'No limit' : limitType}</span>
                      </span>
                    </div>
                    <div className="pt-3 flex justify-between items-center text-[11px]">
                      <div className="flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                        {t.accessMode === 'invitation_only' ? (
                          <span
                            className="text-grey-50 cursor-not-allowed"
                            title="Gated training — candidates receive a per-invitation link via the automation that uses this training."
                          >
                            Share
                          </span>
                        ) : (
                          <button onClick={() => copyShareUrl(t.slug)} className="text-grey-35 hover:text-ink hover:underline">
                            {copiedSlug === t.slug ? 'Copied' : 'Share'}
                          </button>
                        )}
                        <button onClick={() => openRename(t)} className="text-grey-35 hover:text-ink hover:underline">
                          Rename
                        </button>
                      </div>
                      <button onClick={() => deleteTraining(t.id)} className="text-[color:var(--danger-fg)] hover:underline opacity-0 group-hover:opacity-100 transition-opacity">
                        Delete
                      </button>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
        </>}
      </div>

      {/* Rename modal */}
      {renameTarget && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50" onClick={() => setRenameTarget(null)}>
          <div className="bg-white rounded-xl border border-surface-border shadow-raised p-7 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <Eyebrow size="xs" className="mb-1.5">Rename training</Eyebrow>
            <h2 className="text-[20px] font-semibold text-ink mb-5">Edit training title</h2>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full px-4 py-3 border border-surface-border rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 text-ink placeholder-grey-50 mb-6 text-[14px]"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRename()
                if (e.key === 'Escape') setRenameTarget(null)
              }}
            />
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setRenameTarget(null)}>Cancel</Button>
              <Button onClick={submitRename} disabled={renaming || !renameValue.trim()}>
                {renaming ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-surface-border shadow-raised p-7 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <Eyebrow size="xs" className="mb-1.5">New training</Eyebrow>
            <h2 className="text-[20px] font-semibold text-ink mb-4">Create a training program</h2>

            <div className="space-y-4">
              <div>
                <div className="eyebrow mb-1.5">Title</div>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Onboarding Program"
                  className="w-full px-3 py-2 border border-surface-border rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/40 text-[13px] text-ink"
                  autoFocus
                />
              </div>

              <div>
                <div className="eyebrow mb-1.5">Cover image</div>
                {newCoverImage ? (
                  <div className="relative">
                    <img src={newCoverImage} alt="Cover" className="w-full h-32 object-cover rounded-[10px]" />
                    <button onClick={() => setNewCoverImage(null)} className="absolute top-2 right-2 w-6 h-6 bg-black/50 text-white rounded-full text-xs flex items-center justify-center hover:bg-black/70">&times;</button>
                  </div>
                ) : (
                  <label className="block w-full h-28 border-2 border-dashed border-surface-border rounded-[10px] cursor-pointer hover:border-brand-500/60 transition-colors flex items-center justify-center">
                    <div className="text-center">
                      <svg className="w-7 h-7 mx-auto text-grey-50 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <span className="text-[11px] text-grey-35">{uploadingCover ? 'Uploading…' : 'Upload cover image'}</span>
                    </div>
                    <input ref={coverInputRef} type="file" accept="image/*" onChange={handleCoverUpload} className="hidden" disabled={uploadingCover} />
                  </label>
                )}
              </div>

              <div>
                <div className="eyebrow mb-1.5">Time limit</div>
                <div className="flex gap-2">
                  {(['unlimited', 'days', 'calendar'] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setNewTimeLimit({ type: v })}
                      className={`flex-1 py-2 text-[12px] capitalize rounded-[10px] border ${
                        newTimeLimit.type === v ? 'border-brand-500 bg-brand-50 text-[color:var(--brand-fg)]' : 'border-surface-border text-grey-35 bg-white hover:bg-surface-light'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
                {newTimeLimit.type === 'days' && (
                  <input
                    type="number"
                    min={1}
                    value={newTimeLimit.value || ''}
                    onChange={(e) => setNewTimeLimit({ type: 'days', value: Number(e.target.value) })}
                    placeholder="Number of days"
                    className="w-full mt-2 px-3 py-2 border border-surface-border rounded-[10px] text-[13px]"
                  />
                )}
              </div>

              <div>
                <div className="eyebrow mb-1.5">Pricing</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setNewPricing({ type: 'free' })}
                    className={`flex-1 py-2 text-[12px] rounded-[10px] border ${
                      newPricing.type === 'free' ? 'border-brand-500 bg-brand-50 text-[color:var(--brand-fg)]' : 'border-surface-border text-grey-35 bg-white hover:bg-surface-light'
                    }`}
                  >Free</button>
                  <button
                    onClick={() => setNewPricing({ type: 'paid', price: 0 })}
                    className={`flex-1 py-2 text-[12px] rounded-[10px] border ${
                      newPricing.type === 'paid' ? 'border-brand-500 bg-brand-50 text-[color:var(--brand-fg)]' : 'border-surface-border text-grey-35 bg-white hover:bg-surface-light'
                    }`}
                  >Paid</button>
                </div>
                {newPricing.type === 'paid' && (
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[13px] text-grey-50">$</span>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={newPricing.price || ''}
                      onChange={(e) => setNewPricing({ type: 'paid', price: Number(e.target.value) })}
                      placeholder="Price"
                      className="flex-1 px-3 py-2 border border-surface-border rounded-[10px] text-[13px]"
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-2 mt-6 justify-end">
              <Button variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button onClick={createTraining} disabled={creating || !newTitle.trim()}>
                {creating ? 'Creating…' : 'Create training'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
