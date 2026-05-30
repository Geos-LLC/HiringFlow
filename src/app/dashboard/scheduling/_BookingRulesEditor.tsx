'use client'

/**
 * Inline editor for SchedulingConfig.bookingRules.
 * Lives inside the create/edit modal on the Scheduling page when
 * `useBuiltInScheduler` is on. Keeps its own local state and emits the
 * validated shape via onChange.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultBookingRules, type BookingRules, type Weekday, type WorkingHourRange } from '@/lib/scheduling/booking-rules'

interface Props {
  value: BookingRules | null
  onChange: (next: BookingRules) => void
  /** When editing an existing config, pass its id so the preview panel
   * resolves the right calendarId and excludes this config from the
   * "other workspace configs" busy set. Omit for new configs. */
  configId?: string
}

interface PreviewDay {
  date: string
  weekday: Weekday
  workingRanges: WorkingHourRange[]
  busyIntervals: { start: string; end: string }[]
  slotCount: number
  reason: 'off' | 'window_too_short' | 'min_notice' | 'past_max_days' | 'calendar_conflict' | 'available' | 'unknown'
}

interface PreviewResponse {
  days: PreviewDay[]
  totalSlots: number
  recruiterTimezone: string
  previewDayCap: number
  truncated: boolean
  calendarError: string | null
}

const WEEKDAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
]

