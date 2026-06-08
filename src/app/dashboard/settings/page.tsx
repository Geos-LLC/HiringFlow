'use client'

import { useState, useEffect } from 'react'
import { GoogleIntegrationCard } from './_GoogleIntegrationCard'
import { CertnIntegrationCard } from './_CertnIntegrationCard'
import { SenderVerificationCard } from './_SenderVerificationCard'
import { Badge, PageHeader, type BadgeTone } from '@/components/design'

interface Member { id: string; userId: string; email: string; name: string | null; role: string; joinedAt: string }
interface WorkspaceData {
  id: string; name: string; slug: string; plan: string
  website: string | null; phone: string | null; timezone: string
  logoUrl: string | null; senderName: string | null; senderEmail: string | null
  settings: Record<string, unknown> | null; createdAt: string
  members: Member[]; counts: { flows: number; sessions: number; ads: number; trainings: number }
}

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris',
  'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney',
]

export default function SettingsPage() {
  const [data, setData] = useState<WorkspaceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [tab, setTab] = useState<'business' | 'team' | 'email' | 'providers' | 'integrations'>('business')

  useEffect(() => {
    if (typeof window === 'undefined') return
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t === 'business' || t === 'team' || t === 'email' || t === 'providers' || t === 'integrations') setTab(t)
  }, [])

  // Form state
  const [name, setName] = useState('')
  const [website, setWebsite] = useState('')
  const [phone, setPhone] = useState('')
  const [timezone, setTimezone] = useState('America/New_York')
  const [senderName, setSenderName] = useState('')
  const [senderEmail, setSenderEmail] = useState('')

  // Team
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState('member')
  const [inviting, setInviting] = useState(false)

  useEffect(() => { fetchSettings() }, [])

  const fetchSettings = async () => {
    const r = await fetch('/api/workspace/settings')
    if (r.ok) {
      const d = await r.json()
      setData(d)
      setName(d.name); setWebsite(d.website || ''); setPhone(d.phone || '')
      setTimezone(d.timezone); setSenderName(d.senderName || ''); setSenderEmail(d.senderEmail || '')
    }
    setLoading(false)
  }

  const saveSettings = async () => {
    setSaving(true)
    await fetch('/api/workspace/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, website, phone, timezone, senderName, senderEmail }),
    })
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000)
    fetchSettings()
  }

  const inviteMember = async () => {
    if (!inviteEmail) return
    setInviting(true)
    const r = await fetch('/api/workspace/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail, name: inviteName, role: inviteRole }),
    })
    setInviting(false)
    if (r.ok) { setInviteEmail(''); setInviteName(''); fetchSettings() }
    else { const err = await r.json(); alert(err.error || 'Failed to invite') }
  }

  const updateRole = async (memberId: string, role: string) => {
    await fetch(`/api/workspace/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    fetchSettings()
  }

  const removeMember = async (memberId: string) => {
    if (!confirm('Remove this team member?')) return
    await fetch(`/api/workspace/members/${memberId}`, { method: 'DELETE' })
    fetchSettings()
  }

  if (loading) return <div className="py-14 text-center font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>Loading…</div>
  if (!data) return <div className="py-14 text-center text-[13px] text-[color:var(--danger-fg)]">Error loading settings</div>

  const planTone: BadgeTone = data.plan === 'enterprise' ? 'info' : data.plan === 'pro' ? 'brand' : data.plan === 'starter' ? 'success' : 'neutral'

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow={data.slug}
        title="Settings"
        description="Manage your workspace configuration."
        actions={<Badge tone={planTone}>{data.plan} plan</Badge>}
      />

      <div className="px-8 py-4">
      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-surface-divider">
        {[
          { key: 'business' as const, label: 'Business info' },
          { key: 'team' as const, label: `Team (${data.members.length})` },
          { key: 'email' as const, label: 'Email' },
          { key: 'providers' as const, label: 'Providers' },
          { key: 'integrations' as const, label: 'Integrations' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key ? 'text-ink' : 'border-transparent text-grey-35 hover:text-ink'
            }`}
            style={tab === t.key ? { borderColor: 'var(--brand-primary)' } : undefined}
          >
            {t.label}
          </button>
        ))}
        <a
          href="/dashboard/settings/billing"
          className="px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors border-transparent text-grey-35 hover:text-ink"
        >
          Billing
        </a>
        {/* Branding moved here from the top nav per the Content section
            redesign — recruiters only edit branding once in a while, so it
            belongs under Settings rather than competing for prime nav
            space. Still its own page; we just link to it. */}
        <a
          href="/dashboard/branding"
          className="px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors border-transparent text-grey-35 hover:text-ink"
        >
          Branding
        </a>
      </div>

      {/* BUSINESS TAB */}
      {tab === 'business' && (
        <div className="bg-white rounded-[12px] border border-surface-border p-6 max-w-2xl">
          <h3 className="text-lg font-semibold text-grey-15 mb-4">Business Information</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-grey-20 mb-1.5">Business Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-grey-20 mb-1.5">Website</label>
              <input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://yourcompany.com" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-grey-20 mb-1.5">Phone</label>
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 (555) 123-4567" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-grey-20 mb-1.5">Timezone</label>
              <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500">
                {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div className="bg-surface rounded-[8px] p-4">
              <div className="text-xs text-grey-40 mb-1">Workspace ID</div>
              <code className="text-sm text-grey-15">{data.id}</code>
            </div>
            <div className="bg-surface rounded-[8px] p-4 grid grid-cols-4 gap-4">
              <div><div className="text-lg font-bold text-grey-15">{data.counts.flows}</div><div className="text-xs text-grey-40">Flows</div></div>
              <div><div className="text-lg font-bold text-grey-15">{data.counts.sessions}</div><div className="text-xs text-grey-40">Candidates</div></div>
              <div><div className="text-lg font-bold text-grey-15">{data.counts.ads}</div><div className="text-xs text-grey-40">Ads</div></div>
              <div><div className="text-lg font-bold text-grey-15">{data.counts.trainings}</div><div className="text-xs text-grey-40">Trainings</div></div>
            </div>
          </div>
          <div className="mt-6">
            <button onClick={saveSettings} disabled={saving} className="btn-primary disabled:opacity-50">
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}

      {/* TEAM TAB */}
      {tab === 'team' && (
        <div className="max-w-2xl">
          {/* Invite */}
          <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
            <h3 className="text-lg font-semibold text-grey-15 mb-4">Invite Team Member</h3>
            <div className="flex gap-3">
              <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="Email address" className="flex-1 px-4 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <input type="text" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Name (optional)" className="w-40 px-4 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button onClick={inviteMember} disabled={inviting || !inviteEmail} className="btn-primary text-sm px-5 disabled:opacity-50">
                {inviting ? '...' : 'Invite'}
              </button>
            </div>
          </div>

          {/* Members list */}
          <div className="bg-white rounded-[12px] border border-surface-border overflow-hidden">
            <div className="px-6 py-4 border-b border-surface-border">
              <h3 className="text-lg font-semibold text-grey-15">Team Members ({data.members.length})</h3>
            </div>
            <div className="divide-y divide-surface-border">
              {data.members.map(m => (
                <div key={m.id} className="px-6 py-4 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-grey-15">{m.name || m.email}</div>
                    <div className="text-xs text-grey-40">{m.email}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <select
                      value={m.role}
                      onChange={(e) => updateRole(m.id, e.target.value)}
                      className="text-xs px-2 py-1 border border-surface-border rounded-[6px] text-grey-35"
                    >
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </select>
                    <span className="text-xs text-grey-50">{new Date(m.joinedAt).toLocaleDateString()}</span>
                    <button onClick={() => removeMember(m.id)} className="text-xs text-red-400 hover:text-red-600">Remove</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* EMAIL TAB */}
      {tab === 'email' && (
        <div className="bg-white rounded-[12px] border border-surface-border p-6 max-w-2xl">
          <h3 className="text-lg font-semibold text-grey-15 mb-4">Email Configuration</h3>
          <p className="text-sm text-grey-40 mb-4">Configure how automated emails appear to your candidates.</p>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-grey-20 mb-1.5">Sender Name</label>
              <input type="text" value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="e.g. Your Company Hiring Team" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <p className="text-xs text-grey-50 mt-1">Appears as the &quot;From&quot; name in candidate emails</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-grey-20 mb-1.5">Reply-To Email</label>
              <input type="email" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} placeholder="hiring@yourcompany.com" className="w-full px-4 py-3 border border-surface-border rounded-[8px] text-grey-15 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <p className="text-xs text-grey-50 mt-1">Candidate replies will go to this address</p>
            </div>
          </div>
          <div className="mt-6">
            <button onClick={saveSettings} disabled={saving} className="btn-primary disabled:opacity-50">
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
            </button>
          </div>
          <div className="mt-8 pt-6 border-t border-surface-border">
            <SenderVerificationCard />
          </div>
        </div>
      )}

      {/* PROVIDERS TAB */}
      {tab === 'providers' && (
        <div className="max-w-2xl space-y-4">
          <div className="bg-white rounded-[12px] border border-surface-border p-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-grey-15">Calendly</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">Connected via URL</span>
            </div>
            <p className="text-sm text-grey-40 mb-3">Scheduling links are configured in the Scheduling section. Each link uses your Calendly event URL.</p>
            <a href="/dashboard/scheduling" className="text-sm text-brand-500 hover:text-brand-600 font-medium">Go to Scheduling →</a>
          </div>

          <div className="bg-white rounded-[12px] border border-surface-border p-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-grey-15">SendGrid (Email)</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-brand-50 text-brand-600 font-medium">Platform-managed</span>
            </div>
            <p className="text-sm text-grey-40">Email delivery is managed at the platform level. Contact support to configure custom sender domains.</p>
          </div>

          <div className="bg-white rounded-[12px] border border-surface-border p-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-grey-15">Indeed</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-grey-40 font-medium">Coming Soon</span>
            </div>
            <p className="text-sm text-grey-40">Direct Indeed integration for automatic job posting and candidate sync. Available on Pro plans.</p>
          </div>

          <div className="bg-white rounded-[12px] border border-surface-border p-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-grey-15">SMS / WhatsApp</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-grey-40 font-medium">Coming Soon</span>
            </div>
            <p className="text-sm text-grey-40">Send SMS and WhatsApp notifications to candidates. Available on Enterprise plans.</p>
          </div>
        </div>
      )}

      {tab === 'integrations' && (
        <div className="space-y-4 max-w-2xl">
          <GoogleIntegrationCard />
          <CertnIntegrationCard />
        </div>
      )}
      </div>
    </div>
  )
}
