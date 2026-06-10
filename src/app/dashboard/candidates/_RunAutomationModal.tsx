'use client'

/**
 * Lightweight automation picker for the candidate drawer. Lists the active
 * rules attached to the candidate's current stage and lets the recruiter
 * fire each one individually. Goes through the same dispatchRule path the
 * real triggers use so multi-step rules queue correctly via QStash.
 */

import { useEffect, useState } from 'react'

interface MatchedRule {
  id: string
  name: string
  triggerType: string
  isActive: boolean
}

interface RunAutomationModalProps {
  candidateId: string
  stageId: string | null
  onClose: () => void
  onFired?: () => void
}

const TRIGGER_LABELS: Record<string, string> = {
  flow_passed: 'Flow passed',
  flow_completed: 'Flow completed',
  training_started: 'Training started',
  training_completed: 'Training completed',
  meeting_scheduled: 'Interview scheduled',
  meeting_started: 'Interview started',
  meeting_ended: 'Interview ended',
  meeting_no_show: 'Interview no-show',
  before_meeting: 'Before meeting',
  automation_completed: 'After automation',
}

export function RunAutomationModal({ candidateId, stageId, onClose, onFired }: RunAutomationModalProps) {
  const [rules, setRules] = useState<MatchedRule[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [perRule, setPerRule] = useState<Record<string, { firing?: boolean; result?: { ok: boolean; message: string } }>>({})

  useEffect(() => {
    if (!stageId) { setRules([]); return }
    let aborted = false
    fetch(`/api/candidates/${candidateId}/run-stage-automations?stageId=${encodeURIComponent(stageId)}`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}))
        if (aborted) return
        if (!r.ok) { setLoadError(data?.error || 'Failed to load rules'); setRules([]); return }
        setRules(Array.isArray(data.rules) ? data.rules : [])
      })
      .catch((err) => { if (!aborted) { setLoadError(err instanceof Error ? err.message : 'Failed to load rules'); setRules([]) } })
    return () => { aborted = true }
  }, [candidateId, stageId])

  const fire = async (ruleId: string) => {
    if (!stageId || perRule[ruleId]?.firing) return
    setPerRule((s) => ({ ...s, [ruleId]: { firing: true } }))
    try {
      const res = await fetch(`/api/candidates/${candidateId}/run-stage-automations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stageId, ruleId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setPerRule((s) => ({ ...s, [ruleId]: { firing: false, result: { ok: false, message: data?.error || 'Failed' } } }))
        return
      }
      const failed = (data.results || []).filter((r: { ok: boolean }) => !r.ok)
      if (failed.length > 0) {
        setPerRule((s) => ({ ...s, [ruleId]: { firing: false, result: { ok: false, message: failed[0]?.error || 'Failed' } } }))
      } else {
        setPerRule((s) => ({ ...s, [ruleId]: { firing: false, result: { ok: true, message: 'Fired' } } }))
        onFired?.()
      }
    } catch (err) {
      setPerRule((s) => ({ ...s, [ruleId]: { firing: false, result: { ok: false, message: err instanceof Error ? err.message : 'Failed' } } }))
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center z-[70] p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-[12px] shadow-2xl w-full max-w-[560px] p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-grey-15 mb-1">Run automation</h3>
        <p className="text-xs text-grey-40 mb-4">
          Active rules attached to this candidate&apos;s current stage. Each fires through the
          normal dispatch path (multi-step rules queue follow-ups via QStash).
        </p>
        {!stageId ? (
          <div className="text-[12px] text-grey-40">Candidate is not assigned to a pipeline stage yet.</div>
        ) : loadError ? (
          <div className="text-[12px] text-red-600">{loadError}</div>
        ) : rules === null ? (
          <div className="text-[12px] text-grey-40">Loading rules…</div>
        ) : rules.length === 0 ? (
          <div className="text-[12px] text-grey-40">No automation rules are attached to this stage.</div>
        ) : (
          <ul className="space-y-2 max-h-[50vh] overflow-y-auto">
            {rules.map((r) => {
              const s = perRule[r.id]
              return (
                <li key={r.id} className="flex items-center gap-2 border border-surface-border rounded-[8px] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink truncate">{r.name}</div>
                    <div className="text-[11px] text-grey-35">
                      Trigger: {TRIGGER_LABELS[r.triggerType] || r.triggerType}
                    </div>
                  </div>
                  {s?.result && (
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                      s.result.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}>{s.result.message}</span>
                  )}
                  <button
                    onClick={() => fire(r.id)}
                    disabled={!!s?.firing}
                    className="text-[11px] px-2.5 py-1 rounded-[6px] bg-brand-500 text-white hover:bg-brand-600 font-medium disabled:opacity-50"
                  >
                    {s?.firing ? 'Firing…' : s?.result?.ok ? 'Re-fire' : 'Fire'}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm px-4 py-2 rounded-[8px] text-grey-40 hover:text-grey-15">Close</button>
        </div>
      </div>
    </div>
  )
}
