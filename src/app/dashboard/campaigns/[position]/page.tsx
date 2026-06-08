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
  // URL segments are pre-encoded; useParams gives us the decoded form already.
  const positionSlug = typeof params?.position === 'string' ? params.position : ''
  const isUnassigned = positionSlug === UNASSIGNED_POSITION_SLUG
  const positionLabel = isUnassigned ? 'Unassigned' : positionSlug

  const [ads, setAds] = useState<Ad[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'ads' | 'overview'>('ads')
  // "Add existing ads" modal state — picks ads currently in other positions
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
    return ads.filter((a) => {
      if (isUnassigned) return !a.targetPosition
      return (a.targetPosition ?? '').toLowerCase() === positionSlug.toLowerCase()
    })
  }, [ads, positionSlug, isUnassigned])

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

  const openAddModal = () => {
    setAddSelectedIds(new Set())
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

  // Reassign every selected ad to this position (or to null for Unassigned).
  // Skips ads that are already here so a stale-cache double-tap is harmless.
  const attachSelected = async () => {
    if (addSelectedIds.size === 0) return
    setBulkSaving(true)
    try {
      const targetValue = isUnassigned ? null : positionLabel
      await Promise.all(
        Array.from(addSelectedIds).map((id) =>
          fetch(`/api/ads/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetPosition: targetValue }),
          })
        )
      )
      setAddModalOpen(false)
      refresh()
    } finally {
      setBulkSaving(false)
    }
  }

  // Pool for the Add modal: every ad NOT currently in this position. Sorted
  // by current position (Unassigned first) so the recruiter can scan groups.
  const attachableAds = useMemo(() => {
    return ads
      .filter((a) => {
        if (isUnassigned) return !!a.targetPosition
        return (a.targetPosition ?? '').toLowerCase() !== positionSlug.toLowerCase()
      })
      .sort((a, b) => {
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
            <Button variant="secondary" size="sm" onClick={openAddModal} disabled={bulkSaving}>
              Add existing ads
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
        <div className="flex gap-1 mb-4 border-b border-surface-border">
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
                <p className="text-grey-35">
                  No ads tagged with this position yet.{' '}
                  <Link href="/dashboard/campaigns" className="text-brand-500 hover:text-brand-600 font-medium">
                    Back to Campaigns
                  </Link>
                </p>
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
                        <td className="px-4 py-3 text-grey-15">{ad._count.sessions}</td>
                        <td className="px-4 py-3">
                          <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${ad.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-grey-40'}`}>
                            {ad.isActive ? 'Active' : 'Archived'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-grey-40">{new Date(ad.createdAt).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-grey-40">{new Date(ad.updatedAt).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-3">
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
                <h2 className="text-[15px] font-semibold text-ink">Add ads to &ldquo;{positionLabel}&rdquo;</h2>
                <p className="mt-0.5 text-[12px] text-grey-35">
                  Pick existing ads from other positions to reassign them here. Their other metadata (source, flow, copy) is unchanged.
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
                  Every ad in this workspace is already in this position.
                </p>
              ) : (
                <ul className="divide-y divide-surface-divider">
                  {attachableAds.map((ad) => {
                    const checked = addSelectedIds.has(ad.id)
                    const currentLabel = ad.targetPosition ?? 'Unassigned'
                    return (
                      <li key={ad.id}>
                        <label className="flex items-center gap-3 py-2.5 cursor-pointer hover:bg-surface-light/40 rounded-[8px] px-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleAddSelected(ad.id)}
                            className="cursor-pointer"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-medium text-ink truncate">{ad.name}</div>
                            <div className="text-[11px] text-grey-40 flex items-center gap-2">
                              <span className="capitalize">{ad.source}</span>
                              <span aria-hidden>·</span>
                              <span>Currently: {currentLabel}</span>
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
            <div className="px-5 py-3 border-t border-surface-divider flex items-center justify-between">
              <span className="text-[12px] text-grey-40">
                {addSelectedIds.size} selected
              </span>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => setAddModalOpen(false)} disabled={bulkSaving}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={attachSelected}
                  disabled={bulkSaving || addSelectedIds.size === 0 || attachableAds.length === 0}
                >
                  {bulkSaving ? 'Moving…' : `Move ${addSelectedIds.size} here`}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
