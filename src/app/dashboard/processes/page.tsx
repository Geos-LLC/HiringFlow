/**
 * Journeys — list page.
 *
 * A Journey is the candidate-facing recruiting flow for a role: Application
 * Form → Training → Interview Booking → Interview. Under the hood it wraps
 * the existing primitives (Flow, Training, SchedulingConfig, Pipeline,
 * AutomationRule[]) but the recruiter never sees those internal names.
 *
 * Status semantics (unchanged from the orchestration layer):
 *   - draft     editable; does NOT attach to candidates yet
 *   - active    attaches Session.processId at flow-entry time
 *   - archived  read-only, will not accept new candidates
 */

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Badge, Button, Card, PageHeader, WipBadge } from '@/components/design'

interface ProcessRow {
  id: string
  name: string
  description: string | null
  status: 'draft' | 'active' | 'archived'
  flow: { id: string; name: string } | null
  training: { id: string; title: string } | null
  schedulingConfig: { id: string; name: string } | null
  pipeline: { id: string; name: string } | null
  automationsCount: number
  candidatesCount: number
  createdAt: string
  updatedAt: string
}

// Status filter tabs. "All" is the default so a fresh visitor sees every
// journey regardless of status.
type StatusFilter = 'all' | 'active' | 'draft' | 'archived'
const STATUS_TABS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all',      label: 'All' },
  { key: 'active',   label: 'Active' },
  { key: 'draft',    label: 'Draft' },
  { key: 'archived', label: 'Archived' },
]
const STATUS_TONE: Record<ProcessRow['status'], 'brand' | 'neutral' | 'success'> = {
  active: 'success',
  draft: 'brand',
  archived: 'neutral',
}

// Recruiter-facing names for the steps in a journey. The database column
// names (flow, training, schedulingConfig) stay as-is; the user never sees
// the technical term.
const STEP_LABELS = {
  flow:             'Application Form',
  training:         'Training',
  schedulingConfig: 'Interview Booking',
  interview:        'Interview',
} as const

// Build the ordered step list for one journey, skipping unset slots. The
// "Interview" step is implicit when there's a scheduling config — it
// represents the meeting that happens *after* the booking step. Same idea
// as the spec example: Application Form → Training → Interview Booking → Interview.
function stepsForJourney(r: ProcessRow): Array<{ key: string; label: string; linked: boolean }> {
  const out: Array<{ key: string; label: string; linked: boolean }> = []
  out.push({ key: 'flow',     label: STEP_LABELS.flow,     linked: !!r.flow })
  if (r.training)         out.push({ key: 'training',     label: STEP_LABELS.training,     linked: true })
  if (r.schedulingConfig) out.push({ key: 'scheduling',   label: STEP_LABELS.schedulingConfig, linked: true })
  if (r.schedulingConfig) out.push({ key: 'interview',    label: STEP_LABELS.interview,    linked: true })
  return out
}

