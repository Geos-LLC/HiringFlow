/**
 * Scheduling — configs + logged meetings. Visual refresh on the existing
 * two-section layout. Design's week-grid calendar isn't applied (data is
 * config-link-oriented, not availability-oriented).
 */

'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Badge, Button, Card, Eyebrow, PageHeader, Stat, WipBadge, WipSection } from '@/components/design'
import { BookingRulesEditor } from './_BookingRulesEditor'
import { defaultBookingRules, parseBookingRulesOrDefault, type BookingRules } from '@/lib/scheduling/booking-rules'

interface SchedulingConfig {
  id: string; name: string; provider: string; schedulingUrl: string
  isDefault: boolean; isActive: boolean; createdAt: string; updatedAt: string
  useBuiltInScheduler: boolean
  bookingRules: unknown
  _count: { events: number }
}
interface Meeting {
  id: string; eventType: string; eventAt: string
  metadata: { scheduledAt?: string; meetingUrl?: string; notes?: string; source?: string } | null
  session: { id: string; candidateName: string | null; candidateEmail: string | null }
  schedulingConfig: { id: string; name: string } | null
  scheduledStart: string | null
  scheduledEnd: string | null
  noShow?: boolean
  recording: {
    enabled: boolean
    state: string
    provider: string | null
    transcriptState: string
    hasFile: boolean
    actualStart: string | null
    actualEnd: string | null
  } | null
}

function recordingBadge(m: Meeting): { tone: 'success' | 'info' | 'neutral' | 'warn' | 'danger'; text: string } {
  if (m.noShow) return { tone: 'danger', text: 'No-show' }
  const rec = m.recording
  if (!rec) return { tone: 'neutral', text: 'Not adopted' }
  if (!rec.enabled) return { tone: 'neutral', text: 'Off' }
  if (rec.state === 'ready' || rec.hasFile) return { tone: 'success', text: 'Ready' }
  if (rec.state === 'recording') return { tone: 'info', text: 'Recording' }
  if (rec.state === 'processing') return { tone: 'info', text: 'Processing' }
  if (rec.state === 'requested') return { tone: 'info', text: 'Auto-record on' }
  if (rec.state === 'failed') return { tone: 'danger', text: 'Failed' }
  if (rec.state === 'unavailable') return { tone: 'warn', text: 'Unavailable' }
  return { tone: 'neutral', text: rec.state }
}

