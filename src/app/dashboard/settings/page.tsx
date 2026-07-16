'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { GoogleIntegrationCard } from './_GoogleIntegrationCard'
import { CertnIntegrationCard } from './_CertnIntegrationCard'
import { TelegramIntegrationCard } from './_TelegramIntegrationCard'
import { SenderVerificationCard } from './_SenderVerificationCard'
import { AssignConfigsModal } from './_AssignConfigsModal'
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
  const { data: session } = useSession()
  // Role from the JWT session. Owner + admin get privileged team actions
  // (invite, change role, remove, resend). Owner-only gets Delete Workspace.
  // These flags gate UI visibility only — the API is the authoritative
  // check, so a member with a tampered client still can't invoke the
  // privileged endpoints.
  const myRole = ((session?.user as { role?: string } | undefined)?.role) || 'member'
  const isSuperAdmin = !!((session?.user as { isSuperAdmin?: boolean } | undefined)?.isSuperAdmin)
  const isAdminOrOwner = isSuperAdmin || myRole === 'owner' || myRole === 'admin'
  const isOwner = isSuperAdmin || myRole === 'owner'
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

  // Assign-calendars modal — opens automatically after a successful invite
  // (justInvited=true) so owners don't forget, and can be re-opened from
  // each member row by admins/owners.
  const [assignFor, setAssignFor] = useState<{ id: string; label: string; justInvited: boolean } | null>(null)

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
    if (r.ok) {
      const body = await r.json().catch(() => ({})) as { memberId?: string; email?: string }
      const label = inviteName || body.email || inviteEmail
      setInviteEmail(''); setInviteName('')
      fetchSettings()
      if (body.memberId) setAssignFor({ id: body.memberId, label, justInvited: true })
    } else {
      const err = await r.json(); alert(err.error || 'Failed to invite')
    }
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

  const [resendingId, setResendingId] = useState<string | null>(null)
  const resendInvite = async (memberId: string, email: string) => {
    setResendingId(memberId)
    try {
      const r = await fetch(`/api/workspace/members/${memberId}/resend-invite`, { method: 'POST' })
      if (r.ok) {
        alert(`Invite email re-sent to ${email}.`)
      } else {
        const err = await r.json().catch(() => ({}))
        alert(err.message || err.error || 'Failed to resend invite')
      }
    } finally {
      setResendingId(null)
    }
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
          {/* Invite — only admins + owners see this. Members see a hint. */}
          {isAdminOrOwner ? (
            <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
              <h3 className="text-lg font-semibold text-grey-15 mb-4">Invite Team Member</h3>
              <div className="flex gap-3">
                <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="Email address" className="flex-1 px-4 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                <input type="text" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Name (optional)" className="w-40 px-4 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="px-3 py-2.5 border border-surface-border rounded-[8px] text-grey-15 text-sm">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  {isOwner && <option value="owner">Owner</option>}
                </select>
                <button onClick={inviteMember} disabled={inviting || !inviteEmail} className="btn-primary text-sm px-5 disabled:opacity-50">
                  {inviting ? '...' : 'Invite'}
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-surface-light rounded-[12px] border border-surface-border p-4 mb-6 text-[13px] text-grey-40">
              Only workspace admins and owners can invite team members or change roles.
            </div>
          )}

          {/* Role capabilities — the full matrix (what each role can and
              can't do), grouped by area. Reflects what's actually enforced
              in code today; NOT aspirational. */}
          <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
            <h3 className="text-sm font-semibold text-grey-15 mb-1">What each role can do</h3>
            <p className="text-xs text-grey-40 mb-4">
              Everything a member can do, an admin and owner can do too. Admins add team + moderation powers; owners add billing and workspace deletion on top of that.
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-border text-left">
                  <th className="py-2 pr-2 font-medium text-grey-15">Capability</th>
                  <th className="py-2 px-2 font-medium text-grey-40 text-center w-20">Member</th>
                  <th className="py-2 px-2 font-medium text-grey-40 text-center w-20">Admin</th>
                  <th className="py-2 pl-2 font-medium text-grey-40 text-center w-20">Owner</th>
                </tr>
              </thead>
              <tbody>
                {([
                  // Standard workspace features — everyone including member.
                  { group: 'Candidates & pipeline', label: 'View and search candidates', member: true, admin: true, owner: true },
                  { group: 'Candidates & pipeline', label: 'Edit candidate details, status, disposition', member: true, admin: true, owner: true },
                  { group: 'Candidates & pipeline', label: 'Delete a candidate', member: true, admin: true, owner: true },
                  { group: 'Candidates & pipeline', label: 'Add notes on a candidate (own notes editable)', member: true, admin: true, owner: true },
                  { group: 'Candidates & pipeline', label: 'Send email or SMS to a candidate (incl. bulk)', member: true, admin: true, owner: true },
                  { group: 'Candidates & pipeline', label: 'Manage pipelines and stage transitions', member: true, admin: true, owner: true },
                  { group: 'Interviews', label: 'Schedule / reschedule / cancel a Meet interview', member: true, admin: true, owner: true },
                  { group: 'Interviews', label: 'Start an instant Meet interview', member: true, admin: true, owner: true },
                  { group: 'Interviews', label: 'Manage host assignments on a meeting', member: true, admin: true, owner: true },
                  { group: 'Interviews', label: 'View recordings, transcripts, Gemini notes', member: true, admin: true, owner: true },
                  { group: 'Interviews', label: 'Mark a meeting as no-show', member: true, admin: true, owner: true },
                  { group: 'Content', label: 'Create / edit / delete flows, steps, videos', member: true, admin: true, owner: true },
                  { group: 'Content', label: 'Create / edit / delete trainings + quizzes', member: true, admin: true, owner: true },
                  { group: 'Content', label: 'Create / edit / delete automations', member: true, admin: true, owner: true },
                  { group: 'Content', label: 'Run automations against a candidate', member: true, admin: true, owner: true },
                  { group: 'Content', label: 'Create / edit / delete email + SMS templates', member: true, admin: true, owner: true },
                  { group: 'Content', label: 'Create / edit / delete scheduling / booking pages', member: true, admin: true, owner: true },
                  { group: 'Content', label: 'Assign default team members on a scheduling page', member: true, admin: true, owner: true },
                  { group: 'Content', label: 'Manage AI Calls agents + candidate links', member: true, admin: true, owner: true },
                  { group: 'Content', label: 'Order & view Certn background checks', member: true, admin: true, owner: true },
                  { group: 'Content', label: 'Publish & manage Telegram ads', member: true, admin: true, owner: true },
                  { group: 'Content', label: 'View analytics', member: true, admin: true, owner: true },
                  { group: 'Workspace config', label: 'Edit workspace details (name, timezone, sender)', member: true, admin: true, owner: true },
                  { group: 'Workspace config', label: 'Connect / disconnect Google, Certn, Telegram', member: true, admin: true, owner: true },
                  // Admin + Owner (member locked out).
                  { group: 'Team management', label: 'Invite team members & resend invites', member: false, admin: true, owner: true },
                  { group: 'Team management', label: "Change other members' roles (except owner)", member: false, admin: true, owner: true },
                  { group: 'Team management', label: 'Remove team members (except owners)', member: false, admin: true, owner: true },
                  { group: 'Team management', label: "Edit or delete another user's notes on a candidate", member: false, admin: true, owner: true },
                  { group: 'Team management', label: 'Force re-run pipeline-stage automations for a candidate', member: false, admin: true, owner: true },
                  // Owner only.
                  { group: 'Owner-only', label: 'Manage subscription & billing', member: false, admin: false, owner: true },
                  { group: 'Owner-only', label: "Promote to Owner or change an Owner's role", member: false, admin: false, owner: true },
                  { group: 'Owner-only', label: 'Remove another Owner', member: false, admin: false, owner: true },
                  { group: 'Owner-only', label: 'Delete the workspace (irreversible)', member: false, admin: false, owner: true },
                ]).reduce((acc: React.ReactNode[], row, i, arr) => {
                  // Insert a group header row when the group name changes.
                  const prevGroup = i > 0 ? arr[i - 1].group : null
                  if (row.group !== prevGroup) {
                    acc.push(
                      <tr key={`h-${row.group}`}>
                        <td colSpan={4} className="pt-4 pb-1 pr-2 font-mono text-[10px] uppercase text-grey-40" style={{ letterSpacing: '0.08em' }}>
                          {row.group}
                        </td>
                      </tr>
                    )
                  }
                  acc.push(
                    <tr key={row.label} className="border-b border-surface-border last:border-0">
                      <td className="py-2 pr-2 text-grey-15">{row.label}</td>
                      <td className="py-2 px-2 text-center">
                        {row.member ? <span className="text-green-600">✓</span> : <span className="text-grey-40">—</span>}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {row.admin ? <span className="text-green-600">✓</span> : <span className="text-grey-40">—</span>}
                      </td>
                      <td className="py-2 pl-2 text-center">
                        {row.owner ? <span className="text-green-600">✓</span> : <span className="text-grey-40">—</span>}
                      </td>
                    </tr>
                  )
                  return acc
                }, [])}
              </tbody>
            </table>
          </div>

          {/* Members list */}
          <div className="bg-white rounded-[12px] border border-surface-border overflow-hidden">
            <div className="px-6 py-4 border-b border-surface-border">
              <h3 className="text-lg font-semibold text-grey-15">Team Members ({data.members.length})</h3>
            </div>
            <div className="divide-y divide-surface-border">
              {data.members.map(m => {
                // Admins can't touch an existing owner (change role, remove).
                // Only owners (or super admins) can. Members see role as a
                // read-only badge with no action buttons.
                const canEditThisMember = isAdminOrOwner && (isOwner || m.role !== 'owner')
                const isSelf = m.userId === (session?.user as { id?: string } | undefined)?.id
                return (
                <div key={m.id} className="px-6 py-4 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-grey-15">{m.name || m.email}</div>
                    <div className="text-xs text-grey-40">{m.email}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    {canEditThisMember && !isSelf ? (
                      <select
                        value={m.role}
                        onChange={(e) => updateRole(m.id, e.target.value)}
                        className="text-xs px-2 py-1 border border-surface-border rounded-[6px] text-grey-35"
                      >
                        {isOwner && <option value="owner">Owner</option>}
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </select>
                    ) : (
                      <span className="text-xs px-2 py-1 rounded-[6px] bg-surface-light text-grey-35 capitalize">{m.role}</span>
                    )}
                    <span className="text-xs text-grey-50">{new Date(m.joinedAt).toLocaleDateString()}</span>
                    {isAdminOrOwner && (
                      <button
                        onClick={() => setAssignFor({ id: m.id, label: m.name || m.email, justInvited: false })}
                        className="text-xs text-grey-40 hover:text-grey-15"
                        title="Pick which scheduling links this member hosts. They'll be on the invite + get confirm/cancel notifications."
                      >
                        Calendars
                      </button>
                    )}
                    {isAdminOrOwner && (
                      <button
                        onClick={() => resendInvite(m.id, m.email)}
                        disabled={resendingId === m.id}
                        className="text-xs text-grey-40 hover:text-grey-15 disabled:opacity-50"
                        title="Resend the invite email with a fresh set-password link (7-day expiry)"
                      >
                        {resendingId === m.id ? 'Sending…' : 'Resend invite'}
                      </button>
                    )}
                    {canEditThisMember && !isSelf && (
                      <button onClick={() => removeMember(m.id)} className="text-xs text-red-400 hover:text-red-600">Remove</button>
                    )}
                  </div>
                </div>
              )})}
            </div>
          </div>

          {/* Danger zone — Delete Workspace. Owner-only. Type-to-confirm
              guard so a stray click doesn't nuke the workspace and every
              candidate/flow/meeting under it. */}
          {isOwner && (
            <DangerZone workspaceId={data.id} workspaceName={data.name} />
          )}
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
          <TelegramIntegrationCard />
        </div>
      )}
      </div>

      {assignFor && (
        <AssignConfigsModal
          memberId={assignFor.id}
          memberLabel={assignFor.label}
          justInvited={assignFor.justInvited}
          onClose={() => setAssignFor(null)}
        />
      )}
    </div>
  )
}