export default function ProcessesPage() {
  const router = useRouter()
  const [rows, setRows] = useState<ProcessRow[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Filter + search state. Both compose: e.g. "Active" tab + "cleaner"
  // search narrows the cards to active journeys whose name matches.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchInput, setSearchInput] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/processes')
    if (res.ok) setRows(await res.json())
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/processes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to create')
      }
      const created: { id: string } = await res.json()
      setShowCreate(false)
      setNewName('')
      router.push(`/dashboard/processes/${created.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  const archive = async (row: ProcessRow) => {
    if (row.status === 'archived') return
    if (!confirm(`Archive "${row.name}"? New candidates on the linked application form will no longer attach to this journey.`)) return
    setBusyId(row.id)
    try {
      const res = await fetch(`/api/processes/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to archive')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive')
    } finally {
      setBusyId(null)
    }
  }

  const duplicate = async (row: ProcessRow) => {
    setBusyId(row.id)
    try {
      const res = await fetch(`/api/processes/${row.id}/duplicate`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to duplicate')
      }
      const created: { id: string } = await res.json()
      router.push(`/dashboard/processes/${created.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to duplicate')
    } finally {
      setBusyId(null)
    }
  }

  // Apply tab + search to the rows before rendering. Counts shown next to
  // each tab use the full unfiltered list so the recruiter can see at a
  // glance how many journeys live in each bucket.
  const filtered = useMemo(() => {
    const q = searchInput.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (q && !(r.name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q))) return false
      return true
    })
  }, [rows, statusFilter, searchInput])

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: rows.length, active: 0, draft: 0, archived: 0 }
    for (const r of rows) counts[r.status]++
    return counts
  }, [rows])

  return (
    <div>
      <PageHeader
        eyebrow={`${rows.length} ${rows.length === 1 ? 'journey' : 'journeys'}`}
        title="Journeys"
        description="What the candidate goes through. Each journey wraps an Application Form, optional Training, and Interview Booking into one reusable flow for a role."
        actions={
          <Button onClick={() => setShowCreate(true)}>+ New Journey</Button>
        }
      />

      {error && (
        <div className="mb-4 px-4 py-3 rounded-[10px] bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Search + tabs row. Search filters by name/description; the tab
          filter narrows by status. Both compose. */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-[400px]">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-grey-35" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search journeys"
            className="w-full pl-9 pr-3 py-2 rounded-[10px] border border-surface-border text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />
        </div>
        <div className="flex gap-1">
          {STATUS_TABS.map((t) => {
            const isActive = statusFilter === t.key
            return (
              <button
                key={t.key}
                onClick={() => setStatusFilter(t.key)}
                className={`px-3 py-2 rounded-[10px] text-[13px] font-medium transition-colors ${
                  isActive ? 'bg-ink text-white' : 'text-grey-35 hover:text-ink hover:bg-surface-light'
                }`}
              >
                {t.label}
                <span className={`ml-1.5 font-mono text-[11px] tabular-nums ${isActive ? 'text-white/80' : 'text-grey-50'}`}>
                  {statusCounts[t.key]}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {loading ? (
        <Card padding={20}>Loading…</Card>
      ) : filtered.length === 0 ? (
        rows.length === 0 ? (
          <Card padding={32}>
            <div className="text-center">
              <h3 className="font-semibold text-[16px] text-ink mb-1">No Journeys yet</h3>
              <p className="text-[13px] text-grey-35 mb-4">
                A journey defines what a candidate goes through end-to-end — apply, train, schedule, interview, get hired.
              </p>
              <Button onClick={() => setShowCreate(true)}>+ Create your first one</Button>
            </div>
          </Card>
        ) : (
          <Card padding={20}>
            <div className="text-center text-[13px] text-grey-35">
              No journeys match the current filter.
            </div>
          </Card>
        )
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => {
            const steps = stepsForJourney(r)
            // Completion % is a placeholder — the real calculation needs an
            // aggregate over sessions that finished vs. started for this
            // journey. Surfaced as WIP so the card reads as designed.
            return (
              <Card key={r.id} padding={20}>
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Link
                        href={`/dashboard/processes/${r.id}`}
                        className="font-semibold text-[16px] text-ink hover:underline"
                      >
                        {r.name}
                      </Link>
                      <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                    </div>
                    {r.description && (
                      <div className="text-grey-35 text-[12px] mb-3 line-clamp-1">{r.description}</div>
                    )}

                    {/* Step pills — the candidate-facing names of the
                        configured steps. Empty when the journey has no
                        flow yet (a draft mid-creation). */}
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {steps.length === 0 ? (
                        <span className="text-[12px] text-grey-35">No steps configured yet</span>
                      ) : steps.map((s, idx) => (
                        <span
                          key={s.key}
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] ${
                            s.linked
                              ? 'bg-surface-light border border-surface-border text-ink'
                              : 'border border-dashed border-grey-35 text-grey-35'
                          }`}
                        >
                          {s.label}
                          {idx < steps.length - 1 && (
                            <span className="text-grey-35 ml-1" aria-hidden>→</span>
                          )}
                        </span>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-4 text-[12px]">
                      <span className="text-grey-35">
                        <span className="font-semibold text-ink tabular-nums">{r.candidatesCount}</span> candidates
                      </span>
                      <span className="text-grey-35 flex items-center gap-1">
                        <span className="tabular-nums text-grey-35">—%</span> completion
                        <WipBadge label="WIP" />
                      </span>
                      <span className="text-grey-35">
                        {r.automationsCount} automation{r.automationsCount === 1 ? '' : 's'}
                      </span>
                      <span className="text-grey-35">
                        Updated {new Date(r.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {r.candidatesCount > 0 && (
                      <Link
                        href={`/dashboard/candidates?processId=${r.id}`}
                        className="px-3 py-1.5 rounded-[8px] text-[12px] text-ink border border-surface-border hover:bg-surface-light"
                      >
                        View candidates
                      </Link>
                    )}
                    <Link
                      href={`/dashboard/processes/${r.id}`}
                      className="px-3 py-1.5 rounded-[8px] text-[12px] text-ink border border-surface-border hover:bg-surface-light"
                    >
                      Edit
                    </Link>
                    <button
                      disabled={busyId === r.id}
                      onClick={() => duplicate(r)}
                      className="px-3 py-1.5 rounded-[8px] text-[12px] text-ink border border-surface-border hover:bg-surface-light disabled:opacity-50"
                    >
                      Duplicate
                    </button>
                    {r.status !== 'archived' && (
                      <button
                        disabled={busyId === r.id}
                        onClick={() => archive(r)}
                        className="px-3 py-1.5 rounded-[8px] text-[12px] text-grey-35 hover:text-ink hover:bg-surface-light disabled:opacity-50"
                      >
                        Archive
                      </button>
                    )}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-[14px] max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold text-[16px] text-ink mb-1">New Journey</h2>
            <p className="text-[13px] text-grey-35 mb-4">
              Give it a name. You'll wire up the application form, training, scheduling, and automations on the next screen.
            </p>
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create() }}
              placeholder="e.g. Cleaner Hiring Journey"
              className="w-full px-3 py-2 rounded-[10px] border border-surface-border text-[14px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-primary"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setShowCreate(false); setNewName('') }}
                className="px-3 py-2 rounded-[10px] text-[13px] text-grey-35 hover:text-ink"
              >
                Cancel
              </button>
              <Button onClick={create} disabled={creating || !newName.trim()}>
                {creating ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
