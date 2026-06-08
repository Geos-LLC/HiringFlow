'use client'

import { Suspense, useState, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button, Card, Eyebrow, PageHeader, Stat } from '@/components/design'
import { BUILTIN_AD_SOURCES, normalizeCustomSources } from '@/lib/sources'

interface Flow { id: string; name: string; slug: string; isPublished?: boolean }
interface AdTemplateItem { id: string; name: string; source: string; headline: string; bodyText: string; requirements: string | null; benefits: string | null; callToAction: string | null }
interface Picture { id: string; url: string; filename: string; displayName?: string | null }
interface Ad {
  id: string; name: string; source: string; campaign: string | null
  targetPosition: string | null
  slug: string; isActive: boolean; flowId: string; imageUrl: string | null
  placementUrl: string | null; templateId: string | null
  headline: string | null; bodyText: string | null
  requirements: string | null; benefits: string | null; callToAction: string | null
  notes: string | null
  flow: Flow; createdAt: string; _count: { sessions: number }
}

// Sentinel slug used in URLs for ads with no Ad.targetPosition. Picked so it
// never collides with a real position name (positions are free-text but
// double-underscore-prefixed is reserved). Decoded back to `null` when used
// in /api/candidates and /api/analytics filters.
const UNASSIGNED_POSITION_SLUG = '__unassigned'

// Built-in source options come from the shared @/lib/sources module so the
// Campaigns page and the Candidates page agree on the canonical list. The
// per-workspace customSources array (loaded from Workspace.settings) is
// merged in at render time.
const SOURCES = BUILTIN_AD_SOURCES.map((s) => ({ value: s.id, label: s.label }))

const DEFAULT_AD_COPY: Record<string, { headline: string; body: string; requirements: string; benefits: string; cta: string }> = {
  indeed: { headline: 'Now Hiring — Join Our Team!', body: 'We are looking for motivated team members to join our growing company.\n\nThis is a great opportunity for someone who wants to grow their career.', requirements: '- Must be authorized to work\n- Reliable transportation\n- Positive attitude', benefits: '- Competitive pay\n- Flexible schedule\n- Growth opportunities', cta: 'Apply now — takes less than 5 minutes!' },
  facebook: { headline: "We're Hiring! Come Work With Us", body: "Looking for your next gig? We're hiring and we'd love to hear from you.\n\nNo long applications. Just a quick intro and you could start next week.", requirements: '', benefits: '- Weekly pay\n- Friendly team\n- No experience needed', cta: 'Tap the link to apply — it only takes a few minutes!' },
  craigslist: { headline: 'HIRING NOW — Apply Today', body: 'Immediate openings available.\n\nWe are looking for reliable, hardworking individuals. Full-time and part-time positions.', requirements: '- Must be 18+\n- Background check required\n- Valid ID', benefits: '- Start ASAP\n- Paid training\n- Weekly pay', cta: 'Click the link below to apply online.' },
  _default: { headline: 'We Are Hiring!', body: 'Join our team! We have openings available and are looking for great people.', requirements: '', benefits: '- Competitive pay\n- Great team', cta: 'Apply now through our quick online process!' },
}

// Suspense wrapper required because CampaignsPageInner uses useSearchParams
// (for the ?edit=<adId> deep-link from the position detail page) — Next.js
// would otherwise fail the prerender pass with a missing-suspense error.
export default function CampaignsPage() {
  return (
    <Suspense fallback={null}>
      <CampaignsPageInner />
    </Suspense>
  )
}

function CampaignsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [ads, setAds] = useState<Ad[]>([])
  const [flows, setFlows] = useState<Flow[]>([])
  const [adTemplates, setAdTemplates] = useState<AdTemplateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingAd, setEditingAd] = useState<Ad | null>(null)
  const [name, setName] = useState('')
  const [source, setSource] = useState('indeed')
  const [campaign, setCampaign] = useState('')
  // Free-text role the ad is hiring for (Dispatcher / Cleaner / etc.). Empty
  // string saves as null → ad lands in the "Unassigned" bucket on the
  // position-grouped overview.
  const [targetPosition, setTargetPosition] = useState('')
  const [flowId, setFlowId] = useState('')
  const [saving, setSaving] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // Tab structure follows the Recruiting > Campaigns spec:
  //   overview  — metric cards + at-a-glance charts (new landing surface)
  //   campaigns — list of every ad/campaign (was the legacy 'ads' tab)
  //   sources   — per-source breakdown (existing)
  //   templates — reusable ad-copy templates (replaces the old 'links' tab;
  //               the per-campaign tracked URL is still copyable inline)
  const [tab, setTab] = useState<'overview' | 'campaigns' | 'sources' | 'templates'>('overview')
  // Filters for the Ads tab. Empty string means "all". Both filters intersect.
  const [adsSourceFilter, setAdsSourceFilter] = useState<string>('')
  const [adsFlowFilter, setAdsFlowFilter] = useState<string>('')
  // Time window — filters the Ads table by Ad.createdAt so recruiters can
  // narrow to "campaigns launched this week" / etc. 'all' is the default.
  const [adsDateFilter, setAdsDateFilter] = useState<'all' | 'today' | '7d' | '30d' | '90d' | 'thisMonth' | 'lastMonth'>('all')
  // Ad copy fields in modal
  const [adHeadline, setAdHeadline] = useState('')
  const [adBody, setAdBody] = useState('')
  const [adCta, setAdCta] = useState('')
  const [adRequirements, setAdRequirements] = useState('')
  const [adBenefits, setAdBenefits] = useState('')
  const [showAdCopy, setShowAdCopy] = useState(true)
  // Placement URL (where the ad was posted — Telegram/Facebook group, etc.)
  const [placementUrl, setPlacementUrl] = useState('')
  // Private internal notes — never published to candidates
  const [notes, setNotes] = useState('')
  // Tracks whether a mousedown started on the backdrop. Without this, a drag
  // selection that began inside the modal and released over the backdrop fires
  // the backdrop's onClick and closes the modal.
  const backdropMouseDownTarget = useRef<EventTarget | null>(null)
  // Duplicate modal
  const [duplicatingAd, setDuplicatingAd] = useState<Ad | null>(null)
  const [duplicateName, setDuplicateName] = useState('')
  const [duplicating, setDuplicating] = useState(false)
  // Image picker
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageUploading, setImageUploading] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [showLibrary, setShowLibrary] = useState(false)
  const [pictures, setPictures] = useState<Picture[]>([])
  const [picturesLoading, setPicturesLoading] = useState(false)
  // Template selection + editor
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('__default__')
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<AdTemplateItem | null>(null)
  const [tplName, setTplName] = useState('')
  const [tplSource, setTplSource] = useState('general')
  const [tplHeadline, setTplHeadline] = useState('')
  const [tplBody, setTplBody] = useState('')
  const [tplRequirements, setTplRequirements] = useState('')
  const [tplBenefits, setTplBenefits] = useState('')
  const [tplCta, setTplCta] = useState('')
  const [tplSaving, setTplSaving] = useState(false)
  const [tplDeleting, setTplDeleting] = useState(false)
  // Workspace-defined sources merged with the built-in list. Same Workspace
  // settings.customSources value the Candidates page reads/writes.
  const [customSources, setCustomSources] = useState<string[]>([])
  // Inline "+" flow on the ad modal Source picker.
  const [addingSource, setAddingSource] = useState(false)
  const [newSourceName, setNewSourceName] = useState('')
  const [savingSource, setSavingSource] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)

  // Final list rendered in the modal: built-ins + workspace customs.
  const allSources = useMemo(
    () => [...SOURCES, ...customSources.map((s) => ({ value: s, label: s }))],
    [customSources]
  )

  useEffect(() => {
    Promise.all([
      fetch('/api/ads').then(r => r.json()),
      fetch('/api/flows').then(r => r.json()),
      fetch('/api/ad-templates').then(r => r.json()).catch(() => []),
      fetch('/api/workspace/settings').then(r => r.json()).catch(() => null),
    ]).then(async ([a, f, t, ws]) => {
      const settings = (ws?.settings as { customSources?: unknown } | null) ?? null
      setCustomSources(normalizeCustomSources(settings?.customSources))
      setAds(a); setFlows(f); setLoading(false)
      // Auto-seed starter templates the first time this workspace opens the page
      if (Array.isArray(t) && t.length === 0) {
        const seeded = await fetch('/api/ad-templates/seed', { method: 'POST' })
        if (seeded.ok) {
          const r2 = await fetch('/api/ad-templates')
          if (r2.ok) { setAdTemplates(await r2.json()); return }
        }
      }
      setAdTemplates(t)
    })
  }, [])

  const refresh = async () => { const r = await fetch('/api/ads'); if (r.ok) setAds(await r.json()) }

  // Rename a position by bulk-PATCHing every ad whose targetPosition matches.
  // Triggered from the inline Edit button on each card so the recruiter can
  // tidy positions without entering the per-position detail page.
  const [renamingPosition, setRenamingPosition] = useState<string | null>(null)
  const renamePositionInline = async (currentLabel: string) => {
    const next = window.prompt(`Rename "${currentLabel}" to:`, currentLabel)
    if (next === null) return
    const trimmed = next.trim()
    if (!trimmed) {
      alert('Position name cannot be empty.')
      return
    }
    if (trimmed === currentLabel) return
    setRenamingPosition(currentLabel)
    try {
      const matching = ads.filter((a) => a.targetPosition === currentLabel)
      await Promise.all(matching.map((ad) =>
        fetch(`/api/ads/${ad.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetPosition: trimmed }),
        })
      ))
      await refresh()
    } finally {
      setRenamingPosition(null)
    }
  }

  // Auto-open the edit modal when ?edit=<adId> is on the URL — used by the
  // Edit button on the per-position detail page so recruiters land directly
  // in the same modal they'd open from the "All Campaigns" tab. Strips the
  // param after handling so a back-nav doesn't re-fire on the next mount.
  useEffect(() => {
    const editId = searchParams?.get('edit')
    if (!editId || ads.length === 0) return
    const ad = ads.find((a) => a.id === editId)
    if (!ad) return
    setTab('campaigns')
    openEdit(ad)
    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.delete('edit')
    const qs = nextParams.toString()
    router.replace(qs ? `/dashboard/campaigns?${qs}` : '/dashboard/campaigns')
    // openEdit is intentionally not a dep — it's stable enough and including
    // it would re-run this effect every time any setter inside fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, ads])

  // Persist a new workspace-level source. Round-trips current settings so we
  // don't clobber other keys (funnelStages, customStatuses, etc.). After save
  // the new source is selected and the inline form collapses.
  const addCustomSource = async () => {
    const trimmed = newSourceName.trim()
    if (!trimmed || savingSource) return
    const existing = new Set<string>([
      ...BUILTIN_AD_SOURCES.map((s) => s.id),
      ...customSources.map((s) => s.toLowerCase()),
    ])
    if (existing.has(trimmed.toLowerCase())) {
      setSourceError(`Source "${trimmed}" already exists`)
      return
    }
    setSavingSource(true)
    setSourceError(null)
    try {
      const cur = await fetch('/api/workspace/settings').then((r) => r.json()).catch(() => ({}))
      const currentSettings = (cur?.settings && typeof cur.settings === 'object') ? cur.settings : {}
      const nextCustom = [...customSources, trimmed]
      const res = await fetch('/api/workspace/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { ...currentSettings, customSources: nextCustom } }),
      })
      if (!res.ok) throw new Error('Failed to save source')
      setCustomSources(nextCustom)
      setSource(trimmed)
      setAddingSource(false)
      setNewSourceName('')
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : 'Failed to save source')
    } finally {
      setSavingSource(false)
    }
  }

  const loadAdCopyDefaults = (src: string) => {
    const d = DEFAULT_AD_COPY[src] || DEFAULT_AD_COPY._default
    setAdHeadline(d.headline); setAdBody(d.body); setAdCta(d.cta)
    setAdRequirements(d.requirements); setAdBenefits(d.benefits)
  }

  const openCreate = () => {
    setEditingAd(null); setName(''); setSource('indeed'); setCampaign(''); setFlowId(flows[0]?.id || '')
    setTargetPosition('')
    setImageUrl(null); setImageError(null); setShowLibrary(false)
    setSelectedTemplateId('__default__')
    setPlacementUrl('')
    setNotes('')
    const d = DEFAULT_AD_COPY.indeed
    setAdHeadline(d.headline); setAdBody(d.body); setAdCta(d.cta)
    setAdRequirements(d.requirements); setAdBenefits(d.benefits)
    setShowAdCopy(true); setShowModal(true)
  }
  const openEdit = (ad: Ad) => {
    setEditingAd(ad); setName(ad.name); setSource(ad.source); setCampaign(ad.campaign || ''); setFlowId(ad.flowId)
    setTargetPosition(ad.targetPosition || '')
    setImageUrl(ad.imageUrl); setImageError(null); setShowLibrary(false)
    setSelectedTemplateId(ad.templateId || '__default__')
    setPlacementUrl(ad.placementUrl || '')
    setNotes(ad.notes || '')
    // Load saved copy if present, otherwise fall back to source defaults
    const d = DEFAULT_AD_COPY[ad.source] || DEFAULT_AD_COPY._default
    setAdHeadline(ad.headline ?? d.headline)
    setAdBody(ad.bodyText ?? d.body)
    setAdCta(ad.callToAction ?? d.cta)
    setAdRequirements(ad.requirements ?? d.requirements)
    setAdBenefits(ad.benefits ?? d.benefits)
    setShowModal(true)
  }

  const refreshTemplates = async () => {
    const r = await fetch('/api/ad-templates')
    if (r.ok) setAdTemplates(await r.json())
  }

  const openTemplateNew = () => {
    setEditingTemplate(null)
    setTplName(''); setTplSource(source || 'general')
    setTplHeadline(adHeadline); setTplBody(adBody); setTplCta(adCta)
    setTplRequirements(''); setTplBenefits('')
    setTemplateEditorOpen(true)
  }

  const openTemplateEdit = () => {
    const t = adTemplates.find(t => t.id === selectedTemplateId)
    if (!t) return
    setEditingTemplate(t)
    setTplName(t.name); setTplSource(t.source)
    setTplHeadline(t.headline); setTplBody(t.bodyText); setTplCta(t.callToAction || '')
    setTplRequirements(t.requirements || ''); setTplBenefits(t.benefits || '')
    setTemplateEditorOpen(true)
  }

  const saveTemplate = async () => {
    if (!tplName.trim() || !tplHeadline.trim() || !tplBody.trim()) return
    setTplSaving(true)
    const payload = {
      name: tplName.trim(),
      source: tplSource,
      headline: tplHeadline,
      bodyText: tplBody,
      requirements: tplRequirements || null,
      benefits: tplBenefits || null,
      callToAction: tplCta || null,
    }
    let saved: AdTemplateItem | null = null
    if (editingTemplate) {
      const res = await fetch(`/api/ad-templates/${editingTemplate.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (res.ok) saved = await res.json()
    } else {
      const res = await fetch('/api/ad-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (res.ok) saved = await res.json()
    }
    setTplSaving(false)
    if (saved) {
      await refreshTemplates()
      // Apply the saved template to the ad copy fields and select it. The
      // ad's source is independent of the template's source — picking a
      // Telegram template for a Facebook ad shouldn't flip the ad to Telegram.
      setSelectedTemplateId(saved.id)
      setAdHeadline(saved.headline); setAdBody(saved.bodyText); setAdCta(saved.callToAction || '')
      setAdRequirements(saved.requirements || ''); setAdBenefits(saved.benefits || '')
      setTemplateEditorOpen(false)
    }
  }

  const deleteTemplate = async () => {
    if (!editingTemplate) return
    if (!confirm(`Delete template "${editingTemplate.name}"?`)) return
    setTplDeleting(true)
    const res = await fetch(`/api/ad-templates/${editingTemplate.id}`, { method: 'DELETE' })
    setTplDeleting(false)
    if (res.ok) {
      await refreshTemplates()
      if (selectedTemplateId === editingTemplate.id) {
        setSelectedTemplateId('__default__')
        loadAdCopyDefaults(source)
      }
      setTemplateEditorOpen(false)
    }
  }

  const save = async () => {
    if (!name.trim() || !flowId) return
    setSaving(true)
    const payload = {
      name, source, campaign, flowId, imageUrl,
      targetPosition: targetPosition.trim() || null,
      placementUrl: placementUrl.trim() || null,
      templateId: selectedTemplateId === '__default__' ? null : selectedTemplateId,
      headline: adHeadline,
      bodyText: adBody,
      requirements: adRequirements,
      benefits: adBenefits,
      callToAction: adCta,
      notes: notes.trim() || null,
    }
    if (editingAd) {
      await fetch(`/api/ads/${editingAd.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    } else {
      await fetch('/api/ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    }
    // Refresh BEFORE closing the modal so subsequent clicks (e.g. Duplicate)
    // see the just-saved fields, not the pre-save snapshot.
    await refresh()
    setSaving(false); setShowModal(false)
  }

  const uploadImage = async (file: File) => {
    setImageError(null)
    if (!file.type.startsWith('image/')) { setImageError('File must be an image'); return }
    if (file.size > 10 * 1024 * 1024) { setImageError('Image too large (max 10MB)'); return }
    setImageUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/pictures', { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setImageError(err.error || 'Upload failed')
        return
      }
      const picture = await res.json() as Picture
      setImageUrl(picture.url)
    } finally {
      setImageUploading(false)
    }
  }

  const openLibrary = async () => {
    setShowLibrary(true)
    if (pictures.length === 0) {
      setPicturesLoading(true)
      try {
        const r = await fetch('/api/pictures')
        if (r.ok) setPictures(await r.json())
      } finally {
        setPicturesLoading(false)
      }
    }
  }

  const toggleActive = async (ad: Ad) => {
    await fetch(`/api/ads/${ad.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: !ad.isActive }) })
    refresh()
  }

  const deleteAd = async (id: string) => {
    if (!confirm('Delete this ad?')) return
    await fetch(`/api/ads/${id}`, { method: 'DELETE' }); refresh()
  }

  const openDuplicate = (ad: Ad) => {
    setDuplicatingAd(ad)
    setDuplicateName(`${ad.name} (copy)`)
  }

  const confirmDuplicate = async () => {
    if (!duplicatingAd || !duplicateName.trim()) return
    setDuplicating(true)
    // Verbatim copy — every persisted field is taken straight from the source
    // ad. If a field is null on the source, the duplicate gets null too; we
    // deliberately do NOT fall back to a template or source default, otherwise
    // the duplicate ends up with "Benefits"/"Requirements"/etc. text that
    // the source never had.
    const res = await fetch('/api/ads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: duplicateName.trim(),
        source: duplicatingAd.source,
        campaign: duplicatingAd.campaign,
        targetPosition: duplicatingAd.targetPosition,
        flowId: duplicatingAd.flowId,
        imageUrl: duplicatingAd.imageUrl,
        // Placement URL deliberately NOT copied — a duplicate exists to post
        // the same creative somewhere new, so the original group link
        // doesn't apply.
        placementUrl: null,
        // The duplicate is an independent ad, not a template-linked one —
        // the user's mental model is "copy this exact ad", and a templateId
        // would make the dropdown read "Template X" instead of "Default".
        templateId: null,
        headline: duplicatingAd.headline,
        bodyText: duplicatingAd.bodyText,
        requirements: duplicatingAd.requirements,
        benefits: duplicatingAd.benefits,
        callToAction: duplicatingAd.callToAction,
        notes: duplicatingAd.notes,
      }),
    })
    if (res.ok) {
      await refresh()
      setDuplicatingAd(null)
      setDuplicateName('')
    }
    setDuplicating(false)
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (typeof window !== 'undefined' ? window.location.origin : '')

  const copyLink = (slug: string, id: string) => {
    navigator.clipboard.writeText(`${baseUrl}/a/${slug}`)
    setCopiedId(id); setTimeout(() => setCopiedId(null), 2000)
  }

  const [copiedTextId, setCopiedTextId] = useState<string | null>(null)
  const copyAdText = async (ad: Ad) => {
    // Prefer copy saved on the ad itself; fall back to a matching template; finally to source defaults
    const tpl = adTemplates.find(t => t.source === ad.source) || adTemplates.find(t => t.source === 'general')
    const d = DEFAULT_AD_COPY[ad.source] || DEFAULT_AD_COPY._default
    const headline = ad.headline || tpl?.headline || d.headline
    const body = ad.bodyText || tpl?.bodyText || d.body
    const requirements = ad.requirements ?? tpl?.requirements ?? d.requirements
    const benefits = ad.benefits ?? tpl?.benefits ?? d.benefits
    const cta = ad.callToAction || tpl?.callToAction || d.cta
    const link = `${baseUrl}/a/${ad.slug}`

    const parts: string[] = []
    if (headline) parts.push(headline)
    if (body) parts.push(body)
    if (requirements && requirements.trim()) parts.push(`Requirements:\n${requirements}`)
    if (benefits && benefits.trim()) parts.push(`What we offer:\n${benefits}`)
    if (cta && cta.trim()) parts.push(cta)
    parts.push(`Apply: ${link}`)
    try {
      await navigator.clipboard.writeText(parts.join('\n\n'))
      setCopiedTextId(ad.id)
      setTimeout(() => setCopiedTextId(null), 2000)
    } catch {}
  }

  // Compute stats
  const totalSessions = ads.reduce((sum, a) => sum + a._count.sessions, 0)
  const activeAds = ads.filter(a => a.isActive).length
  const sourcesUsed = new Set(ads.map(a => a.source)).size

  // Position groups — one bucket per Ad.targetPosition + Unassigned for nulls.
  // Each group rolls up the metrics the position card on the Overview tab
  // displays. URL slug for the detail page is just the position string;
  // Unassigned uses the sentinel constant to round-trip cleanly through
  // /api/candidates and /api/analytics.
  const positionGroups = useMemo(() => {
    const buckets = new Map<string, Ad[]>()
    for (const ad of ads) {
      const key = ad.targetPosition ?? UNASSIGNED_POSITION_SLUG
      const arr = buckets.get(key)
      if (arr) arr.push(ad)
      else buckets.set(key, [ad])
    }
    const labelByValue = new Map<string, string>(allSources.map((s) => [s.value, s.label]))
    const rows = Array.from(buckets.entries()).map(([key, groupAds]) => {
      const totalApplicants = groupAds.reduce((sum, a) => sum + a._count.sessions, 0)
      const activeCount = groupAds.filter((a) => a.isActive).length
      const sourceCounts = new Map<string, number>()
      for (const a of groupAds) sourceCounts.set(a.source, (sourceCounts.get(a.source) ?? 0) + 1)
      const topSources = Array.from(sourceCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([src]) => labelByValue.get(src) ?? src)
      const lastActivityMs = groupAds.reduce((mx, a) => Math.max(mx, new Date(a.createdAt).getTime()), 0)
      return {
        key,
        label: key === UNASSIGNED_POSITION_SLUG ? 'Unassigned' : key,
        adsCount: groupAds.length,
        activeCount,
        totalApplicants,
        topSources,
        lastActivityAt: lastActivityMs > 0 ? new Date(lastActivityMs) : null,
      }
    })
    // Sort: pinned Unassigned at end; others by applicant count desc, then by
    // ad count desc, then alphabetically — so the busiest positions surface.
    return rows.sort((a, b) => {
      if (a.key === UNASSIGNED_POSITION_SLUG) return 1
      if (b.key === UNASSIGNED_POSITION_SLUG) return -1
      if (b.totalApplicants !== a.totalApplicants) return b.totalApplicants - a.totalApplicants
      if (b.adsCount !== a.adsCount) return b.adsCount - a.adsCount
      return a.label.localeCompare(b.label)
    })
  }, [ads, allSources])

  // Resolve the date preset into a [from, to) range over Ad.createdAt.
  // `null` means "no constraint". thisMonth / lastMonth use calendar bounds;
  // rolling windows count back N days from now.
  const adsDateBounds = useMemo<{ from: Date | null; to: Date | null }>(() => {
    if (adsDateFilter === 'all') return { from: null, to: null }
    const now = new Date()
    const day = 24 * 60 * 60 * 1000
    if (adsDateFilter === 'today') {
      const start = new Date(now); start.setHours(0, 0, 0, 0)
      return { from: start, to: null }
    }
    if (adsDateFilter === '7d') return { from: new Date(now.getTime() - 7 * day), to: null }
    if (adsDateFilter === '30d') return { from: new Date(now.getTime() - 30 * day), to: null }
    if (adsDateFilter === '90d') return { from: new Date(now.getTime() - 90 * day), to: null }
    if (adsDateFilter === 'thisMonth') return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: null }
    if (adsDateFilter === 'lastMonth') {
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: new Date(now.getFullYear(), now.getMonth(), 1),
      }
    }
    return { from: null, to: null }
  }, [adsDateFilter])

  // Filtered ad list — drives the Ads tab table. Filters intersect; empty
  // filter means "no constraint on that axis".
  const filteredAds = useMemo(() => {
    return ads.filter((a) => {
      if (adsSourceFilter && a.source !== adsSourceFilter) return false
      if (adsFlowFilter && a.flowId !== adsFlowFilter) return false
      if (adsDateBounds.from || adsDateBounds.to) {
        const created = new Date(a.createdAt)
        if (adsDateBounds.from && created < adsDateBounds.from) return false
        if (adsDateBounds.to && created >= adsDateBounds.to) return false
      }
      return true
    })
  }, [ads, adsSourceFilter, adsFlowFilter, adsDateBounds])

  // Sources breakdown — built up from the ads' actual source values so
  // custom workspace sources appear in the table alongside built-ins.
  const sourceStats = useMemo(() => {
    const labelByValue = new Map<string, string>(allSources.map((s) => [s.value, s.label]))
    const buckets = new Map<string, Ad[]>()
    for (const a of ads) {
      const key = a.source || 'other'
      const arr = buckets.get(key)
      if (arr) arr.push(a)
      else buckets.set(key, [a])
    }
    return Array.from(buckets.entries())
      .map(([value, sourceAds]) => ({
        value,
        label: labelByValue.get(value) ?? value,
        adCount: sourceAds.length,
        sessions: sourceAds.reduce((sum, a) => sum + a._count.sessions, 0),
        active: sourceAds.filter((a) => a.isActive).length,
      }))
      .sort((a, b) => b.sessions - a.sessions)
  }, [ads, allSources])

  if (loading) return <div className="text-center py-12 text-grey-40">Loading...</div>

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow={`${ads.length} campaign${ads.length === 1 ? '' : 's'}`}
        title="Campaigns"
        description="Acquisition and source tracking. Spin up tracked links, monitor where applicants come from, and reuse ad copy templates."
        actions={<Button size="sm" onClick={openCreate}>+ New Campaign</Button>}
      />

      <div className="px-8 py-4">

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-surface-border">
        {[
          { key: 'overview' as const,  label: 'Overview' },
          { key: 'campaigns' as const, label: `All Campaigns (${ads.length})` },
          { key: 'sources' as const,   label: `Sources (${sourceStats.length})` },
          { key: 'templates' as const, label: `Templates (${adTemplates.length})` },
        ].map(t => (
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

      {/* OVERVIEW TAB — position-grouped cards. Each card aggregates ads by
          Ad.targetPosition (null → Unassigned) and offers quick jumps to
          the existing Candidates / Analytics pages with the targetPosition
          filter pre-applied. "View ads" deep-links to the per-position
          detail at /dashboard/campaigns/[position]. */}
      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Total campaigns" value={ads.length} />
            <Stat label="Active campaigns" value={activeAds} />
            <Stat label="Applicants" value={totalSessions} />
            <Stat label="Positions" value={positionGroups.filter((g) => g.key !== UNASSIGNED_POSITION_SLUG).length} />
          </div>

          {positionGroups.length === 0 ? (
            <div className="section-card text-center py-16">
              <h2 className="text-xl font-semibold text-grey-15 mb-2">No campaigns yet</h2>
              <p className="text-grey-35 mb-6">Add your first ad and tag it with a target position to start grouping by role.</p>
              <button onClick={openCreate} className="btn-primary">+ New Campaign</button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {positionGroups.map((g) => (
                <div key={g.key} className="rounded-[12px] border border-surface-border bg-white p-5 flex flex-col gap-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[15px] font-semibold text-ink truncate">{g.label}</div>
                      <div className="text-[12px] text-grey-40 mt-0.5">
                        {g.adsCount} ad{g.adsCount === 1 ? '' : 's'} · {g.activeCount} active
                      </div>
                    </div>
                    {g.key === UNASSIGNED_POSITION_SLUG && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-surface-light text-grey-50">No position</span>
                    )}
                  </div>

                  <dl className="grid grid-cols-2 gap-2 text-[12px]">
                    <div>
                      <dt className="font-mono uppercase tracking-[0.08em] text-grey-50 text-[10px] mb-0.5">Applicants</dt>
                      <dd className="text-ink font-semibold">{g.totalApplicants}</dd>
                    </div>
                    <div>
                      <dt className="font-mono uppercase tracking-[0.08em] text-grey-50 text-[10px] mb-0.5">Last activity</dt>
                      <dd className="text-grey-15">{g.lastActivityAt ? g.lastActivityAt.toLocaleDateString() : '—'}</dd>
                    </div>
                  </dl>

                  <div>
                    <div className="font-mono uppercase tracking-[0.08em] text-grey-50 text-[10px] mb-1">Main sources</div>
                    <div className="flex flex-wrap gap-1">
                      {g.topSources.length === 0 ? (
                        <span className="text-[12px] text-grey-40">—</span>
                      ) : (
                        g.topSources.map((s) => (
                          <span key={s} className="text-[11px] px-2 py-0.5 rounded-full bg-surface-light text-grey-20 capitalize">{s}</span>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="mt-auto pt-3 border-t border-surface-divider space-y-2 text-[12px]">
                    {g.key !== UNASSIGNED_POSITION_SLUG && (
                      <button
                        type="button"
                        onClick={() => renamePositionInline(g.label)}
                        disabled={renamingPosition === g.label}
                        className="w-full inline-flex items-center justify-center px-2.5 py-1.5 rounded-[8px] bg-ink text-white hover:bg-grey-15 disabled:opacity-50 font-medium"
                        title="Rename this position (bulk-updates every ad in it)"
                      >
                        {renamingPosition === g.label ? 'Renaming…' : 'Edit position'}
                      </button>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <Link
                        href={`/dashboard/campaigns/${encodeURIComponent(g.key)}`}
                        className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-[8px] border border-surface-border bg-white text-ink hover:bg-surface-light font-medium"
                      >
                        View ads
                      </Link>
                      <Link
                        href={`/dashboard/candidates?targetPosition=${encodeURIComponent(g.key)}`}
                        className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-[8px] border border-surface-border bg-white text-ink hover:bg-surface-light font-medium"
                      >
                        Candidates
                      </Link>
                      <Link
                        href={`/dashboard/candidates?view=kanban&targetPosition=${encodeURIComponent(g.key)}`}
                        className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-[8px] border border-surface-border bg-white text-ink hover:bg-surface-light font-medium"
                      >
                        Pipeline
                      </Link>
                      <Link
                        href={`/dashboard/analytics?targetPosition=${encodeURIComponent(g.key)}`}
                        className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-[8px] border border-surface-border bg-white text-ink hover:bg-surface-light font-medium"
                      >
                        Analytics
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ALL CAMPAIGNS TAB — was the legacy 'ads' tab. Content unchanged. */}
      {tab === 'campaigns' && (
        <>
          {ads.length === 0 ? (
            <div className="section-card text-center py-16">
              <div className="w-16 h-16 mx-auto mb-4 bg-brand-50 rounded-[8px] flex items-center justify-center">
                <svg className="w-8 h-8 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
              </div>
              <h2 className="text-xl font-semibold text-grey-15 mb-2">No ads yet</h2>
              <p className="text-grey-35 mb-6">Create your first tracked ad to start tracking candidate sources</p>
              <button onClick={openCreate} className="btn-primary">+ New Ad</button>
            </div>
          ) : (
            <>
              {/* Filters — narrow the table by source and/or flow. Counts
                  next to the result line make it obvious when a filter is
                  hiding rows. */}
              <div className="flex flex-wrap items-center gap-2.5 mb-3">
                <select
                  value={adsSourceFilter}
                  onChange={(e) => setAdsSourceFilter(e.target.value)}
                  className="px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  title="Filter ads by source"
                >
                  <option value="">All sources</option>
                  {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  {customSources.length > 0 && (
                    <optgroup label="Custom">
                      {customSources.map((s) => <option key={s} value={s}>{s}</option>)}
                    </optgroup>
                  )}
                </select>
                <select
                  value={adsFlowFilter}
                  onChange={(e) => setAdsFlowFilter(e.target.value)}
                  className="px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  title="Filter ads by flow"
                >
                  <option value="">All flows</option>
                  {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <select
                  value={adsDateFilter}
                  onChange={(e) => setAdsDateFilter(e.target.value as typeof adsDateFilter)}
                  className="px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-15 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  title="Filter ads by launch date"
                >
                  <option value="all">All time</option>
                  <option value="today">Today</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="90d">Last 90 days</option>
                  <option value="thisMonth">This month</option>
                  <option value="lastMonth">Last month</option>
                </select>
                {(adsSourceFilter || adsFlowFilter || adsDateFilter !== 'all') && (
                  <>
                    <button
                      onClick={() => { setAdsSourceFilter(''); setAdsFlowFilter(''); setAdsDateFilter('all') }}
                      className="px-3 py-2 text-sm text-grey-40 hover:text-grey-15"
                    >
                      Clear
                    </button>
                    <span className="text-xs text-grey-50 ml-auto">
                      Showing {filteredAds.length} of {ads.length} ads
                    </span>
                  </>
                )}
              </div>
              {filteredAds.length === 0 ? (
                <div className="section-card text-center py-12">
                  <p className="text-grey-35">No ads match the current filters.</p>
                  <button
                    onClick={() => { setAdsSourceFilter(''); setAdsFlowFilter(''); setAdsDateFilter('all') }}
                    className="mt-3 text-sm text-brand-500 hover:text-brand-600 font-medium"
                  >
                    Clear filters
                  </button>
                </div>
              ) : (
            <div className="bg-white rounded-lg border border-surface-border overflow-hidden">
              <table className="min-w-full">
                <thead>
                  <tr className="border-b border-surface-border bg-surface">
                    <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase w-[68px]"></th>
                    <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Name</th>
                    <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Source</th>
                    <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Flow</th>
                    <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Campaign</th>
                    <th className="px-5 py-3 text-right text-xs font-medium text-grey-40 uppercase">Candidates</th>
                    <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Status</th>
                    <th className="px-5 py-3 text-right text-xs font-medium text-grey-40 uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {filteredAds.map((ad) => (
                    <tr key={ad.id} className="hover:bg-surface-light">
                      <td className="px-5 py-4">
                        {ad.imageUrl ? (
                          <img src={ad.imageUrl} alt="" className="w-10 h-10 rounded-[6px] object-cover border border-surface-border" />
                        ) : (
                          <div className="w-10 h-10 rounded-[6px] bg-surface border border-surface-border flex items-center justify-center text-grey-50">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-grey-15">{ad.name}</span>
                          {ad.placementUrl && (
                            <a
                              href={ad.placementUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Open placement: ${ad.placementUrl}`}
                              className="text-grey-40 hover:text-brand-500"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                            </a>
                          )}
                        </div>
                        <div className="text-xs text-grey-50 mt-0.5">{new Date(ad.createdAt).toLocaleDateString()}</div>
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-xs px-2.5 py-1 rounded-full bg-brand-50 text-brand-600 font-medium capitalize">{ad.source}</span>
                      </td>
                      <td className="px-5 py-4 text-sm text-grey-35">
                        <div className="flex items-center gap-2">
                          <span>{ad.flow.name}</span>
                          {!ad.flow.isPublished && (
                            <Link href={`/dashboard/flows/${ad.flow.id}/builder`} title="Flow is not published — link will 404" className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium hover:bg-amber-200">Unpublished</Link>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-4 text-sm text-grey-40">{ad.campaign || '—'}</td>
                      <td className="px-5 py-4 text-sm font-semibold text-grey-15 text-right">{ad._count.sessions}</td>
                      <td className="px-5 py-4">
                        <button onClick={() => toggleActive(ad)} className={`text-xs px-2.5 py-1 rounded-full font-medium ${ad.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-grey-40'}`}>
                          {ad.isActive ? 'Active' : 'Paused'}
                        </button>
                      </td>
                      <td className="px-5 py-4 text-right space-x-3">
                        <Link href={`/dashboard/campaigns/preview/${ad.id}`} className="text-xs text-purple-500 hover:text-purple-600 font-medium">Preview</Link>
                        <button onClick={() => copyLink(ad.slug, ad.id)} className="text-xs text-brand-500 hover:text-brand-600 font-medium">
                          {copiedId === ad.id ? 'Copied!' : 'Copy Link'}
                        </button>
                        <button onClick={() => copyAdText(ad)} className="text-xs text-brand-500 hover:text-brand-600 font-medium" title="Copy headline + body + CTA + link — paste into Telegram, Facebook, etc.">
                          {copiedTextId === ad.id ? 'Copied!' : 'Copy Text'}
                        </button>
                        <button onClick={() => openEdit(ad)} className="text-xs text-grey-35 hover:text-grey-15">Edit</button>
                        <button onClick={() => openDuplicate(ad)} className="text-xs text-grey-35 hover:text-grey-15">Duplicate</button>
                        <button onClick={() => deleteAd(ad.id)} className="text-xs text-grey-35 hover:text-grey-15">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
              )}
            </>
          )}
        </>
      )}

      {/* SOURCES TAB */}
      {tab === 'sources' && (
        <div className="bg-white rounded-lg border border-surface-border overflow-hidden">
          {sourceStats.length === 0 ? (
            <div className="text-center py-16 text-grey-40">No sources yet — create an ad to start tracking</div>
          ) : (
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-surface-border bg-surface">
                  <th className="px-5 py-3 text-left text-xs font-medium text-grey-40 uppercase">Source</th>
                  <th className="px-5 py-3 text-right text-xs font-medium text-grey-40 uppercase">Ads</th>
                  <th className="px-5 py-3 text-right text-xs font-medium text-grey-40 uppercase">Active</th>
                  <th className="px-5 py-3 text-right text-xs font-medium text-grey-40 uppercase">Candidates</th>
                  <th className="px-5 py-3 text-right text-xs font-medium text-grey-40 uppercase">% of Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {sourceStats.map(s => (
                  <tr key={s.value} className="hover:bg-surface-light">
                    <td className="px-5 py-4">
                      <span className="text-xs px-2.5 py-1 rounded-full bg-brand-50 text-brand-600 font-medium">{s.label}</span>
                    </td>
                    <td className="px-5 py-4 text-sm text-grey-35 text-right">{s.adCount}</td>
                    <td className="px-5 py-4 text-sm text-right">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.active > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-grey-40'}`}>{s.active}</span>
                    </td>
                    <td className="px-5 py-4 text-sm font-semibold text-grey-15 text-right">{s.sessions}</td>
                    <td className="px-5 py-4 text-sm text-grey-40 text-right">
                      {totalSessions > 0 ? `${Math.round((s.sessions / totalSessions) * 100)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* TRACKED LINKS TAB */}
      {/* TEMPLATES TAB — reusable ad-copy templates (AdTemplate rows). The
          legacy 'Tracked Links' panel moved into the campaign row's "Copy
          link" affordance on the All Campaigns tab; no information was lost. */}
      {tab === 'templates' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-[14px] text-ink">Ad copy templates</h3>
              <p className="text-[12px] text-grey-35">Reusable headline / body / CTA presets that prefill the campaign editor.</p>
            </div>
            <button
              onClick={() => { setEditingTemplate(null); setTemplateEditorOpen(true) }}
              className="px-3 py-2 rounded-[10px] border border-surface-border text-[13px] text-ink hover:bg-surface-light"
            >
              + New template
            </button>
          </div>
          {adTemplates.length === 0 ? (
            <div className="bg-white rounded-[12px] border border-surface-border p-8 text-center text-grey-40">
              No templates yet. Seed defaults from a campaign you've already written, or click <b>+ New template</b>.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {adTemplates.map((t) => (
                <Card key={t.id} padding={16}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="font-medium text-[14px] text-ink">{t.name}</div>
                    <span className="text-[11px] text-grey-35 capitalize">{t.source}</span>
                  </div>
                  <div className="text-[12px] text-grey-15 mb-2 line-clamp-2">{t.headline}</div>
                  <div className="text-[11px] text-grey-35 line-clamp-3">{t.bodyText}</div>
                  <button
                    onClick={() => { setEditingTemplate(t); setTemplateEditorOpen(true) }}
                    className="mt-3 text-[12px] text-ink underline"
                  >
                    Edit
                  </button>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Hidden — legacy 'links' tab kept compiled for backwards-compat
          string maps. Never selected because the tab type doesn't include it. */}
      {false && (
        <div className="space-y-3">
          {ads.length === 0 ? (
            <div className="bg-white rounded-[12px] border border-surface-border p-8 text-center text-grey-40">No tracked links yet</div>
          ) : ads.map(ad => (
            <div key={ad.id} className="bg-white rounded-[8px] border border-surface-border p-4 flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-grey-15">{ad.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-brand-50 text-brand-600 capitalize">{ad.source}</span>
                  {!ad.isActive && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-grey-40">Paused</span>}
                  {!ad.flow.isPublished && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700" title="Flow not published — link will 404">Flow unpublished</span>}
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-xs text-grey-35 bg-surface px-2 py-1 rounded truncate">{baseUrl}/a/{ad.slug}</code>
                  <span className="text-xs text-grey-40 flex-shrink-0">{ad._count.sessions} candidates</span>
                </div>
              </div>
              <button
                onClick={() => copyLink(ad.slug, ad.id)}
                className={`ml-4 px-4 py-2 text-xs font-medium rounded-[8px] flex-shrink-0 transition-colors ${
                  copiedId === ad.id ? 'bg-green-100 text-green-700' : 'bg-brand-500 text-white hover:bg-brand-600'
                }`}
              >
                {copiedId === ad.id ? 'Copied!' : 'Copy Link'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-white rounded-[12px] shadow-2xl p-6 w-full max-w-[640px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-semibold text-grey-15 mb-5">{editingAd ? 'Edit Ad' : 'New Ad'}</h2>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-grey-20 mb-1.5">Ad Name</label>
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Indeed Cleaner Ad - Miami" className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" autoFocus />
                </div>
                <div>
                  <label className="block text-sm font-medium text-grey-20 mb-1.5">Assign to Flow</label>
                  <select value={flowId} onChange={(e) => setFlowId(e.target.value)} className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                    <option value="">Select flow...</option>
                    {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Source</label>
                <div className="grid grid-cols-5 gap-1.5">
                  {allSources.map(({ value, label }) => (
                    <button type="button" key={value} onClick={() => { setSource(value); loadAdCopyDefaults(value) }} className={`py-1.5 text-xs rounded-[6px] border font-medium ${source === value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-grey-35 hover:bg-surface'}`}>
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => { setAddingSource(true); setNewSourceName(''); setSourceError(null) }}
                    title="Add custom source"
                    className="py-1.5 text-xs rounded-[6px] border border-dashed border-surface-border text-grey-50 hover:bg-surface hover:text-grey-15 font-medium"
                  >
                    + Add
                  </button>
                </div>
                {addingSource && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="text"
                      autoFocus
                      value={newSourceName}
                      onChange={(e) => setNewSourceName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addCustomSource() }
                        else if (e.key === 'Escape') { setAddingSource(false); setNewSourceName(''); setSourceError(null) }
                      }}
                      placeholder="e.g. Career Fair"
                      className="flex-1 px-3 py-2 border border-surface-border rounded-[6px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <button
                      type="button"
                      onClick={() => { setAddingSource(false); setNewSourceName(''); setSourceError(null) }}
                      className="px-3 py-2 text-xs rounded-[6px] border border-surface-border text-grey-35 hover:bg-surface"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!newSourceName.trim() || savingSource}
                      onClick={addCustomSource}
                      className="px-3 py-2 text-xs rounded-[6px] bg-brand-500 text-white font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {savingSource ? 'Saving…' : 'Add'}
                    </button>
                  </div>
                )}
                {sourceError && <p className="text-xs text-red-500 mt-1">{sourceError}</p>}
                <p className="text-xs text-grey-50 mt-1">Changing source loads recommended ad copy for that platform</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Target position (optional)</label>
                <input
                  type="text"
                  value={targetPosition}
                  onChange={(e) => setTargetPosition(e.target.value)}
                  placeholder="e.g. Dispatcher, Cleaner, Office Manager"
                  list="campaigns-target-positions"
                  className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <datalist id="campaigns-target-positions">
                  {Array.from(new Set(ads.map((a) => a.targetPosition).filter((p): p is string => !!p))).map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
                <p className="text-xs text-grey-50 mt-1">Role this ad is hiring for. Drives the position-grouped overview and the targetPosition filter on Candidates / Analytics. Leave blank for Unassigned.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Campaign / Group (optional)</label>
                <input type="text" value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="e.g. Q1 Hiring, Miami Market" className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>

              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Placement URL (optional)</label>
                <input
                  type="url"
                  value={placementUrl}
                  onChange={(e) => setPlacementUrl(e.target.value)}
                  placeholder="https://t.me/yourgroup or https://www.facebook.com/groups/..."
                  className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <p className="text-xs text-grey-50 mt-1">Where you posted this ad — Telegram group, Facebook group, Indeed listing, etc. Just for your reference.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">
                  Notes <span className="text-xs text-grey-50 font-normal">(private — never shown to candidates)</span>
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Internal reminders, A/B test details, who posted it, contact at the group, etc."
                  className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              {/* Picture */}
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Picture (optional)</label>
                {imageUrl ? (
                  <div className="flex items-start gap-3">
                    <img src={imageUrl} alt="Ad" className="w-24 h-24 object-cover rounded-[8px] border border-surface-border" />
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs text-brand-500 hover:text-brand-600 font-medium cursor-pointer">
                        Replace
                        <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.target.value = '' }} />
                      </label>
                      <button type="button" onClick={openLibrary} className="text-xs text-grey-35 hover:text-grey-15 text-left">Choose from library</button>
                      <button type="button" onClick={() => setImageUrl(null)} className="text-xs text-red-500 hover:text-red-600 text-left">Remove</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <label className={`flex-1 border-2 border-dashed border-surface-border rounded-[8px] p-4 text-center cursor-pointer hover:bg-surface ${imageUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                      <div className="text-sm text-grey-35">{imageUploading ? 'Uploading…' : 'Click to upload — PNG/JPG up to 10MB'}</div>
                      <input type="file" accept="image/*" className="hidden" disabled={imageUploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.target.value = '' }} />
                    </label>
                    <button type="button" onClick={openLibrary} className="px-3 py-2 border border-surface-border rounded-[8px] text-sm text-grey-35 hover:bg-surface">Library</button>
                  </div>
                )}
                {imageError && <p className="text-xs text-red-500 mt-1">{imageError}</p>}
              </div>

              {/* Ad Copy Section */}
              <div className="border-t border-surface-border pt-4">
                <div className="mb-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-sm font-medium text-grey-20">Ad Copy Template</label>
                    <div className="flex gap-3 text-xs">
                      <button
                        type="button"
                        onClick={openTemplateEdit}
                        disabled={selectedTemplateId === '__default__'}
                        className="text-brand-500 hover:text-brand-600 font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Edit template
                      </button>
                      <button
                        type="button"
                        onClick={openTemplateNew}
                        className="text-brand-500 hover:text-brand-600 font-medium"
                      >
                        + New template
                      </button>
                    </div>
                  </div>
                  <select
                    value={selectedTemplateId}
                    onChange={(e) => {
                      const val = e.target.value
                      setSelectedTemplateId(val)
                      if (val === '__default__') { loadAdCopyDefaults(source); return }
                      const t = adTemplates.find(t => t.id === val)
                      if (t) {
                        setAdHeadline(t.headline); setAdBody(t.bodyText); setAdCta(t.callToAction || '')
                        setAdRequirements(t.requirements || ''); setAdBenefits(t.benefits || '')
                      }
                    }}
                    className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="__default__">Default — {SOURCES.find(s => s.value === source)?.label || source} template</option>
                    {adTemplates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.source})</option>)}
                  </select>
                  <p className="text-xs text-grey-50 mt-1">{adTemplates.length === 0 ? 'No saved templates yet — click "+ New template" to save your copy for reuse.' : 'Pick a saved template or edit below.'}</p>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-grey-40 mb-1">Headline</label>
                    <input type="text" value={adHeadline} onChange={(e) => setAdHeadline(e.target.value)} className="w-full px-3 py-2 border border-surface-border rounded-[6px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </div>
                  <div>
                    <label className="block text-xs text-grey-40 mb-1">Body</label>
                    <textarea value={adBody} onChange={(e) => setAdBody(e.target.value)} rows={5} className="w-full px-3 py-2 border border-surface-border rounded-[6px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </div>
                  <div>
                    <label className="block text-xs text-grey-40 mb-1">Call to Action</label>
                    <input type="text" value={adCta} onChange={(e) => setAdCta(e.target.value)} className="w-full px-3 py-2 border border-surface-border rounded-[6px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </div>
                </div>
              </div>

              {editingAd && (
                <div className="bg-surface rounded-[8px] p-3">
                  <label className="block text-xs text-grey-40 mb-1">Tracked Link</label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-sm text-grey-15 truncate">{baseUrl}/a/{editingAd.slug}</code>
                    <button onClick={() => copyLink(editingAd.slug, editingAd.id)} className="text-xs text-brand-500 hover:text-brand-600 flex-shrink-0">{copiedId === editingAd.id ? 'Copied!' : 'Copy'}</button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowModal(false)} className="btn-secondary flex-1">Cancel</button>
              <button onClick={save} disabled={saving || !name.trim() || !flowId} className="btn-primary flex-1 disabled:opacity-50">{saving ? 'Saving...' : editingAd ? 'Save Changes' : 'Create Ad'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Template Editor Modal */}
      {templateEditorOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center z-[60]" onClick={() => !tplSaving && !tplDeleting && setTemplateEditorOpen(false)}>
          <div className="bg-white rounded-[12px] shadow-2xl p-6 w-full max-w-[640px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-semibold text-grey-15 mb-5">{editingTemplate ? 'Edit Template' : 'New Template'}</h2>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-grey-20 mb-1.5">Template name</label>
                  <input type="text" value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="e.g. Indeed Cleaner — Miami" className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" autoFocus />
                </div>
                <div>
                  <label className="block text-sm font-medium text-grey-20 mb-1.5">Source</label>
                  <select value={tplSource} onChange={(e) => setTplSource(e.target.value)} className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                    <option value="general">General (any source)</option>
                    {SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Headline</label>
                <input type="text" value={tplHeadline} onChange={(e) => setTplHeadline(e.target.value)} className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Body</label>
                <textarea value={tplBody} onChange={(e) => setTplBody(e.target.value)} rows={5} className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-grey-20 mb-1.5">Requirements (optional)</label>
                  <textarea value={tplRequirements} onChange={(e) => setTplRequirements(e.target.value)} rows={3} className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-grey-20 mb-1.5">Benefits (optional)</label>
                  <textarea value={tplBenefits} onChange={(e) => setTplBenefits(e.target.value)} rows={3} className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-grey-20 mb-1.5">Call to Action</label>
                <input type="text" value={tplCta} onChange={(e) => setTplCta(e.target.value)} className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
            </div>

            <div className="flex gap-3 mt-5">
              {editingTemplate ? (
                <button onClick={deleteTemplate} disabled={tplSaving || tplDeleting} className="text-sm text-red-500 hover:text-red-600 font-medium px-3 disabled:opacity-50">
                  {tplDeleting ? 'Deleting…' : 'Delete'}
                </button>
              ) : <div className="flex-1" />}
              <div className="flex-1" />
              <button onClick={() => setTemplateEditorOpen(false)} disabled={tplSaving || tplDeleting} className="btn-secondary">Cancel</button>
              <button onClick={saveTemplate} disabled={tplSaving || tplDeleting || !tplName.trim() || !tplHeadline.trim() || !tplBody.trim()} className="btn-primary disabled:opacity-50">
                {tplSaving ? 'Saving…' : editingTemplate ? 'Save changes' : 'Create template'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Picture Library Modal */}
      {showLibrary && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center z-[60]" onClick={() => setShowLibrary(false)}>
          <div className="bg-white rounded-[12px] shadow-2xl p-6 w-full max-w-[680px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-grey-15">Choose a picture</h2>
              <label className="text-xs text-brand-500 hover:text-brand-600 font-medium cursor-pointer">
                + Upload new
                <input type="file" accept="image/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { await uploadImage(f); setShowLibrary(false) } e.target.value = '' }} />
              </label>
            </div>
            <div className="flex-1 overflow-y-auto">
              {picturesLoading ? (
                <div className="text-center py-12 text-grey-40 text-sm">Loading…</div>
              ) : pictures.length === 0 ? (
                <div className="text-center py-12 text-grey-40 text-sm">No pictures yet — upload one above.</div>
              ) : (
                <div className="grid grid-cols-4 gap-3">
                  {pictures.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => { setImageUrl(p.url); setShowLibrary(false) }}
                      className={`group relative aspect-square rounded-[8px] overflow-hidden border-2 ${imageUrl === p.url ? 'border-brand-500' : 'border-surface-border hover:border-brand-300'}`}
                    >
                      <img src={p.url} alt={p.displayName || p.filename} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end mt-4">
              <button onClick={() => setShowLibrary(false)} className="btn-secondary">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicate Modal */}
      {duplicatingAd && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50"
          onMouseDown={(e) => { backdropMouseDownTarget.current = e.target }}
          onMouseUp={(e) => {
            // Only close if both mousedown and mouseup happened on the backdrop itself
            if (!duplicating && e.target === e.currentTarget && backdropMouseDownTarget.current === e.currentTarget) {
              setDuplicatingAd(null)
            }
            backdropMouseDownTarget.current = null
          }}
        >
          <div className="bg-white rounded-[12px] shadow-2xl p-6 w-full max-w-[440px]" onMouseDown={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-semibold text-grey-15 mb-2">Duplicate Ad</h2>
            <p className="text-sm text-grey-40 mb-4">Create a copy of <span className="font-medium text-grey-20">{duplicatingAd.name}</span> with a new tracked link.</p>
            <label className="block text-sm font-medium text-grey-20 mb-1.5">New ad name</label>
            <input
              type="text"
              value={duplicateName}
              onChange={(e) => setDuplicateName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmDuplicate() }}
              placeholder="e.g. Indeed Cleaner Ad - Miami (copy)"
              className="w-full px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              autoFocus
            />
            <div className="flex gap-3 mt-5">
              <button onClick={() => setDuplicatingAd(null)} disabled={duplicating} className="btn-secondary flex-1">Cancel</button>
              <button onClick={confirmDuplicate} disabled={duplicating || !duplicateName.trim()} className="btn-primary flex-1 disabled:opacity-50">{duplicating ? 'Duplicating...' : 'Duplicate'}</button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