export default function SchedulingPage() {
  const [configs, setConfigs] = useState<SchedulingConfig[]>([])
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [meetingsTab, setMeetingsTab] = useState<'upcoming' | 'past'>('upcoming')
  // Top-level tab: list of booking pages (existing surface) vs. calendar
  // grid view (WIP). The calendar view is a placeholder per spec — once
  // the grid renderer + slot aggregation are wired it'll show booked /
  // cancelled / rescheduled / "result" cells per day.
  const [topTab, setTopTab] = useState<'pages' | 'calendar'>('pages')
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<SchedulingConfig | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [useBuiltIn, setUseBuiltIn] = useState(false)
  const [bookingRules, setBookingRules] = useState<BookingRules>(defaultBookingRules())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => { refresh() }, [])

  const refresh = async () => {
    const [rc, rm] = await Promise.all([
      fetch('/api/scheduling'),
      fetch('/api/scheduling/meetings'),
    ])
    if (rc.ok) setConfigs(await rc.json())
    if (rm.ok) setMeetings(await rm.json())
    setLoading(false)
  }

  const openCreate = () => {
    setEditing(null); setName(''); setUrl(''); setIsDefault(configs.length === 0)
    setUseBuiltIn(false); setBookingRules(defaultBookingRules()); setSaveError(null)
    setShowModal(true)
  }
  const openEdit = (c: SchedulingConfig) => {
    setEditing(c); setName(c.name); setUrl(c.schedulingUrl); setIsDefault(c.isDefault)
    setUseBuiltIn(!!c.useBuiltInScheduler)
    setBookingRules(parseBookingRulesOrDefault(c.bookingRules))
    setSaveError(null)
    setShowModal(true)
  }
  const save = async () => {
    setSaveError(null)
    if (!name.trim()) return setSaveError('Name is required')
    if (!useBuiltIn && !url.trim()) return setSaveError('External URL is required when not using built-in scheduler')
    setSaving(true)
    const body: Record<string, unknown> = {
      name,
      schedulingUrl: useBuiltIn ? '' : url,
      isDefault,
      useBuiltInScheduler: useBuiltIn,
    }
    if (useBuiltIn) body.bookingRules = bookingRules
    const r = editing
      ? await fetch(`/api/scheduling/${editing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      : await fetch('/api/scheduling', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setSaving(false)
    if (!r.ok) {
      const d = await r.json().catch(() => ({}))
      setSaveError(d.message || d.error || 'Save failed')
      return
    }
    setShowModal(false); refresh()
  }
  const toggle = async (c: SchedulingConfig) => {
    await fetch(`/api/scheduling/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: !c.isActive }) })
    refresh()
  }
  const setDefault = async (c: SchedulingConfig) => {
    await fetch(`/api/scheduling/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isDefault: true }) })
    refresh()
  }
  const remove = async (id: string) => {
    if (!confirm('Delete this scheduling config?')) return
    await fetch(`/api/scheduling/${id}`, { method: 'DELETE' }); refresh()
  }
  const preview = async (id: string) => {
    const r = await fetch(`/api/scheduling/${id}/preview-token`, { method: 'POST' })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d.url) {
      alert(d.message || d.error || 'Could not create preview link')
      return
    }
    window.open(d.url, '_blank', 'noopener,noreferrer')
  }
  const copyPreview = async (id: string) => {
    const r = await fetch(`/api/scheduling/${id}/preview-token`, { method: 'POST' })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d.url) {
      alert(d.message || d.error || 'Could not create preview link')
      return
    }
    try {
      await navigator.clipboard.writeText(d.url)
      alert('Preview link copied (expires in 5 minutes)')
    } catch {
      prompt('Copy this preview link:', d.url)
    }
  }

  if (loading) return <div className="py-14 text-center font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>Loading…</div>

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow="Scheduling"
        title="Scheduling"
        description="How interviews are booked. Manage your booking pages and watch the calendar fill up."
        actions={<Button size="sm" onClick={openCreate}>+ New Booking Page</Button>}
      />

      <div className="px-8 py-6 space-y-6">

        {/* === Metric strip ===
            Today / This Week / No Shows / Booking Rate. The first two are
            computed from the live meetings array; the latter two are
            placeholders until the no-show + click→booking aggregator are
            wired. Surfaced so the recruiter has at-a-glance numbers to
            decide whether to dig into the calendar tab. */}
        {(() => {
          const now = new Date()
          const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
          const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60_000)
          // Week start: Sunday at 00:00 (recruiter's locale would be nice,
          // but the spec column header is Mon-Fri so Sunday-start is fine).
          const day = now.getDay()
          const startOfWeek = new Date(startOfToday.getTime() - day * 24 * 60 * 60_000)
          const endOfWeek = new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60_000)

          const todayCount = meetings.filter((m) => {
            const start = m.scheduledStart ? new Date(m.scheduledStart) : (m.metadata?.scheduledAt ? new Date(m.metadata.scheduledAt) : new Date(m.eventAt))
            return start >= startOfToday && start < endOfToday && !m.noShow
          }).length
          const weekCount = meetings.filter((m) => {
            const start = m.scheduledStart ? new Date(m.scheduledStart) : (m.metadata?.scheduledAt ? new Date(m.metadata.scheduledAt) : new Date(m.eventAt))
            return start >= startOfWeek && start < endOfWeek && !m.noShow
          }).length
          const noShowCount = meetings.filter((m) => m.noShow).length

          return (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Today" value={todayCount} />
              <Stat label="This week" value={weekCount} />
              <Stat label="No-shows" value={noShowCount} deltaTone={noShowCount > 0 ? 'danger' : 'success'} />
              <div className="rounded-[12px] border border-dashed border-grey-35 p-4 bg-surface-light">
                <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-50 mb-1 flex items-center gap-1">
                  Booking rate <WipBadge label="WIP" />
                </div>
                <div className="text-[18px] font-semibold text-grey-35">—%</div>
                <div className="text-[11px] text-grey-35 mt-1">Needs link-click ingestion</div>
              </div>
            </div>
          )
        })()}

        {/* === Top tabs: Booking Pages vs. Calendar === */}
        <div className="flex gap-1 border-b border-surface-border -mb-3">
          {([
            { key: 'pages' as const,    label: 'Booking Pages' },
            { key: 'calendar' as const, label: 'Calendar' },
          ]).map((t) => (
            <button
              key={t.key}
              onClick={() => setTopTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                topTab === t.key ? 'border-brand-500 text-brand-600' : 'border-transparent text-grey-40 hover:text-grey-20'
              }`}
            >
              {t.label}
              {t.key === 'calendar' && <span className="ml-1.5"><WipBadge label="WIP" /></span>}
            </button>
          ))}
        </div>

        {topTab === 'calendar' && (
          <WipSection
            title="Weekly calendar view"
            description="Mon–Fri grid showing booked / cancelled / rescheduled meetings with outcome chips. Will render once the per-slot aggregator is wired."
          />
        )}

        {topTab === 'pages' && <>
        {/* Configs */}
        <section>
          <div className="flex items-end justify-between mb-3">
            <div>
              <Eyebrow size="xs" className="mb-0.5">Booking links</Eyebrow>
              <div className="text-[15px] font-semibold text-ink">Scheduling configurations</div>
            </div>
            <div className="font-mono text-[11px] text-grey-35">{configs.length} total</div>
          </div>

          {configs.length === 0 ? (
            <Card padding={40} className="text-center">
              <Eyebrow size="xs" className="mb-2">Nothing yet</Eyebrow>
              <h2 className="text-[18px] font-semibold text-ink mb-1.5">No scheduling links yet</h2>
              <p className="text-grey-35 mb-4 text-[13px]">Add a booking link — paste a Calendly URL or use the built-in slot picker.</p>
              <Button size="sm" onClick={openCreate}>+ Add link</Button>
            </Card>
          ) : (
            <Card padding={0} className="overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr style={{ background: 'var(--surface-light, #FCFAF6)' }}>
                    {['Name', 'Provider', 'URL', 'Invites', 'Default', 'Status', 'Actions'].map((h, i) => (
                      <th
                        key={h}
                        className={`px-4 py-2.5 font-mono text-[10px] uppercase text-grey-35 border-b border-surface-divider ${i === 6 ? 'text-right' : 'text-left'}`}
                        style={{ letterSpacing: '0.1em' }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {configs.map((c) => (
                    <tr key={c.id} className="border-b border-surface-divider last:border-0 hover:bg-surface-light">
                      <td className="px-4 py-3 font-medium text-ink">{c.name}</td>
                      <td className="px-4 py-3">
                        {c.useBuiltInScheduler
                          ? <Badge tone="brand">Built-in</Badge>
                          : <Badge tone="info">{c.provider}</Badge>}
                      </td>
                      <td className="px-4 py-3 max-w-[360px]">
                        {c.useBuiltInScheduler ? (
                          <BuiltInUrlCell configId={c.id} onCopyPreview={() => copyPreview(c.id)} onPreview={() => preview(c.id)} />
                        ) : (
                          <a href={c.schedulingUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-[11px] text-grey-35 hover:text-ink underline">
                            {c.schedulingUrl.replace(/^https?:\/\//, '')}
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-ink">{c._count.events}</td>
                      <td className="px-4 py-3">
                        {c.isDefault
                          ? <Badge tone="brand">Default</Badge>
                          : <button onClick={() => setDefault(c)} className="text-[11px] text-grey-35 hover:text-ink">Set default</button>}
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => toggle(c)}>
                          <Badge tone={c.isActive ? 'success' : 'neutral'}>{c.isActive ? 'Active' : 'Paused'}</Badge>
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right space-x-3">
                        <button onClick={() => openEdit(c)} className="text-[11px] text-grey-35 hover:text-ink">Edit</button>
                        <button onClick={() => remove(c.id)} className="text-[11px] text-[color:var(--danger-fg)] hover:underline">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>

        {/* Scheduled Meetings */}
        <section>
          {(() => {
            const now = Date.now()
            // A meeting is "Upcoming" until it ends — not just until it starts —
            // so a 4pm meeting still shows in Upcoming at 4:15pm. Use
            // scheduledEnd from the InterviewMeeting row when present; fall
            // back to scheduledAt + 60min for legacy rows without an IM record.
            const withWhen = meetings.map(m => {
              const start = m.scheduledStart
                ? new Date(m.scheduledStart)
                : (m.metadata?.scheduledAt ? new Date(m.metadata.scheduledAt) : new Date(m.eventAt))
              const end = m.scheduledEnd
                ? new Date(m.scheduledEnd)
                : new Date(start.getTime() + 60 * 60_000)
              return { m, when: start, end }
            })
            const upcoming = withWhen
              .filter(x => x.end.getTime() >= now)
              .sort((a, b) => a.when.getTime() - b.when.getTime())
            const past = withWhen
              .filter(x => x.end.getTime() < now)
              .sort((a, b) => b.when.getTime() - a.when.getTime())
            const visible = meetingsTab === 'upcoming' ? upcoming : past

            return (
              <>
                <div className="flex items-end justify-between mb-3">
                  <div>
                    <Eyebrow size="xs" className="mb-0.5">Booked</Eyebrow>
                    <div className="text-[15px] font-semibold text-ink">Scheduled meetings</div>
                  </div>
                  <div className="font-mono text-[11px] text-grey-35">{visible.length} of {meetings.length}</div>
                </div>

                <div className="flex gap-1 mb-3" role="tablist" aria-label="Scheduled meetings filter">
                  {(['upcoming', 'past'] as const).map((t) => {
                    const count = t === 'upcoming' ? upcoming.length : past.length
                    const active = meetingsTab === t
                    return (
                      <button
                        key={t}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setMeetingsTab(t)}
                        className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                          active
                            ? 'bg-ink text-white'
                            : 'bg-transparent text-grey-35 hover:bg-surface-light hover:text-ink'
                        }`}
                      >
                        {t === 'upcoming' ? 'Upcoming' : 'Past'}
                        <span className={`ml-1.5 font-mono text-[10px] ${active ? 'opacity-70' : 'opacity-60'}`}>{count}</span>
                      </button>
                    )
                  })}
                </div>

                {meetings.length === 0 ? (
                  <Card padding={32} className="text-center text-[13px] text-grey-35">
                    No meetings logged yet. Use <span className="font-medium text-ink">Log meeting</span> on a candidate&apos;s page, or let Calendar sync pick them up automatically.
                  </Card>
                ) : visible.length === 0 ? (
                  <Card padding={32} className="text-center text-[13px] text-grey-35">
                    {meetingsTab === 'upcoming' ? 'No upcoming meetings.' : 'No past meetings yet.'}
                  </Card>
                ) : (
                  <Card padding={0} className="overflow-hidden">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr style={{ background: 'var(--surface-light, #FCFAF6)' }}>
                          {['Candidate', 'When', 'Link', 'Recording', 'Config', 'Source'].map((h) => (
                            <th key={h} className="px-4 py-2.5 font-mono text-[10px] uppercase text-grey-35 border-b border-surface-divider text-left" style={{ letterSpacing: '0.1em' }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map(({ m, when }) => (
                      <tr key={m.id} className="border-b border-surface-divider last:border-0 hover:bg-surface-light">
                        <td className="px-4 py-3">
                          <Link href={`/dashboard/candidates/${m.session.id}`} className="font-medium text-ink hover:text-[color:var(--brand-primary)]">
                            {m.session.candidateName || m.session.candidateEmail || 'Anonymous'}
                          </Link>
                          {m.session.candidateEmail && m.session.candidateName && (
                            <div className="text-[11px] text-grey-35">{m.session.candidateEmail}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-[12px] text-ink">
                          {when.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 max-w-[220px] truncate">
                          {m.metadata?.meetingUrl ? (
                            <a href={m.metadata.meetingUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-[11px] text-[color:var(--brand-primary)] hover:underline">
                              {m.metadata.meetingUrl.replace(/^https?:\/\//, '')}
                            </a>
                          ) : <span className="text-grey-50">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          {(() => {
                            const b = recordingBadge(m)
                            return <Badge tone={b.tone}>{b.text}</Badge>
                          })()}
                        </td>
                        <td className="px-4 py-3 text-grey-35">{m.schedulingConfig?.name || '—'}</td>
                        <td className="px-4 py-3">
                          <Badge tone={m.metadata?.source === 'manual' ? 'neutral' : 'success'}>
                            {m.metadata?.source || 'auto'}
                          </Badge>
                        </td>
                      </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                )}
              </>
            )
          })()}
        </section>
        </>}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-surface-border shadow-raised p-7 w-full max-w-[640px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <Eyebrow size="xs" className="mb-1.5">{editing ? 'Edit' : 'New'}</Eyebrow>
            <h2 className="text-[20px] font-semibold text-ink mb-5">{editing ? 'Edit scheduling link' : 'Add scheduling link'}</h2>
            <div className="space-y-4">
              <div>
                <div className="eyebrow mb-1.5">Name</div>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. General Interview" className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-ink text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setUseBuiltIn(!useBuiltIn)}
                  className="w-10 h-5 rounded-full transition-colors relative"
                  style={{ background: useBuiltIn ? 'var(--brand-primary)' : '#D1CFCA' }}
                  aria-pressed={useBuiltIn}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${useBuiltIn ? 'left-5' : 'left-0.5'}`} />
                </button>
                <span className="text-[13px] text-ink">Use built-in scheduler (HireFunnel-hosted slot picker)</span>
              </label>

              {!useBuiltIn ? (
                <div>
                  <div className="eyebrow mb-1.5">External booking URL (Calendly / Cal.com / etc.)</div>
                  <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://calendly.com/your-name/interview" className="w-full px-3 py-2 border border-surface-border rounded-[10px] text-ink text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
                </div>
              ) : (
                <BookingRulesEditor value={bookingRules} onChange={setBookingRules} configId={editing?.id} />
              )}

              <label className="flex items-center gap-2.5 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setIsDefault(!isDefault)}
                  className="w-10 h-5 rounded-full transition-colors relative"
                  style={{ background: isDefault ? 'var(--brand-primary)' : '#D1CFCA' }}
                  aria-pressed={isDefault}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isDefault ? 'left-5' : 'left-0.5'}`} />
                </button>
                <span className="text-[13px] text-ink">Set as default scheduling link</span>
              </label>
            </div>
            {saveError && <div className="mt-3 text-[12px] text-[color:var(--danger-fg)]">{saveError}</div>}
            <div className="flex gap-2 mt-6 justify-end">
              <Button variant="secondary" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button onClick={save} disabled={saving || !name.trim()}>
                {saving ? 'Saving…' : editing ? 'Save' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function BuiltInUrlCell({ configId, onPreview, onCopyPreview }: { configId: string; onPreview: () => void; onCopyPreview: () => void }) {
  const [copied, setCopied] = useState(false)
  const publicUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/book/${configId}`
    : `/book/${configId}`
  const display = publicUrl.replace(/^https?:\/\//, '')

  const copyPublic = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      prompt('Copy this public booking link:', publicUrl)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <a
          href={publicUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[11px] text-grey-35 hover:text-ink underline truncate"
          title="Public booking link — anyone can use this to book a meeting"
        >
          {display}
        </a>
        <button
          onClick={copyPublic}
          className="text-[11px] text-[color:var(--brand-primary)] hover:underline shrink-0"
          title="Copy public link to clipboard"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <div className="flex items-center gap-2.5 text-[11px]">
        <span
          className="text-grey-50"
          title="Public link — visitors enter their name + email and pick a slot. A new candidate session is created on each booking."
        >
          Public link
        </span>
        <span className="text-grey-40">·</span>
        <button
          onClick={onPreview}
          className="text-grey-35 hover:text-ink"
          title="Open the candidate slot picker as if you were a logged-in candidate"
        >
          Preview as candidate
        </button>
        <span className="text-grey-40">·</span>
        <button
          onClick={onCopyPreview}
          className="text-grey-35 hover:text-ink"
          title="Copy a 5-minute candidate-bound preview link"
        >
          Copy preview
        </button>
      </div>
    </div>
  )
}
