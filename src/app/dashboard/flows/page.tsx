/**
 * Flows list — refreshed to match Design/design_handoff_hirefunnel.
 * Filter pills + 3-col card grid with gradient cover, status badge, slug in
 * mono, and bottom-row metadata.
 */

'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Badge, Button, Card, Eyebrow, PageHeader, WipBadge } from '@/components/design'

interface Flow {
  id: string
  name: string
  slug: string
  isPublished: boolean
  createdAt: string
  workflowType: string | null
  _count: {
    steps: number
    sessions: number
  }
  // Mini-map source — ordered step types for the small visual strip on the
  // card. Empty array for fresh workflows with no steps yet.
  steps: Array<{ id: string; stepType: string; questionType: string | null; formEnabled: boolean }>
  // Completion-rate signal — number of sessions whose outcome reached the
  // end. The card divides this by sessions count to render a percentage.
  completedSessions: number
}

type Filter = 'all' | 'published' | 'draft' | 'archived'
type WorkflowTypeFilter = 'all' | 'application' | 'interview' | 'assessment' | 'training' | 'survey' | 'custom'

// Recruiter-facing labels for the workflowType enum. Single source of truth
// shared with the card badge + filter strip.
const TYPE_LABEL: Record<string, string> = {
  application: 'Application',
  interview:   'Interview',
  assessment:  'Assessment',
  training:    'Training',
  survey:      'Survey',
  custom:      'Custom',
}
const TYPE_TONE: Record<string, 'brand' | 'info' | 'success' | 'warn' | 'neutral'> = {
  application: 'brand',
  interview:   'info',
  assessment:  'warn',
  training:    'success',
  survey:      'neutral',
  custom:      'neutral',
}

// Map step types to a short glyph + color for the mini-map strip. Keeps
// the visual lightweight — no labels, just shape.
const STEP_GLYPH: Record<string, { color: string; label: string }> = {
  video:    { color: '#FF9500', label: 'V' },
  question: { color: '#2563EB', label: 'Q' },
  form:     { color: '#16A34A', label: 'F' },
  screen:   { color: '#6B7280', label: 'S' },
}

