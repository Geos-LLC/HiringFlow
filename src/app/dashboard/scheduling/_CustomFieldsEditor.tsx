'use client'

/**
 * Custom questions editor for the built-in booking form. Recruiter adds/
 * edits rows; each row is { id, label, type, required, options? }. Ids are
 * auto-generated on add so the recruiter never sees them, but they persist
 * across saves so answers on existing meetings stay bound to the same field
 * even after the label is renamed.
 */

import { useState } from 'react'
import type { CustomField, CustomFieldType } from '@/lib/scheduling/custom-fields'

interface Props {
  value: CustomField[]
  onChange: (fields: CustomField[]) => void
}

const TYPE_OPTIONS: { value: CustomFieldType; label: string }[] = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'radio', label: 'Single choice' },
]

function makeId(): string {
  // Short, url-safe, no leaking count.
  return 'f_' + Math.random().toString(36).slice(2, 10)
}

export function CustomFieldsEditor({ value, onChange }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const patch = (id: string, changes: Partial<CustomField>) => {
    onChange(value.map((f) => (f.id === id ? { ...f, ...changes } : f)))
  }
  const remove = (id: string) => onChange(value.filter((f) => f.id !== id))
  const move = (id: string, dir: -1 | 1) => {
    const idx = value.findIndex((f) => f.id === id)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= value.length) return
    const next = [...value]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onChange(next)
  }
  const add = () => {
    const nf: CustomField = { id: makeId(), label: '', type: 'text', required: false }
    onChange([...value, nf])
  }
  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <div className="text-[12px] text-grey-40 border border-dashed border-surface-border rounded-[8px] px-3 py-3 text-center">
          No custom questions yet.
        </div>
      )}
      {value.map((field, idx) => {
        const isCollapsed = collapsed.has(field.id)
        return (
          <div key={field.id} className="rounded-[8px] border border-surface-border bg-white">
            <div className="flex items-center gap-2 px-2.5 py-2 border-b border-surface-divider">
              <button
                type="button"
                onClick={() => toggleCollapsed(field.id)}
                className="text-grey-40 hover:text-ink text-[12px] w-4"
                title={isCollapsed ? 'Expand' : 'Collapse'}
              >
                {isCollapsed ? '▸' : '▾'}
              </button>
              <div className="flex-1 text-[12px] text-ink truncate">
                {field.label || <span className="text-grey-40">Untitled question</span>}
                <span className="ml-2 font-mono text-[10px] text-grey-40 uppercase">{field.type}</span>
                {field.required && (
                  <span className="ml-1 font-mono text-[9px] uppercase text-red-500">req</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => move(field.id, -1)}
                disabled={idx === 0}
                className="text-[11px] text-grey-40 hover:text-ink disabled:opacity-30 px-1"
                title="Move up"
              >↑</button>
              <button
                type="button"
                onClick={() => move(field.id, 1)}
                disabled={idx === value.length - 1}
                className="text-[11px] text-grey-40 hover:text-ink disabled:opacity-30 px-1"
                title="Move down"
              >↓</button>
              <button
                type="button"
                onClick={() => remove(field.id)}
                className="text-[11px] text-[color:var(--danger-fg)] hover:underline px-1"
                title="Remove"
              >Remove</button>
            </div>
            {!isCollapsed && (
              <div className="p-3 space-y-2.5">
                <div>
                  <label className="text-[11px] text-grey-40 block mb-1">Question</label>
                  <input
                    type="text"
                    value={field.label}
                    onChange={(e) => patch(field.id, { label: e.target.value })}
                    placeholder="e.g. What role are you applying for?"
                    className="w-full px-2.5 py-1.5 border border-surface-border rounded-[8px] text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                  />
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <label className="text-[11px] text-grey-40 block mb-1">Field type</label>
                    <select
                      value={field.type}
                      onChange={(e) => {
                        const nextType = e.target.value as CustomFieldType
                        const changes: Partial<CustomField> = { type: nextType }
                        if (nextType === 'radio' && (!field.options || field.options.length === 0)) {
                          changes.options = ['Option 1', 'Option 2']
                        }
                        if (nextType !== 'radio') {
                          changes.options = undefined
                        }
                        patch(field.id, changes)
                      }}
                      className="w-full px-2.5 py-1.5 border border-surface-border rounded-[8px] text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    >
                      {TYPE_OPTIONS.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <label className="flex items-center gap-1.5 text-[12px] text-ink cursor-pointer pt-4">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(e) => patch(field.id, { required: e.target.checked })}
                      className="accent-[#FF9500]"
                    />
                    Required
                  </label>
                </div>
                {field.type === 'radio' && (
                  <div>
                    <label className="text-[11px] text-grey-40 block mb-1">Options (one per line)</label>
                    <textarea
                      rows={Math.max(2, (field.options || []).length)}
                      value={(field.options || []).join('\n')}
                      onChange={(e) => {
                        const opts = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)
                        patch(field.id, { options: opts })
                      }}
                      placeholder={'Option 1\nOption 2'}
                      className="w-full px-2.5 py-1.5 border border-surface-border rounded-[8px] text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    />
                    {(field.options || []).length < 2 && (
                      <div className="text-[11px] text-[color:var(--danger-fg)] mt-1">
                        Add at least 2 options.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
      <button
        type="button"
        onClick={add}
        className="text-[12px] text-brand-500 hover:text-brand-600 font-medium"
      >
        + Add question
      </button>
    </div>
  )
}