/**
 * Delete-workspace section, gated to owner. Requires the user to type the
 * workspace name to confirm; server re-validates. On success, signs out
 * (the JWT session's workspaceId no longer exists so every subsequent
 * request would 401 anyway).
 */
function DangerZone({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const matches = confirmName.trim().toLowerCase() === workspaceName.toLowerCase()

  const doDelete = async () => {
    if (!matches) return
    if (!confirm(`Permanently delete "${workspaceName}"? This deletes all candidates, flows, meetings, integrations, and team memberships in this workspace. There is no undo.`)) return
    setDeleting(true); setError(null)
    try {
      const res = await fetch('/api/workspace', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName: confirmName.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body?.message || body?.error || 'Failed to delete workspace')
        return
      }
      // Session's workspaceId is now dangling — sign the user out cleanly.
      const { signOut } = await import('next-auth/react')
      await signOut({ callbackUrl: '/login' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="mt-8 bg-white rounded-[12px] border-2 border-red-200 p-6">
      <h3 className="text-sm font-semibold text-red-700 mb-1">Danger zone — Delete workspace</h3>
      <p className="text-xs text-grey-40 mb-4">
        Deletes <strong>{workspaceName}</strong> along with every candidate, flow, training, meeting, automation, integration, and team membership scoped to it. Cannot be undone. Only the workspace owner can do this.
      </p>
      <label className="block text-xs text-grey-15 mb-1.5">
        Type <span className="font-mono font-semibold">{workspaceName}</span> to confirm:
      </label>
      <input
        type="text"
        value={confirmName}
        onChange={(e) => setConfirmName(e.target.value)}
        placeholder={workspaceName}
        className="w-full px-3 py-2 border border-surface-border rounded-[8px] text-grey-15 text-sm focus:outline-none focus:ring-2 focus:ring-red-300 mb-3"
      />
      {error && <div className="mb-3 text-xs text-red-700">{error}</div>}
      <button
        onClick={doDelete}
        disabled={!matches || deleting}
        className="text-sm px-4 py-2 rounded-[8px] bg-red-600 text-white font-medium hover:bg-red-700 disabled:bg-grey-200 disabled:text-grey-40 disabled:cursor-not-allowed"
      >
        {deleting ? 'Deleting…' : `Delete "${workspaceName}"`}
      </button>
      {/* Preserved for future reference — the workspace id is opaque to
          the recruiter but useful in a support ticket if the delete fails. */}
      <div className="mt-2 text-[10px] text-grey-50 font-mono">workspace_id: {workspaceId}</div>
    </div>
  )
}