export default function FlowsPage() {
  const [flows, setFlows] = useState<Flow[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  // Workflow type filter. Composes with the status tab: e.g. Application +
  // Published. 'archived' status is WIP (no archived column on Flow yet).
  const [typeFilter, setTypeFilter] = useState<WorkflowTypeFilter>('all')
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [newFlowName, setNewFlowName] = useState('')
  const [creating, setCreating] = useState(false)
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<Flow | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)
  const router = useRouter()

  useEffect(() => { fetchFlows() }, [])

  const fetchFlows = async () => {
    const res = await fetch('/api/flows')
    if (res.ok) setFlows(await res.json())
  }

  const createFlow = async () => {
    if (!newFlowName.trim()) return
    setCreating(true)
    const res = await fetch('/api/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newFlowName }),
    })
    if (res.ok) {
      const flow = await res.json()
      setNewFlowName('')
      setShowModal(false)
      router.push(`/dashboard/flows/${flow.id}/builder?view=schema`)
      return
    }
    setCreating(false)
  }

  const togglePublish = async (flow: Flow) => {
    await fetch(`/api/flows/${flow.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: !flow.isPublished }),
    })
    fetchFlows()
  }

  const copyShareUrl = (slug: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/f/${slug}`)
    setCopiedSlug(slug)
    setTimeout(() => setCopiedSlug(null), 2000)
  }

  const deleteFlow = async (id: string) => {
    if (!confirm('Delete this flow?')) return
    await fetch(`/api/flows/${id}`, { method: 'DELETE' })
    fetchFlows()
  }

  const openRename = (flow: Flow) => {
    setRenameTarget(flow)
    setRenameValue(flow.name)
  }

  const submitRename = async () => {
    if (!renameTarget || !renameValue.trim() || renameValue.trim() === renameTarget.name) {
      setRenameTarget(null)
      return
    }
    setRenaming(true)
    const res = await fetch(`/api/flows/${renameTarget.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: renameValue.trim() }),
    })
    setRenaming(false)
    if (res.ok) {
      setRenameTarget(null)
      fetchFlows()
    }
  }

  const visible = flows.filter((f) => {
    if (filter === 'published' && !f.isPublished) return false
    if (filter === 'draft' && f.isPublished) return false
    if (filter === 'archived') return false // not modeled yet
    if (typeFilter !== 'all') {
      const ft = f.workflowType ?? 'application'
      if (ft !== typeFilter) return false
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      if (!(f.name.toLowerCase().includes(q) || f.slug.toLowerCase().includes(q))) return false
    }
    return true
  })

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow={`${flows.length} workflow${flows.length === 1 ? '' : 's'}`}
        title="Workflows"
        description="What candidates go through — application form, video answers, branching questions. Build, publish, share."
        actions={
          <Button onClick={() => setShowModal(true)} size="sm">+ New Workflow</Button>
        }
      />

      <div className="px-8 py-6">
        {/* Search + status tabs */}
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-[400px]">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-grey-35" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search workflows"
              className="w-full pl-9 pr-3 py-2 rounded-[10px] border border-surface-border text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-primary"
            />
          </div>
          <div className="flex gap-1">
            {([
              { v: 'all'       as const, l: `All`,       count: flows.length },
              { v: 'published' as const, l: `Published`, count: flows.filter(f => f.isPublished).length },
              { v: 'draft'     as const, l: `Draft`,     count: flows.filter(f => !f.isPublished).length },
              { v: 'archived'  as const, l: `Archived`,  count: 0, wip: true },
            ]).map((o) => {
              const isActive = filter === o.v
              const wip = 'wip' in o && o.wip
              return (
                <button
                  key={o.v}
                  onClick={() => !wip && setFilter(o.v)}
                  disabled={wip}
                  title={wip ? 'Archived status not modeled yet' : undefined}
                  className={`px-3 py-2 rounded-[10px] text-[13px] font-medium transition-colors ${
                    isActive ? 'bg-ink text-white'
                      : wip ? 'text-grey-50 cursor-not-allowed'
                      : 'text-grey-35 hover:text-ink hover:bg-surface-light'
                  }`}
                >
                  {o.l}
                  <span className={`ml-1.5 font-mono text-[11px] tabular-nums ${isActive ? 'text-white/80' : 'text-grey-50'}`}>
                    {o.count}
                  </span>
                  {wip && <span className="ml-1.5"><WipBadge label="WIP" /></span>}
                </button>
              )
            })}
          </div>
        </div>

        {/* Workflow type filter strip. Lets the recruiter slice by what
            kind of workflow (Application vs. Interview vs. Training etc.).
            All workflow types run through the same flow engine — this is
            organizational, not functional. */}
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-mono uppercase text-grey-35 tracking-wider mr-1">Type</span>
          {([
            { v: 'all'         as const, l: 'All types' },
            { v: 'application' as const, l: 'Application' },
            { v: 'interview'   as const, l: 'Interview' },
            { v: 'assessment'  as const, l: 'Assessment' },
            { v: 'training'    as const, l: 'Training' },
            { v: 'survey'      as const, l: 'Survey' },
            { v: 'custom'      as const, l: 'Custom' },
          ]).map((o) => {
            const isActive = typeFilter === o.v
            return (
              <button
                key={o.v}
                onClick={() => setTypeFilter(o.v)}
                className={`px-2.5 py-1 rounded-full border text-[12px] font-medium transition-colors ${
                  isActive
                    ? 'bg-ink text-white border-ink'
                    : 'border-surface-border text-grey-35 bg-white hover:text-ink'
                }`}
              >
                {o.l}
              </button>
            )
          })}
        </div>

        {visible.length === 0 ? (
          <Card padding={48} className="text-center">
            <div className="w-16 h-16 mx-auto mb-4 bg-brand-50 rounded-xl flex items-center justify-center">
              <svg className="w-8 h-8" style={{ color: 'var(--brand-primary)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="text-[20px] font-semibold text-ink mb-2">No flows yet</h2>
            <p className="text-grey-35 mb-5 text-[14px]">Create your first application flow.</p>
            <Button onClick={() => setShowModal(true)} size="sm">+ New Workflow</Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {visible.map((flow) => {
              const wfType = flow.workflowType ?? 'application'
              const completionRate = flow._count.sessions > 0
                ? Math.round((flow.completedSessions / flow._count.sessions) * 100)
                : null
              return (
              <Card
                key={flow.id}
                padding={0}
                className="overflow-hidden cursor-pointer hover:shadow-card transition-shadow"
                onClick={() => router.push(`/dashboard/flows/${flow.id}/builder`)}
              >
                {/* Cover with status badge + mini-map preview. The mini-map
                    is a compact left-to-right strip showing step types as
                    colored chips — recruiter scans workflow shape at a
                    glance without opening the editor. */}
                <div
                  className="relative px-3.5 pt-3"
                  style={{
                    height: 120,
                    background: `linear-gradient(135deg, rgba(255,149,0,0.18), rgba(255,149,0,0.06)),
                      repeating-linear-gradient(135deg, rgba(26,24,21,0.04) 0 10px, transparent 10px 20px)`,
                  }}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <Badge tone={TYPE_TONE[wfType]}>{TYPE_LABEL[wfType] || 'Custom'}</Badge>
                    <button onClick={(e) => { e.stopPropagation(); togglePublish(flow) }}>
                      <Badge tone={flow.isPublished ? 'success' : 'warn'}>
                        {flow.isPublished ? 'Published' : 'Draft'}
                      </Badge>
                    </button>
                  </div>

                  {/* Mini-map */}
                  {flow.steps.length === 0 ? (
                    <div className="text-[11px] text-grey-35 font-mono uppercase tracking-wider mt-1">
                      No steps yet
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 overflow-hidden">
                      {flow.steps.slice(0, 10).map((s) => {
                        const g = STEP_GLYPH[s.stepType] || STEP_GLYPH.screen
                        return (
                          <div
                            key={s.id}
                            className="shrink-0 w-5 h-5 rounded-[5px] flex items-center justify-center text-white text-[10px] font-bold"
                            style={{ background: g.color }}
                            title={s.stepType}
                          >
                            {g.label}
                          </div>
                        )
                      })}
                      {flow.steps.length > 10 && (
                        <span className="text-[11px] text-grey-35 font-mono">+{flow.steps.length - 10}</span>
                      )}
                    </div>
                  )}

                  <div className="absolute bottom-3 left-3.5">
                    <Eyebrow size="xs">{flow._count.steps} step{flow._count.steps === 1 ? '' : 's'} · {flow._count.sessions} candidate{flow._count.sessions === 1 ? '' : 's'}</Eyebrow>
                  </div>
                </div>

                {/* Body */}
                <div className="p-4">
                  <div className="text-[15px] font-semibold text-ink mb-1">{flow.name}</div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="font-mono text-[11px] text-grey-35">/f/{flow.slug}</div>
                    {/* Completion rate — real number when there are
                        sessions; "—" otherwise. */}
                    <div className="text-[11px] text-grey-35">
                      {completionRate !== null
                        ? <><span className="font-mono tabular-nums text-ink">{completionRate}%</span> completion</>
                        : <span className="text-grey-50">No data yet</span>}
                    </div>
                  </div>

                  <div className="flex flex-wrap justify-between gap-2 text-[12px] text-grey-35 pt-3 border-t border-surface-divider" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-wrap gap-2.5">
                      <Link href={`/dashboard/flows/${flow.id}/builder`} className="font-medium hover:text-ink">Edit</Link>
                      <a href={`/f/${flow.slug}?preview=true`} target="_blank" rel="noreferrer" className="hover:text-ink">Preview</a>
                      <button onClick={() => copyShareUrl(flow.slug)} className="hover:text-ink">
                        {copiedSlug === flow.slug ? 'Copied' : 'Share'}
                      </button>
                      <Link href={`/dashboard/flows/${flow.id}/submissions`} className="hover:text-ink">Analytics</Link>
                      <button onClick={() => openRename(flow)} className="hover:text-ink">Rename</button>
                    </div>
                    <button onClick={() => deleteFlow(flow.id)} className="hover:text-[color:var(--danger-fg)]">Delete</button>
                  </div>
                </div>
              </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Rename modal */}
      {renameTarget && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50" onClick={() => setRenameTarget(null)}>
          <div className="bg-white rounded-xl border border-surface-border p-7 w-full max-w-md shadow-raised" onClick={(e) => e.stopPropagation()}>
            <Eyebrow size="xs" className="mb-1.5">Rename flow</Eyebrow>
            <h2 className="text-[20px] font-semibold text-ink mb-5">Edit flow name</h2>
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
      {showModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-surface-border p-7 w-full max-w-md shadow-raised" onClick={(e) => e.stopPropagation()}>
            <Eyebrow size="xs" className="mb-1.5">New workflow</Eyebrow>
            <h2 className="text-[20px] font-semibold text-ink mb-5">Name this workflow</h2>
            <input
              type="text"
              value={newFlowName}
              onChange={(e) => setNewFlowName(e.target.value)}
              placeholder="e.g. Senior Product Designer"
              className="w-full px-4 py-3 border border-surface-border rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 text-ink placeholder-grey-50 mb-6 text-[14px]"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && createFlow()}
            />
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button onClick={createFlow} disabled={creating || !newFlowName.trim()}>
                {creating ? 'Creating…' : 'Create workflow'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
