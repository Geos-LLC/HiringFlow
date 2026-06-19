'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Button, PageHeader, Stat } from '@/components/design'

interface Flow { id: string; name: string; slug: string; isPublished?: boolean }
interface Ad {
  id: string; name: string; source: string; campaign: string | null
  targetPosition: string | null
  slug: string; isActive: boolean; flowId: string
  flow: Flow; createdAt: string; updatedAt: string
  _count: { sessions: number }
}

// Mirror of the sentinel used on the Campaigns overview page. Keeps the URL
// round-trip consistent — /campaigns/__unassigned ↔ Ad.targetPosition IS NULL.
const UNASSIGNED_POSITION_SLUG = '__unassigned'

export default function CampaignPositionPage() {
  const params = useParams<{ position: string }>()
  const router = useRouter()
  // Next.js App Router's useParams returns the RAW URL-encoded value, not
  // the decoded form (despite earlier assumptions). Without decoding,
  // every link built with `encodeURIComponent(positionSlug)` would
  // re-encode the `%`, producing the quadruple-encoded URLs we saw in
  // prod (`Cleaner%2525252520Jacksonville` for a position literally
  // named "Cleaner Jacksonville"). Equally bad: the equality check
  // `ad.targetPosition === positionSlug` would never match because the
  // DB stores the decoded value. Decode once here, treat positionSlug
  // as the plain-text identity for the rest of the page.
  const rawParam = typeof params?.position === 'string' ? params.position : ''
  let positionSlug = ''
  try {
    positionSlug = rawParam ? decodeURIComponent(rawParam) : ''
  } catch {
    // Malformed encoding (e.g. stray `%`) — fall back to the raw value
    // rather than throwing. The recruiter sees the broken name; the
    // page still renders so they can navigate away.
    positionSlug = rawParam
  }
  const isUnassigned = positionSlug === UNASSIGNED_POSITION_SLUG
  const positionLabel = isUnassigned ? 'Unassigned' : positionSlug

  const [ads, setAds] = useState<Ad[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'ads' | 'overview'>('ads')
  // Sort for the per-position ad list. Same vocabulary as the All Campaigns
  // table on /dashboard/campaigns so the recruiter's mental model carries
  // over. Default newest first; persisted across reloads.
  const [adsSort, setAdsSort] = useState<'date_new' | 'date_old' | 'applicants' | 'source' | 'name'>(() => {
    if (typeof window === 'undefined') return 'date_new'
    try {
      const v = window.localStorage.getItem('hiringflow:ads-sort')
      if (v === 'date_old' || v === 'applicants' || v === 'source' || v === 'name') return v
    } catch {}
    return 'date_new'
  })
  useEffect(() => {
    try { window.localStorage.setItem('hiringflow:ads-sort', adsSort) } catch {}
  }, [adsSort])
  // "Manage ads" modal state — picks ads currently in other positions
  // (or Unassigned) and bulk-PATCHes their targetPosition to this one.
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [addSelectedIds, setAddSelectedIds] = useState<Set<string>>(new Set())
  const [bulkSaving, setBulkSaving] = useState(false)

  useEffect(() => {
    fetch('/api/ads')
      .then((r) => r.json())
      .then((all: Ad[]) => {
        setAds(Array.isArray(all) ? all : [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const positionAds = useMemo(() => {
    const filtered = ads.filter((a) => {
      if (isUnassigned) return !a.targetPosition
      return (a.targetPosition ?? '').toLowerCase() === positionSlug.toLowerCase()
    })
    const out = filtered.slice()
    switch (adsSort) {
      case 'applicants':
        out.sort((a, b) => b._count.sessions - a._count.sessions)
        break
      case 'date_new':
        out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
      case 'date_old':
        out.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        break
      case 'source':
        out.sort((a, b) => (a.source || '').localeCompare(b.source || '') || a.name.localeCompare(b.name))
        break
      case 'name':
        out.sort((a, b) => a.name.localeCompare(b.name))
        break
    }
    return out
  }, [ads, positionSlug, isUnassigned, adsSort])

  const totalSessions = positionAds.reduce((sum, a) => sum + a._count.sessions, 0)
  const activeCount = positionAds.filter((a) => a.isActive).length
  // Per-source ad count for the Overview tab's source breakdown.
  const sourceBreakdown = useMemo(() => {
    const buckets = new Map<string, number>()
    for (const a of positionAds) buckets.set(a.source, (buckets.get(a.source) ?? 0) + 1)
    return Array.from(buckets.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({ source, count }))
  }, [positionAds])

  const refresh = async () => {
    const r = await fetch('/api/ads')
    if (r.ok) setAds(await r.json())
  }

  const toggleActive = async (ad: Ad) => {
    await fetch(`/api/ads/${ad.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !ad.isActive }),
    })
    refresh()
  }

  const duplicate = async (ad: Ad) => {
    const name = window.prompt('Name for the new ad', `${ad.name} (copy)`)
    if (!name?.trim()) return
    const res = await fetch('/api/ads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        source: ad.source,
        campaign: ad.campaign,
        targetPosition: ad.targetPosition,
        flowId: ad.flowId,
      }),
    })
    if (res.ok) refresh()
    else alert('Duplicate failed')
  }

  const deleteAd = async (ad: Ad) => {
    if (!confirm(`Delete "${ad.name}"?`)) return
    const res = await fetch(`/api/ads/${ad.id}`, { method: 'DELETE' })
    if (res.ok) refresh()
    else alert('Delete failed')
  }

  // Catalogue of existing position names (excluding the current one) so the
  // Move / Rename prompts can suggest valid values. Plus a sentinel "—" entry
  // for moving an ad back to Unassigned.
  const otherPositions = useMemo(() => {
    const set = new Set<string>()
    for (const a of ads) {
      if (a.targetPosition && a.targetPosition !== positionLabel) set.add(a.targetPosition)
    }
    return Array.from(set).sort()
  }, [ads, positionLabel])

  // Bulk-PATCH every ad in this position to the new name. Done client-side via
  // sequential PATCHes because the per-ad route already validates auth and
  // workspace ownership; a dedicated bulk endpoint would just duplicate that.
  // For Unassigned we no-op because there's nothing meaningful to rename to.
  const renamePosition = async () => {
    if (isUnassigned) return
    const next = window.prompt(`Rename "${positionLabel}" to:`, positionLabel)
    if (next === null) return
    const trimmed = next.trim()
    if (!trimmed) {
      alert('Position name cannot be empty. Use "Move" on each ad to unassign instead.')
      return
    }
    if (trimmed === positionLabel) return
    setBulkSaving(true)
    try {
      await Promise.all(positionAds.map((ad) =>
        fetch(`/api/ads/${ad.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetPosition: trimmed }),
        })
      ))
      router.replace(`/dashboard/campaigns/${encodeURIComponent(trimmed)}`)
    } finally {
      setBulkSaving(false)
    }
  }

  // Move a single ad to a different position (or Unassigned). Empty input
  // resolves to null on the API side, which puts the ad in the Unassigned
  // bucket on the Campaigns overview.
  const moveAd = async (ad: Ad) => {
    const suggestion = otherPositions[0] ?? ''
    const next = window.prompt(
      `Move "${ad.name}" to which position?\n\nCurrent: ${ad.targetPosition ?? 'Unassigned'}\nExisting positions: ${otherPositions.join(', ') || '(none)'}\nLeave blank for Unassigned.`,
      suggestion
    )
    if (next === null) return
    const trimmed = next.trim()
    if (trimmed === (ad.targetPosition ?? '')) return
    await fetch(`/api/ads/${ad.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPosition: trimmed || null }),
    })
    refresh()
  }

  // Returns true iff `ad` is currently in the position being edited.
  // Treated as case-insensitive to match the rest of the position resolver.
  const isInThisPosition = (ad: Ad): boolean => {
    if (isUnassigned) return !ad.targetPosition
    return (ad.targetPosition ?? '').toLowerCase() === positionSlug.toLowerCase()
  }

  // Open the attach modal with the checkboxes pre-populated to reflect the
  // CURRENT state of the world: every ad already in this position starts
  // checked. Recruiter can uncheck (→ move to Unassigned) or check new ads
  // (→ move them here). Submit only PATCHes ads whose checkbox state
  // changed from the snapshot.
  const openAddModal = () => {
    setAddSelectedIds(new Set(ads.filter(isInThisPosition).map((a) => a.id)))
    setAddModalOpen(true)
  }

  const toggleAddSelected = (id: string) => {
    setAddSelectedIds((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Apply the modal's diff against the world. Three cases:
  //   - in selection AND in position    → no-op
  //   - in selection AND NOT in position → move into this position
  //   - NOT in selection AND in position → move OUT (to Unassigned)
  //   - NOT in selection AND NOT in position → no-op
  // We deliberately skip the no-ops so the network is quiet and the
  // "you didn't pick anything" case (no diff) bails out cleanly.
  const attachSelected = async () => {
    const targetValue = isUnassigned ? null : positionLabel
    const toAttach: string[] = []
    const toRemove: string[] = []
    for (const ad of ads) {
      const selected = addSelectedIds.has(ad.id)
      const here = isInThisPosition(ad)
      if (selected && !here) toAttach.push(ad.id)
      else if (!selected && here) toRemove.push(ad.id)
    }
    if (toAttach.length === 0 && toRemove.length === 0) {
      setAddModalOpen(false)
      return
    }
    setBulkSaving(true)
    try {
      const results = await Promise.all([
        ...toAttach.map((id) =>
          fetch(`/api/ads/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetPosition: targetValue }),
          })
        ),
        ...toRemove.map((id) =>
          fetch(`/api/ads/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetPosition: null }),
          })
        ),
      ])
      const failed = results.filter((r) => !r.ok)
      if (failed.length > 0) {
        alert(`${failed.length} ad update(s) failed.`)
      }
      setAddModalOpen(false)
      refresh()
    } finally {
      setBulkSaving(false)
    }
  }

  // Pool for the Add modal: every ad in the workspace. Ads currently in this
  // position render pre-checked + dimmed so the recruiter can see at a
  // glance which ones are already here; unchecking them moves them out.
  //
  // Dedupe by ad id is defensive — the API shouldn't return the same row
  // twice but a stale cache during refresh could briefly produce dupes.
  // Sort: ads currently in this position first (so the recruiter sees the
  // existing roster up top), then by current position label.
  const attachableAds = useMemo(() => {
    const seen = new Set<string>()
    const unique = ads.filter((a) => {
      if (seen.has(a.id)) return false
      seen.add(a.id)
      return true
    })
    return unique.sort((a, b) => {
      const aHere = isInThisPosition(a)
      const bHere = isInThisPosition(b)
      if (aHere && !bHere) return -1
      if (!aHere && bHere) return 1
      const aLabel = a.targetPosition ?? ''
      const bLabel = b.targetPosition ?? ''
      if (aLabel === bLabel) return a.name.localeCompare(b.name)
      if (!aLabel) return -1
      if (!bLabel) return 1
      return aLabel.localeCompare(bLabel)
    })
  }, [ads, isUnassigned, positionSlug])

  if (loading) {
    return (
      <div className="py-14 text-center font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>
        Loading…
      </div>
    )
  }

  const filterParam = `targetPosition=${encodeURIComponent(positionSlug)}`

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow={
          <Link href="/dashboard/campaigns" className="hover:text-ink">
            ← Campaigns
          </Link>
        }
        title={positionLabel}
        description={`${positionAds.length} ad${positionAds.length === 1 ? '' : 's'} for this position`}
        actions={
          <div className="flex flex-wrap gap-2">
            {!isUnassigned && (
              <Link href={`/dashboard/campaigns?new=1&position=${encodeURIComponent(positionLabel)}`}>
                <Button size="sm">+ New Ad</Button>
              </Link>
            )}
            <Button variant="secondary" size="sm" onClick={openAddModal} disabled={bulkSaving}>
              Manage ads
            </Button>
            {!isUnassigned && (
              <Button variant="secondary" size="sm" onClick={renamePosition} disabled={bulkSaving}>
                Rename position
              </Button>
            )}
            <Link href={`/dashboard/candidates?${filterParam}`}>
              <Button variant="secondary" size="sm">Candidates</Button>
            </Link>
            <Link href={`/dashboard/candidates?view=kanban&${filterParam}`}>
              <Button variant="secondary" size="sm">Pipeline</Button>
            </Link>
            <Link href={`/dashboard/analytics?${filterParam}`}>
              <Button variant="secondary" size="sm">Analytics</Button>
            </Link>
          </div>
        }
      />

      <div className="px-8 py-4">
        <div className="flex items-center justify-between gap-3 mb-4 border-b border-surface-border">
          <div className="flex gap-1">
            {[
              { key: 'ads' as const, label: `Ads (${positionAds.length})` },
              { key: 'overview' as const, label: 'Overview' },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  tab === t.key ? 'border-brand-500 text-brand-600' : 'border-transparent text-grey-40 hover:text-grey-20'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'ads' && positionAds.length > 1 && (
            <select
              value={adsSort}
              onChange={(e) => setAdsSort(e.target.value as typeof adsSort)}
              className="mb-2 px-3 py-1.5 border border-surface-border rounded-[8px] text-[12px] text-grey-15 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              title="Sort the ad list"
            >
              <option value="date_new">Sort: Newest first</option>
              <option value="date_old">Sort: Oldest first</option>
              <option value="applicants">Sort: Most applicants</option>
              <option value="source">Sort: Source A→Z</option>
              <option value="name">Sort: Name A→Z</option>
            </select>
          )}
        </div>

        {tab === 'overview' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Total ads" value={positionAds.length} />
              <Stat label="Active ads" value={activeCount} />
              <Stat label="Applicants" value={totalSessions} />
              <Stat label="Sources" value={sourceBreakdown.length} />
            </div>
            <div className="section-card">
              <div className="font-mono uppercase tracking-[0.08em] text-grey-50 text-[10px] mb-3">Source breakdown</div>
              {sourceBreakdown.length === 0 ? (
                <p className="text-[13px] text-grey-40">No ads in this position yet.</p>
              ) : (
                <ul className="divide-y divide-surface-divider">
                  {sourceBreakdown.map((row) => (
                    <li key={row.source} className="flex items-center justify-between py-2 text-[13px]">
                      <span className="capitalize text-grey-15">{row.source}</span>
                      <span className="text-grey-40">{row.count} ad{row.count === 1 ? '' : 's'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {tab === 'ads' && (
          <>
            {positionAds.length === 0 ? (
              <div className="section-card text-center py-12">
                <p className="text-grey-35 mb-4">No ads tagged with this position yet.</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {!isUnassigned && (
                    <Link href={`/dashboard/campaigns?new=1&position=${encodeURIComponent(positionLabel)}`}>
                      <Button size="sm">+ New Ad in this position</Button>
                    </Link>
                  )}
                  <Button variant="secondary" size="sm" onClick={openAddModal}>
                    Manage ads
                  </Button>
                  <Link href="/dashboard/campaigns">
                    <Button variant="secondary" size="sm">Back to Campaigns</Button>
                  </Link>
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-[12px] border border-surface-border overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead className="bg-surface-light border-b border-surface-divider">
                    <tr className="text-left font-mono uppercase tracking-[0.06em] text-[10px] text-grey-50">
                      <th className="px-4 py-2.5">Name</th>
                      <th className="px-4 py-2.5">Source</th>
                      <th className="px-4 py-2.5">Flow</th>
                      <th className="px-4 py-2.5">Applicants</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5">Created</th>
                      <th className="px-4 py-2.5">Last activity</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-divider">
                    {positionAds.map((ad) => (
                      <tr key={ad.id} className="hover:bg-surface-light/40">
                        <td className="px-4 py-3 text-ink font-medium">{ad.name}</td>
                        <td className="px-4 py-3 text-grey-15 capitalize">{ad.source}</td>
                        <td className="px-4 py-3 text-grey-15">
                          {ad.flow ? (
                            <Link href={`/dashboard/flows/${ad.flowId}/builder`} className="text-brand-500 hover:text-brand-600">
                              {ad.flow.name}
                            </Link>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3 text-grey-15">
                          {ad._count.sessions > 0 ? (
                            <Link
                              href={`/dashboard/candidates?adId=${ad.id}`}
                              className="text-brand-500 hover:text-brand-600 font-medium"
                              title="See the candidates this ad brought in"
                            >
                              {ad._count.sessions}
                            </Link>
                          ) : (
                            <span className="text-grey-40">{ad._count.sessions}</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${ad.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-grey-40'}`}>
                            {ad.isActive ? 'Active' : 'Archived'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-grey-40">{new Date(ad.createdAt).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-grey-40">{new Date(ad.updatedAt).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-3">
                            {ad._count.sessions > 0 && (
                              <>
                                <Link href={`/dashboard/candidates?adId=${ad.id}`} className="text-brand-500 hover:text-brand-600">
                                  Candidates
                                </Link>
                                <Link href={`/dashboard/candidates?view=kanban&adId=${ad.id}`} className="text-brand-500 hover:text-brand-600">
                                  Pipeline
                                </Link>
                              </>
                            )}
                            <button
                              onClick={() => router.push(`/dashboard/campaigns?edit=${ad.id}`)}
                              className="text-grey-35 hover:text-grey-15"
                            >
                              Edit
                            </button>
                            <button onClick={() => moveAd(ad)} className="text-grey-35 hover:text-grey-15">
                              Move
                            </button>
                            <button onClick={() => duplicate(ad)} className="text-grey-35 hover:text-grey-15">
                              Duplicate
                            </button>
                            <button onClick={() => toggleActive(ad)} className="text-grey-35 hover:text-grey-15">
                              {ad.isActive ? 'Archive' : 'Activate'}
                            </button>
                            <button onClick={() => deleteAd(ad)} className="text-grey-35 hover:text-grey-15">
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {addModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setAddModalOpen(false) }}
        >
          <div className="w-full max-w-2xl rounded-[14px] bg-white shadow-xl border border-surface-border flex flex-col max-h-[85vh]">
            <div className="px-5 py-4 border-b border-surface-divider flex items-center justify-between">
              <div>
                <h2 className="text-[15px] font-semibold text-ink">Manage ads for &ldquo;{positionLabel}&rdquo;</h2>
                <p className="mt-0.5 text-[12px] text-grey-35">
                  Check to attach, uncheck to detach. Ads currently here are pre-checked (and dimmed) so you can see what&apos;s already in place.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAddModalOpen(false)}
                className="w-7 h-7 flex items-center justify-center rounded-md text-grey-50 hover:text-ink hover:bg-surface-light"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
              {attachableAds.length === 0 ? (
                <p className="text-[13px] text-grey-40 py-6 text-center">
                  No ads in this workspace yet.
                </p>
              ) : (
                <ul className="divide-y divide-surface-divider">
                  {attachableAds.map((ad) => {
                    const checked = addSelectedIds.has(ad.id)
                    const here = isInThisPosition(ad)
                    const currentLabel = ad.targetPosition ?? 'Unassigned'
                    // "Untouched here" is the pre-checked, blurred state:
                    // the ad is currently in this position AND the recruiter
                    // hasn't toggled it. As soon as they uncheck, the dim
                    // lifts so the row reads as "you've decided to remove
                    // this one" — visible feedback for the change. The
                    // mirror case (currently elsewhere + checked) is
                    // "you've decided to bring this one over".
                    const untouchedHere = here && checked
                    const moving = (here && !checked) || (!here && checked)
                    return (
                      <li key={ad.id}>
                        <label
                          className={`flex items-center gap-3 py-2.5 cursor-pointer rounded-[8px] px-2 transition-opacity ${
                            untouchedHere ? 'opacity-50 hover:opacity-70' : 'hover:bg-surface-light/40'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleAddSelected(ad.id)}
                            className="cursor-pointer"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-medium text-ink truncate flex items-center gap-2">
                              {ad.name}
                              {moving && (
                                <span className={`text-[10px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded-[5px] ${
                                  here ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-green-50 text-green-700 border border-green-200'
                                }`}>
                                  {here ? 'Will remove' : 'Will add'}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-grey-40 flex items-center gap-2">
                              <span className="capitalize">{ad.source}</span>
                              <span aria-hidden>·</span>
                              <span>
                                Currently: {here ? <strong className="text-grey-15">In this position</strong> : currentLabel}
                              </span>
                              {!ad.isActive && (
                                <>
                                  <span aria-hidden>·</span>
                                  <span className="text-amber-700">Archived</span>
                                </>
                              )}
                            </div>
                          </div>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            {(() => {
              // Compute the same diff the submit handler will commit. We
              // use it for the footer counters AND to gate the Save button
              // — a no-diff state should not be saveable, otherwise the
              // recruiter clicks Save expecting something to happen.
              let willAdd = 0
              let willRemove = 0
              for (const ad of attachableAds) {
                const selected = addSelectedIds.has(ad.id)
                const here = isInThisPosition(ad)
                if (selected && !here) willAdd++
                else if (!selected && here) willRemove++
              }
              const hasDiff = willAdd > 0 || willRemove > 0
              return (
                <div className="px-5 py-3 border-t border-surface-divider flex items-center justify-between">
                  <span className="text-[12px] text-grey-40">
                    {hasDiff
                      ? `${willAdd > 0 ? `+${willAdd} adding` : ''}${willAdd > 0 && willRemove > 0 ? ' · ' : ''}${willRemove > 0 ? `-${willRemove} removing` : ''}`
                      : 'No changes'}
                  </span>
                  <div className="flex gap-2">
                    <Button type="button" variant="secondary" size="sm" onClick={() => setAddModalOpen(false)} disabled={bulkSaving}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={attachSelected}
                      disabled={bulkSaving || !hasDiff}
                    >
                      {bulkSaving ? 'Saving…' : 'Save changes'}
                    </Button>
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
