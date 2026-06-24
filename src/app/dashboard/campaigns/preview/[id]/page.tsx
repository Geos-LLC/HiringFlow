'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { TelegramPublishModal } from './_TelegramPublishModal'
import { TelegramPlacementHistory } from './_TelegramPlacementHistory'

interface Ad {
  id: string; name: string; source: string; campaign: string | null
  slug: string; isActive: boolean
  templateId: string | null
  headline: string | null; bodyText: string | null
  requirements: string | null; benefits: string | null; callToAction: string | null
  imageUrl: string | null
  flow: { id: string; name: string; slug: string; isPublished: boolean }
}
interface AdTemplate {
  id: string; name: string; source: string; headline: string; bodyText: string
  requirements: string | null; benefits: string | null; callToAction: string | null
}

const DEFAULT_COPY: Record<string, { headline: string; body: string; requirements: string; benefits: string; cta: string }> = {
  indeed: { headline: 'Now Hiring — Join Our Team!', body: 'We are looking for motivated team members to join our growing company.\n\nThis is a great opportunity for someone who wants to grow their career.', requirements: '- Must be authorized to work\n- Reliable transportation\n- Positive attitude', benefits: '- Competitive pay\n- Flexible schedule\n- Growth opportunities', cta: 'Apply now — takes less than 5 minutes!' },
  facebook: { headline: "We're Hiring! Come Work With Us", body: "Looking for your next gig? We're hiring and we'd love to hear from you.\n\nNo long applications. Just a quick intro and you could start next week.", requirements: '', benefits: '- Weekly pay\n- Friendly team\n- No experience needed', cta: 'Tap the link to apply — it only takes a few minutes!' },
  craigslist: { headline: 'HIRING NOW — Apply Today', body: 'Immediate openings available.\n\nWe are looking for reliable, hardworking individuals. Full-time and part-time positions.', requirements: '- Must be 18+\n- Background check required\n- Valid ID', benefits: '- Start ASAP\n- Paid training\n- Weekly pay', cta: 'Click the link below to apply online.' },
  _default: { headline: 'We Are Hiring!', body: 'Join our team! We have openings available and are looking for great people.', requirements: '', benefits: '- Competitive pay\n- Great team', cta: 'Apply now through our quick online process!' },
}

const SOURCE_STYLES: Record<string, { bg: string; accent: string; logo: string; name: string }> = {
  indeed: { bg: '#F5F5F5', accent: '#2164F3', logo: '#2164F3', name: 'Indeed' },
  facebook: { bg: '#F0F2F5', accent: '#1877F2', logo: '#1877F2', name: 'Facebook Jobs' },
  craigslist: { bg: '#F5F0FF', accent: '#800080', logo: '#800080', name: 'Craigslist' },
  linkedin: { bg: '#F3F6F8', accent: '#0A66C2', logo: '#0A66C2', name: 'LinkedIn Jobs' },
  google: { bg: '#F8F9FA', accent: '#1A73E8', logo: '#4285F4', name: 'Google Jobs' },
  _default: { bg: '#F7F7F8', accent: '#FF9500', logo: '#FF9500', name: 'Job Board' },
}

function buildAdText(opts: {
  headline: string
  body: string
  requirements?: string
  benefits?: string
  cta?: string
  link: string
}): string {
  const parts: string[] = []
  if (opts.headline) parts.push(opts.headline)
  if (opts.body) parts.push(opts.body)
  if (opts.requirements && opts.requirements.trim()) parts.push(`Requirements:\n${opts.requirements}`)
  if (opts.benefits && opts.benefits.trim()) parts.push(`What we offer:\n${opts.benefits}`)
  if (opts.cta && opts.cta.trim()) parts.push(opts.cta)
  parts.push(`Apply: ${opts.link}`)
  return parts.join('\n\n')
}

