'use client'

import { useEffect, useState } from 'react'
import { Button, Eyebrow } from '@/components/design'

interface ConfigRow {
  id: string
  name: string
  isDefault: boolean
  useBuiltInScheduler: boolean
  assigned: boolean
}

interface Props {
  memberId: string
  memberLabel: string
  // Passed when the modal is opened right after invite — we surface a small
  // "invite sent" heading and a "Skip for now" secondary button instead of
  // "Cancel". Post-hoc edits from the members list get the normal treatment.
  justInvited?: boolean
  onClose: () => void
}

export function AssignConfigsModal({ memberId, memberLabel, justInvited, onClose }: Props) {
  const [rows, setRows] = useState<ConfigRow[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`/api/workspace/members/${memberId}/scheduling-configs`)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = (await r.json()) as { configs: ConfigRow[] }
        if (cancelled) return
        setRows(d.configs)
        setSelected(new Set(d.configs.filter((c) => c.assigned).map((c) => c.id)))
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message || 'Failed to load calendars')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [memberId])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const r = await fetch(`/api/workspace/members/${memberId}/scheduling-configs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configIds: Array.from(selected) }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j?.error || `HTTP ${r.status}`)
      }
      onClose()
    } catch (err) {
      setSaveError((err as Error).message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const hasConfigs = rows !== null && rows.length > 0

  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl border border-surface-border shadow-raised p-7 w-full max-w-[520px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <Eyebrow size="xs" className="mb-1.5">
          {justInvited ? 'Invite sent' : 'Team member'}
        </Eyebrow>
        <h2 className="text-[20px] font-semibold text-ink mb-1">Assign calendars</h2>
        <p className="text-[13px] text-grey-40 mb-4">
          Pick the scheduling links {memberLabel} should host. They'll be added to every calendar invite
          for meetings booked through the selected links, and get confirm/cancel notifications.
          {justInvited && ' You can also do this later from the team list.'}
        </p>

        {loadError && (
          <div className="text-[12px] text-[color:var(--danger-fg)] border border-[color:var(--danger-fg)]/30 rounded-[8px] px-3 py-2 mb-3">
            {loadError}
          </div>
        )}

        {rows === null && !loadError && (
          <div className="text-[13px] text-grey-40 py-6 text-center">Loading calendars…</div>
        )}

        {rows !== null && !hasConfigs && (
          <div className="text-[13px] text-grey-40 border border-dashed border-surface-border rounded-[8px] px-3 py-4 text-center">
            No scheduling links yet.
            {' '}
            <a href="/dashboard/scheduling" className="underline text-primary">
              Create one
            </a>
            {' '}first, then come back here.
          </div>
        )}

        {hasConfigs && (
          <div className="space-y-1 max-h-[320px] overflow-y-auto rounded-[8px] border border-surface-border p-2">
            {rows!.map((c) => {
              const checked = selected.has(c.id)
              return (
                <label
                  key={c.id}
                  className={`flex items-start gap-2 px-2 py-1.5 rounded-[6px] cursor-pointer ${
                    checked ? 'bg-brand-50' : 'hover:bg-surface-light'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={checked}
                    onChange={() => toggle(c.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-ink truncate">{c.name}</div>
                    <div className="text-[11px] text-grey-40 truncate">
                      {c.useBuiltInScheduler ? 'Built-in scheduler' : 'External link'}
                      {c.isDefault && ' · Default'}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
        )}

        {saveError && (
          <div className="mt-3 text-[12px] text-[color:var(--danger-fg)]">{saveError}</div>
        )}

        <div className="flex gap-2 mt-6 justify-end">
          <Button variant="secondary" onClick={onClose}>
            {justInvited ? 'Skip for now' : 'Cancel'}
          </Button>
          <Button onClick={save} disabled={saving || rows === null || !hasConfigs}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