export function BookingRulesEditor({ value, onChange, configId }: Props) {
  const [rules, setRules] = useState<BookingRules>(value ?? defaultBookingRules())

  useEffect(() => {
    setRules(value ?? defaultBookingRules())
  }, [value])

  // Live "what does the candidate actually see?" panel. Calls the preview
  // endpoint on every rules change (debounced) so the recruiter understands
  // *why* a day is empty without saving + opening the booking page.
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)
  const rulesKey = useMemo(() => JSON.stringify(rules), [rules])

  const fetchPreview = async (bustCache: boolean) => {
    if (previewAbortRef.current) previewAbortRef.current.abort()
    const ac = new AbortController()
    previewAbortRef.current = ac
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const r = await fetch('/api/scheduling/preview-conflicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingRules: rules, configId, bustCache }),
        signal: ac.signal,
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setPreviewError(d.message || d.error || 'Preview failed')
        setPreview(null)
      } else {
        setPreview(d as PreviewResponse)
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setPreviewError((err as Error).message)
      setPreview(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  useEffect(() => {
    const handle = setTimeout(() => { fetchPreview(false) }, 350)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesKey, configId])

  const update = (patch: Partial<BookingRules>) => {
    const next = { ...rules, ...patch }
    setRules(next)
    onChange(next)
  }

  const setDayRange = (day: Weekday, idx: number, key: 'start' | 'end', val: string) => {
    const ranges = [...(rules.workingHours[day] || [])]
    ranges[idx] = { ...ranges[idx], [key]: val }
    update({ workingHours: { ...rules.workingHours, [day]: ranges } })
  }
  const toggleDay = (day: Weekday) => {
    const cur = rules.workingHours[day]
    const next = cur.length === 0 ? [{ start: '09:00', end: '17:00' }] : []
    update({ workingHours: { ...rules.workingHours, [day]: next } })
  }
  const addRange = (day: Weekday) => {
    const cur = rules.workingHours[day]
    const last = cur[cur.length - 1]
    const startDefault = last ? last.end : '09:00'
    update({
      workingHours: {
        ...rules.workingHours,
        [day]: [...cur, { start: startDefault, end: addHours(startDefault, 1) }],
      },
    })
  }
  const removeRange = (day: Weekday, idx: number) => {
    const cur = rules.workingHours[day].filter((_, i) => i !== idx)
    update({ workingHours: { ...rules.workingHours, [day]: cur } })
  }

  // "Copy this day to every weekday" shortcut. Recruiters complained about
  // editing 7 day rows individually when their schedule is the same Mon–Sun.
  // Source day's range list is cloned into every other day (including ones
  // currently toggled off — they get re-enabled).
  const copyDayToAll = (source: Weekday) => {
    const ranges = rules.workingHours[source]
    if (ranges.length === 0) return
    const cloned: Record<Weekday, typeof ranges> = {} as Record<Weekday, typeof ranges>
    for (const { key } of WEEKDAYS) {
      cloned[key] = ranges.map((r) => ({ ...r }))
    }
    update({ workingHours: cloned })
  }

  return (
    <div className="space-y-4 border border-surface-border rounded-[10px] p-4 bg-surface-light/40">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <NumberField
          label="Duration (min)"
          tooltip="How long each interview slot is. e.g. 30 means a candidate booking 9:00 takes the recruiter from 9:00 to 9:30."
          value={rules.durationMinutes} min={5} max={480}
          onChange={(v) => update({ durationMinutes: v })} />
        <NumberField
          label="Slot interval (min)"
          tooltip="How often a new slot starts on the picker grid. 30 → 9:00, 9:30, 10:00... Set this equal to Duration for back-to-back, no-overlap slots."
          value={rules.slotIntervalMinutes} min={5} max={480}
          onChange={(v) => update({ slotIntervalMinutes: v })} />
        <NumberField
          label="Buffer before (min)"
          tooltip="Padding the candidate must leave BEFORE any existing busy event. e.g. busy 14:00–15:00 with buffer-before 30 → no slot can end after 13:30."
          value={rules.bufferBeforeMinutes} min={0} max={480}
          onChange={(v) => update({ bufferBeforeMinutes: v })} />
        <NumberField
          label="Buffer after (min)"
          tooltip="Padding AFTER any busy event before another slot can start. e.g. busy 14:00–15:00 with buffer-after 15 → no slot can start before 15:15."
          value={rules.bufferAfterMinutes} min={0} max={480}
          onChange={(v) => update({ bufferAfterMinutes: v })} />
        <NumberField
          label="Min notice (hours)"
          tooltip="How far in advance candidates must book. e.g. 2 means no slots within the next 2 hours, so candidates can't book a meeting starting in 5 minutes."
          value={rules.minNoticeHours} min={0} max={720}
          onChange={(v) => update({ minNoticeHours: v })} />
        <NumberField
          label="Max days out"
          tooltip="Furthest a candidate can book ahead. 14 = picker only shows the next 14 days."
          value={rules.maxDaysOut} min={1} max={365}
          onChange={(v) => update({ maxDaysOut: v })} />
      </div>

      <div>
        <div className="eyebrow mb-2 flex items-center gap-1.5">
          Working hours (workspace timezone)
          <InfoIcon tooltip="The window each weekday when slots can be generated, in your workspace's timezone. Click a day name to toggle it off entirely. Add multiple ranges for split days (e.g. 09:00–12:00 and 13:00–17:00 to skip lunch)." />
        </div>
        <div className="space-y-1.5">
          {WEEKDAYS.map(({ key, label }) => {
            const ranges = rules.workingHours[key]
            const enabled = ranges.length > 0
            return (
              <div key={key} className="flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => toggleDay(key)}
                  className="w-12 text-left text-[12px] font-medium text-ink shrink-0 pt-1"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={`w-3 h-3 rounded-sm border ${enabled ? 'bg-[color:var(--brand-primary)] border-[color:var(--brand-primary)]' : 'bg-white border-surface-border'}`}
                    />
                    {label}
                  </span>
                </button>
                <div className="flex-1 space-y-1.5">
                  {ranges.length === 0 && (
                    <div className="text-[12px] text-grey-50 pt-1">Off</div>
                  )}
                  {ranges.map((r, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        type="time"
                        value={r.start}
                        onChange={(e) => setDayRange(key, idx, 'start', e.target.value)}
                        className="px-2 py-1 border border-surface-border rounded-[6px] text-[12px] text-ink"
                      />
                      <span className="text-grey-50 text-[12px]">–</span>
                      <input
                        type="time"
                        value={r.end}
                        onChange={(e) => setDayRange(key, idx, 'end', e.target.value)}
                        className="px-2 py-1 border border-surface-border rounded-[6px] text-[12px] text-ink"
                      />
                      <button
                        type="button"
                        onClick={() => removeRange(key, idx)}
                        className="text-[11px] text-grey-50 hover:text-[color:var(--danger-fg)]"
                      >
                        remove
                      </button>
                    </div>
                  ))}
                  {enabled && (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => addRange(key)}
                        className="text-[11px] text-grey-35 hover:text-ink"
                      >
                        + add range
                      </button>
                      <button
                        type="button"
                        onClick={() => copyDayToAll(key)}
                        title={`Copy ${label}'s hours to every weekday`}
                        className="text-[11px] text-grey-35 hover:text-[color:var(--brand-primary)]"
                      >
                        copy to all days
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <PreviewPanel
        preview={preview}
        loading={previewLoading}
        error={previewError}
        onRefresh={() => fetchPreview(true)}
      />
    </div>
  )
}

function PreviewPanel({ preview, loading, error, onRefresh }: {
  preview: PreviewResponse | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  return (
    <div className="border-t border-surface-divider pt-4">
      <div className="eyebrow mb-2 flex items-center gap-1.5">
        Preview — next {preview ? Math.min(preview.previewDayCap, preview.days.length || preview.previewDayCap) : 14} days
        <InfoIcon tooltip="Live check against your connected Google Calendar. Shows how many slots candidates will see on each day and which existing events are blocking empty days." />
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="ml-auto text-[11px] text-grey-35 hover:text-[color:var(--brand-primary)] disabled:opacity-50 normal-case font-normal tracking-normal"
          title="Re-query Google Calendar, bypassing the 60s cache"
        >
          {loading ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      {error && (
        <div className="text-[12px] text-[color:var(--danger-fg)] mb-2">
          {error}
        </div>
      )}

      {preview?.calendarError && (
        <div className="text-[12px] text-[color:var(--warn-fg,#b45309)] mb-2">
          Could not read your Google Calendar — preview shows the rule window only.
        </div>
      )}

      {preview && (
        <>
          <div className="text-[12px] text-grey-50 mb-2">
            <span className="font-mono text-ink">{preview.totalSlots}</span> total slot{preview.totalSlots === 1 ? '' : 's'} across the next {preview.days.length} working day{preview.days.length === 1 ? '' : 's'} ({preview.recruiterTimezone})
            {preview.truncated && <span className="ml-1">— preview capped at {preview.previewDayCap} days</span>}
          </div>

          {preview.days.length === 0 ? (
            <div className="text-[12px] text-grey-50">No working days in the preview window.</div>
          ) : (
            <div className="space-y-1">
              {preview.days.map((d) => (
                <PreviewDayRow key={d.date} day={d} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function PreviewDayRow({ day }: { day: PreviewDay }) {
  const dateLabel = formatDateLabel(day.date)
  const ok = day.slotCount > 0
  const reasonText = reasonLabel(day.reason, day.busyIntervals.length)

  return (
    <div className="flex items-start gap-3 text-[12px] py-1 border-b border-surface-divider/40 last:border-0">
      <div className="w-24 shrink-0 font-mono text-grey-50">{dateLabel}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`font-mono ${ok ? 'text-[color:var(--success-fg,#16803c)]' : 'text-[color:var(--danger-fg)]'}`}
          >
            {day.slotCount} slot{day.slotCount === 1 ? '' : 's'}
          </span>
          {!ok && reasonText && (
            <span className="text-grey-50 normal-case">— {reasonText}</span>
          )}
          <span className="text-grey-50 font-mono text-[11px]">
            {day.workingRanges.map((r) => `${r.start}–${r.end}`).join(', ')}
          </span>
        </div>
        {day.busyIntervals.length > 0 && (
          <div className="text-[11px] text-grey-50 mt-0.5">
            Calendar busy: {day.busyIntervals.map((b) => `${b.start}–${b.end}`).join(', ')}
          </div>
        )}
      </div>
    </div>
  )
}

function reasonLabel(reason: PreviewDay['reason'], busyCount: number): string {
  switch (reason) {
    case 'window_too_short':
      return 'working window is shorter than meeting duration + buffers'
    case 'min_notice':
      return 'blocked by minimum-notice setting'
    case 'past_max_days':
      return 'beyond max-days-out window'
    case 'calendar_conflict':
      return busyCount === 1 ? 'calendar event blocks the window' : 'calendar events block the window'
    case 'unknown':
      return 'no fitting slot'
    case 'available':
      return ''
    case 'off':
      return ''
    default:
      return ''
  }
}

function formatDateLabel(yyyymmdd: string): string {
  // "2026-06-01" → "Mon Jun 1". Built locally so it stays in the workspace
  // tz interpretation the server already used. We treat the date string as
  // a calendar date (no tz conversion) — Date.UTC + UTC getters keep it
  // unambiguous across the user's browser tz.
  const [y, m, d] = yyyymmdd.split('-').map(Number)
  const utc = new Date(Date.UTC(y, m - 1, d))
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][utc.getUTCDay()]
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][utc.getUTCMonth()]
  return `${wd} ${mon} ${utc.getUTCDate()}`
}

function NumberField({ label, tooltip, value, min, max, onChange }: { label: string; tooltip?: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="eyebrow block mb-1 flex items-center gap-1">
        {label}
        {tooltip && <InfoIcon tooltip={tooltip} />}
      </span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10)
          if (Number.isFinite(n)) onChange(n)
        }}
        className="w-full px-2 py-1.5 border border-surface-border rounded-[6px] text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
      />
    </label>
  )
}

function InfoIcon({ tooltip }: { tooltip: string }) {
  return (
    <span
      className="relative inline-flex items-center group cursor-help align-middle"
      tabIndex={0}
      role="img"
      aria-label="Help"
    >
      <svg
        className="w-3.5 h-3.5 text-grey-50 hover:text-[color:var(--brand-primary)] transition-colors"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8h.01M11 12h1v4h1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span
        className="invisible group-hover:visible group-focus:visible opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-64 px-3 py-2 rounded-md bg-[#262626] text-white text-[12px] leading-snug normal-case font-normal tracking-normal shadow-lg pointer-events-none"
        style={{ letterSpacing: 'normal' }}
      >
        {tooltip}
        <span className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-[5px] border-transparent border-t-[#262626]" />
      </span>
    </span>
  )
}

function addHours(hhmm: string, h: number): string {
  const [hh, mm] = hhmm.split(':').map(Number)
  const total = (hh * 60 + mm) + h * 60
  const newH = Math.min(23, Math.floor(total / 60))
  const newM = total % 60
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`
}