export default function AdPreviewPage() {
  const params = useParams()
  const id = params.id as string
  const [ad, setAd] = useState<Ad | null>(null)
  const [templates, setTemplates] = useState<AdTemplate[]>([])
  // '__saved__' = use the ad's persisted copy. Default to that whenever the ad
  // has any copy of its own; only fall back to the source default for legacy
  // rows with all-null copy fields.
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('__saved__')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [tgModalOpen, setTgModalOpen] = useState(false)
  const [tgHistoryKey, setTgHistoryKey] = useState(0)

  useEffect(() => {
    Promise.all([
      fetch(`/api/ads/${id}`).then(r => r.ok ? r.json() : null),
      fetch('/api/ad-templates').then(r => r.json()).catch(() => []),
    ]).then(([a, t]) => {
      setAd(a)
      setTemplates(t)
      setLoading(false)
      // If the ad has no saved copy at all, default the picker to its templateId
      // (if any) or the source default.
      if (a) {
        const hasSavedCopy = !!(a.headline || a.bodyText || a.callToAction || a.requirements || a.benefits)
        if (!hasSavedCopy) setSelectedTemplateId(a.templateId || '__default__')
      }
    })
  }, [id])

  if (loading) return <div className="text-center py-12 text-grey-40">Loading...</div>
  if (!ad) return <div className="text-center py-12 text-grey-40">Ad not found</div>

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (typeof window !== 'undefined' ? window.location.origin : '')
  const trackedLink = `${baseUrl}/a/${ad.slug}`
  const style = SOURCE_STYLES[ad.source] || SOURCE_STYLES._default

  // Resolve copy: '__saved__' uses the ad's own fields, '__default__' uses the
  // source-default copy, anything else looks up the named template. Anywhere a
  // field is missing we fall back to the source default for that single field.
  const sourceDefault = DEFAULT_COPY[ad.source] || DEFAULT_COPY._default
  let copy: { headline: string; body: string; requirements: string; benefits: string; cta: string }
  if (selectedTemplateId === '__saved__') {
    copy = {
      headline: ad.headline || sourceDefault.headline,
      body: ad.bodyText || sourceDefault.body,
      requirements: ad.requirements || '',
      benefits: ad.benefits || '',
      cta: ad.callToAction || sourceDefault.cta,
    }
  } else if (selectedTemplateId !== '__default__') {
    const t = templates.find(t => t.id === selectedTemplateId)
    if (t) {
      copy = { headline: t.headline, body: t.bodyText, requirements: t.requirements || '', benefits: t.benefits || '', cta: t.callToAction || '' }
    } else {
      copy = sourceDefault
    }
  } else {
    copy = sourceDefault
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href="/dashboard/campaigns" className="text-grey-40 hover:text-grey-15">&larr; Campaigns</Link>
          <h1 className="text-xl font-semibold text-grey-15">Ad Preview</h1>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={selectedTemplateId}
            onChange={(e) => setSelectedTemplateId(e.target.value)}
            className="px-3 py-2 text-sm border border-surface-border rounded-[8px] text-grey-15"
          >
            <option value="__saved__">Saved copy{ad.templateId ? ` (${templates.find(t => t.id === ad.templateId)?.name || 'template'})` : ''}</option>
            <option value="__default__">Default {ad.source} copy</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button
            onClick={async () => {
              const text = buildAdText({
                headline: copy.headline,
                body: copy.body,
                requirements: copy.requirements,
                benefits: copy.benefits,
                cta: copy.cta,
                link: trackedLink,
              })
              try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch {}
            }}
            className={`px-4 py-2 text-sm font-medium rounded-[8px] transition-colors ${copied ? 'bg-green-100 text-green-700' : 'bg-brand-500 text-white hover:bg-brand-600'}`}
            title="Copy headline + body + CTA + link as plain text — ready to paste into Telegram, Facebook, etc."
          >
            {copied ? 'Copied!' : 'Copy ad text'}
          </button>
          <button
            onClick={() => setTgModalOpen(true)}
            className="px-4 py-2 text-sm font-medium rounded-[8px] border border-surface-border text-grey-15 hover:bg-surface transition-colors"
            title="Publish this ad to one or more Telegram channels via your workspace bot"
          >
            Publish to Telegram
          </button>
        </div>
      </div>

      {/* Mock job board posting */}
      <div className="max-w-2xl mx-auto">
        {/* Mock browser chrome */}
        <div className="bg-gray-200 rounded-t-[12px] px-4 py-2.5 flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-400" />
            <div className="w-3 h-3 rounded-full bg-yellow-400" />
            <div className="w-3 h-3 rounded-full bg-green-400" />
          </div>
          <div className="flex-1 bg-white rounded-md px-3 py-1 text-xs text-grey-40 ml-2 truncate">
            {ad.source === 'craigslist' ? 'craigslist.org > jobs > general labor' : `${ad.source}.com/jobs`}
          </div>
        </div>

        {/* Mock site header */}
        <div className="px-6 py-3 border-b" style={{ backgroundColor: style.bg }}>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded flex items-center justify-center text-white text-xs font-bold" style={{ backgroundColor: style.logo }}>
              {style.name.charAt(0)}
            </div>
            <span className="text-sm font-semibold" style={{ color: style.accent }}>{style.name}</span>
          </div>
        </div>

        {/* Job posting */}
        <div className="bg-white border-x border-b rounded-b-[12px] shadow-lg">
          <div className="p-8">
            {/* Title */}
            <h1 className="text-2xl font-bold text-gray-900 mb-2">{copy.headline}</h1>
            <div className="flex items-center gap-3 mb-6 text-sm text-gray-500">
              <span>{ad.name}</span>
              <span>&middot;</span>
              <span className="capitalize">{ad.source}</span>
              {ad.campaign && <><span>&middot;</span><span>{ad.campaign}</span></>}
            </div>

            {/* Body */}
            <div className="text-gray-700 whitespace-pre-wrap mb-6 leading-relaxed">{copy.body}</div>

            {/* Requirements */}
            {copy.requirements && (
              <div className="mb-6">
                <h3 className="text-base font-semibold text-gray-900 mb-2">Requirements</h3>
                <div className="text-gray-700 whitespace-pre-wrap">{copy.requirements}</div>
              </div>
            )}

            {/* Benefits */}
            {copy.benefits && (
              <div className="mb-6">
                <h3 className="text-base font-semibold text-gray-900 mb-2">What We Offer</h3>
                <div className="text-gray-700 whitespace-pre-wrap">{copy.benefits}</div>
              </div>
            )}

            {/* CTA */}
            {copy.cta && (
              <div className="bg-gray-50 rounded-[8px] p-4 mb-6">
                <p className="text-gray-800 font-medium">{copy.cta}</p>
              </div>
            )}

            {/* Apply button — REAL tracked link */}
            <a
              href={trackedLink}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center py-4 rounded-[8px] text-white font-semibold text-lg transition-colors hover:opacity-90"
              style={{ backgroundColor: style.accent }}
            >
              Apply Now
            </a>

            <p className="text-center text-xs text-gray-400 mt-3">
              This link goes to: <code className="text-gray-500">{trackedLink}</code>
            </p>
          </div>
        </div>

        {/* Info below */}
        <div className="mt-6 bg-surface rounded-[8px] border border-surface-border p-4">
          <p className="text-xs text-grey-40 text-center">
            This is a mock preview of how your ad appears. The &quot;Apply Now&quot; button uses your real tracked link — clicking it starts the actual candidate workflow.
          </p>
        </div>
      </div>

      <TelegramPlacementHistory adId={ad.id} refreshKey={tgHistoryKey} />

      {tgModalOpen && (
        <TelegramPublishModal
          adId={ad.id}
          defaultText={buildAdText({
            headline: copy.headline,
            body: copy.body,
            requirements: copy.requirements,
            benefits: copy.benefits,
            cta: copy.cta,
            link: trackedLink,
          })}
          defaultImageUrl={ad.imageUrl}
          onClose={() => setTgModalOpen(false)}
          onDispatched={() => setTgHistoryKey((k) => k + 1)}
        />
      )}
    </div>
  )
}
