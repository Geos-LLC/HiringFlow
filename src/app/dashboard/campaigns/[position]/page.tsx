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
          <div className="flex gap-2">
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
    </div>
  )
}
