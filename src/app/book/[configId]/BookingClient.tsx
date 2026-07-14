'use client'

import { useEffect, useMemo, useState } from 'react'

interface SlotDto { startUtc: string; endUtc: string }
interface AvailabilityDto {
  slots: SlotDto[]
  rules: { durationMinutes: number; slotIntervalMinutes: number; minNoticeHours: number; maxDaysOut: number }
  recruiterTimezone: string
  workspaceName: string
}

interface Props {
  configId: string
  token: string
  candidateName: string | null
  candidateEmail: string | null
  candidatePhone: string | null
  workspaceName: string
  workspaceLogo: string | null
  configName: string
  mode?: 'book' | 'reschedule'
  currentMeetingStartUtc?: string | null
  /** Public global-link mode — no token in URL. Confirm step collects name/email. */
  anonymous?: boolean
}

const DAYS_VISIBLE_DESKTOP = 3
const COMMON_TIMEZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Dublin', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney']

export function BookingClient(props: Props) {
  const browserTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
  }, [])
  const [tz, setTz] = useState<string>(browserTz)
  const [availability, setAvailability] = useState<AvailabilityDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<SlotDto | null>(null)
  const [view, setView] = useState<'pick' | 'confirm' | 'done'>('pick')
  const isReschedule = props.mode === 'reschedule'

  // Confirmation form state.
  const [name, setName] = useState(props.candidateName || '')
  const [email, setEmail] = useState(props.candidateEmail || '')
  const [phone, setPhone] = useState(props.candidatePhone || '')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmedMeetingUri, setConfirmedMeetingUri] = useState<string | null>(null)
  const [confirmedRescheduleToken, setConfirmedRescheduleToken] = useState<string | null>(null)
  const [confirmedCancelToken, setConfirmedCancelToken] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setLoadError(null)
      try {
        const url = props.anonymous
          ? `/api/public/booking/${props.configId}/availability`
          : `/api/public/booking/${props.configId}/availability?t=${encodeURIComponent(props.token)}`
        const r = await fetch(url)
        const data = await r.json()
        if (!r.ok) throw new Error(data.message || data.error || 'Failed to load availability')
        if (!cancelled) setAvailability(data)
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [props.configId, props.token])

  // Group slots by candidate-tz day key (YYYY-MM-DD).
  const slotsByDay = useMemo(() => {
    if (!availability) return new Map<string, SlotDto[]>()
    const m = new Map<string, SlotDto[]>()
    for (const s of availability.slots) {
      const key = formatDayKey(new Date(s.startUtc), tz)
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(s)
    }
    return m
  }, [availability, tz])

  // Calendar month state.
  const todayKey = useMemo(() => formatDayKey(new Date(), tz), [tz])
  const [monthAnchor, setMonthAnchor] = useState<{ year: number; month: number }>(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() + 1 }
  })
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null)

  // First day of month with slots becomes the default selected day once data loads.
  useEffect(() => {
    if (!selectedDayKey && slotsByDay.size > 0) {
      const first = Array.from(slotsByDay.keys()).sort()[0]
      setSelectedDayKey(first)
      const [y, m] = first.split('-').map(Number)
      setMonthAnchor({ year: y, month: m })
    }
  }, [slotsByDay, selectedDayKey])

  const visibleDayKeys = useMemo(() => {
    if (!selectedDayKey) return []
    const out: string[] = []
    let cursor = parseDayKey(selectedDayKey)
    for (let i = 0; i < DAYS_VISIBLE_DESKTOP; i++) {
      const key = ymdToKey(cursor.year, cursor.month, cursor.day)
      out.push(key)
      cursor = addDays(cursor, 1)
    }
    return out
  }, [selectedDayKey])

  async function handleConfirm() {
    if (!selectedSlot) return
    if (props.anonymous && !name.trim()) { setSubmitError('Please enter your name'); return }
    if (props.anonymous && !email.trim()) { setSubmitError('Please enter your email'); return }
    setSubmitting(true); setSubmitError(null)
    try {
      const endpoint = isReschedule
        ? `/api/public/booking/${props.configId}/reschedule`
        : `/api/public/booking/${props.configId}`
      const payload = isReschedule
        ? { t: props.token, slotStartUtc: selectedSlot.startUtc }
        : {
            // No t in anonymous mode — server creates the session from
            // candidateName/Email/Phone instead.
            ...(props.anonymous ? {} : { t: props.token }),
            slotStartUtc: selectedSlot.startUtc,
            candidateName: name || null,
            candidateEmail: email || null,
            candidatePhone: phone || null,
            notes: notes || null,
          }
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await r.json()
      if (!r.ok) {
        if (r.status === 409 && data.error === 'slot_unavailable') {
          setSubmitError('That slot was just taken. Please pick another time.')
          setSelectedSlot(null); setView('pick')
          window.location.reload()
          return
        }
        // Prefer `message` (human-readable text written by the server for the
        // candidate) over `error` (machine key like `free_busy_failed` that
        // means nothing to the candidate). Fall back to the key only if no
        // message was sent. `data.detail` is the raw exception text — only
        // useful for debugging when the human message is generic. We append
        // it as a small technical hint so the recruiter can copy-paste it
        // when reporting a problem, without dominating the UI. Skip when
        // detail === message (avoids doubling up on non-generic errors).
        const human = data.message || data.error || 'Booking failed'
        const detail = data.detail && data.detail !== data.error && data.detail !== human
          ? String(data.detail).slice(0, 300)
          : null
        throw new Error(detail ? `${human} (${detail})` : human)
      }
      setConfirmedMeetingUri(data.meetingUri || null)
      setConfirmedRescheduleToken(data.rescheduleToken || null)
      setConfirmedCancelToken(data.cancelToken || null)
      setView('done')
    } catch (err) {
      setSubmitError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  // ============ Render ============

  if (view === 'done' && confirmedMeetingUri && selectedSlot) {
    return (
      <Shell {...props}>
        <div className="px-10 py-12 max-w-2xl mx-auto">
          <div className="w-12 h-12 rounded-full bg-[#FF9500] flex items-center justify-center mb-5">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </div>
          <h1 className="text-[28px] font-semibold text-[#262626] mb-2">{isReschedule ? "You're rescheduled." : "You're booked."}</h1>
          <p className="text-[15px] text-[#666] mb-7">{isReschedule ? 'Your calendar invite has been updated.' : `A confirmation email is on its way to ${email || 'your inbox'}.`}</p>
          <div className="border border-[#E5E7EB] rounded-md p-4 mb-6">
            <div className="text-[12px] uppercase tracking-wider text-[#888] mb-1">When</div>
            <div className="text-[#262626] font-medium text-[15px]">{formatSlotFull(new Date(selectedSlot.startUtc), tz, availability?.rules.durationMinutes ?? 30)}</div>
            <div className="text-[12px] text-[#888] mt-1.5">Timezone: {tz}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a href={confirmedMeetingUri} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 bg-[#FF9500] text-white px-5 py-2.5 rounded-md font-medium hover:bg-[#E68500] transition-colors">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M16 8.5l5-3v13l-5-3v3a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h9a2 2 0 012 2v.5z"/></svg>
              Join Google Meet
            </a>
            {confirmedRescheduleToken && !isReschedule && (
              <a
                href={`/book/${props.configId}/reschedule?t=${encodeURIComponent(confirmedRescheduleToken)}`}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-md border border-[#E5E7EB] text-[#262626] text-[13px] font-medium hover:border-[#FF9500] transition-colors"
              >
                Reschedule
              </a>
            )}
            {confirmedCancelToken && !isReschedule && (
              <button
                onClick={async () => {
                  if (!confirm('Cancel this interview?')) return
                  const r = await fetch(`/api/public/booking/${props.configId}/cancel`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ t: confirmedCancelToken }),
                  })
                  if (r.ok) window.location.reload()
                  else alert('Cancel failed: ' + (await r.text()))
                }}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-md border border-[#E5E7EB] text-[#888] text-[13px] font-medium hover:border-red-400 hover:text-red-600 transition-colors"
              >
                Cancel meeting
              </button>
            )}
          </div>
          {(confirmedRescheduleToken || confirmedCancelToken) && !isReschedule && (
            <p className="mt-4 text-[12px] text-[#888]">
              These reschedule/cancel links expire 1 hour before the meeting. We&apos;ll also email them to you.
            </p>
          )}
        </div>
      </Shell>
    )
  }

  return (
    <Shell {...props}>
      <div className="grid lg:grid-cols-[280px_320px_1fr] gap-0 min-h-[640px]">
        {/* Left column — host info (+ candidate form in anonymous mode) */}
        <aside className="px-8 py-8 border-r border-[#E5E7EB]">
          <div className="flex items-center gap-2.5 mb-5">
            <Avatar logoUrl={props.workspaceLogo} name={props.workspaceName} />
            <div className="text-[13px] text-[#666]">{props.workspaceName}</div>
          </div>
          <h1 className="text-[22px] font-semibold text-[#262626] leading-tight mb-3">{props.configName}</h1>
          <div className="space-y-2 text-[13px] text-[#444]">
            {availability && (
              <div className="flex items-center gap-2">
                <Icon kind="clock" />
                <span>{availability.rules.durationMinutes} mins</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Icon kind="video" />
              <span>Google Meet</span>
            </div>
            {isReschedule && props.currentMeetingStartUtc && (
              <div className="mt-4 px-3 py-2 bg-[#FFF4D6] border border-[#FFD466] rounded-md text-[12px] text-[#5C4500]">
                Currently scheduled for {formatSlotFull(new Date(props.currentMeetingStartUtc), tz, availability?.rules.durationMinutes ?? 30)}
              </div>
            )}
            <div className="pt-3">
              <Icon kind="globe" />
              <span className="ml-2">
                <select
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                  className="bg-transparent text-[13px] text-[#444] focus:outline-none cursor-pointer"
                  aria-label="Timezone"
                >
                  {Array.from(new Set([browserTz, tz, availability?.recruiterTimezone || 'UTC', ...COMMON_TIMEZONES])).filter(Boolean).map((z) => (
                    <option key={z} value={z}>{z}</option>
                  ))}
                </select>
              </span>
            </div>
          </div>

          {props.anonymous && !loading && !loadError && (
            <div className="mt-7 pt-6 border-t border-[#E5E7EB]">
              <h2 className="text-[14px] font-semibold text-[#262626] mb-3">Your details</h2>
              <div className="space-y-3">
                <InlineField label="Name *" value={name} onChange={setName} />
                <InlineField label="Email *" type="email" value={email} onChange={setEmail} />
                <InlineField label="Phone (optional)" value={phone} onChange={setPhone} />
                <div>
                  <label className="text-[12px] text-[#444] block mb-1">Notes (optional)</label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    className="w-full px-2.5 py-1.5 border border-[#E5E7EB] rounded-md text-[13px] text-[#262626] focus:outline-none focus:border-[#FF9500]"
                  />
                </div>
              </div>

              <div className="mt-5">
                {selectedSlot ? (
                  <div className="text-[12px] text-[#262626] bg-[#F7F7F8] rounded-md px-2.5 py-2 mb-3">
                    {formatSlotFull(new Date(selectedSlot.startUtc), tz, availability?.rules.durationMinutes ?? 30)}
                  </div>
                ) : (
                  <div className="text-[12px] text-[#888] mb-3">Pick a time on the right →</div>
                )}
                {submitError && <div className="text-[12px] text-red-600 mb-2">{submitError}</div>}
                <button
                  onClick={handleConfirm}
                  disabled={!selectedSlot || !name.trim() || !email.trim() || submitting}
                  className="w-full bg-[#FF9500] text-white py-2.5 rounded-md text-[13px] font-medium hover:bg-[#E68500] transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Booking…' : 'Confirm booking'}
                </button>
              </div>
            </div>
          )}
        </aside>

        {/* Middle column — month calendar */}
        <div className="px-7 py-8 border-r border-[#E5E7EB]">
          {loading && <div className="text-[#888] text-[13px]">Loading…</div>}
          {loadError && (
            <div className="text-red-600 text-[13px]">
              <div>Could not load availability.</div>
              <div className="text-[11px] text-red-500 mt-1 font-mono">{loadError}</div>
            </div>
          )}
          {!loading && !loadError && (
            <MonthCalendar
              monthAnchor={monthAnchor}
              setMonthAnchor={setMonthAnchor}
              slotsByDay={slotsByDay}
              selectedDayKey={selectedDayKey}
              onSelectDay={(k) => { setSelectedDayKey(k); setSelectedSlot(null); if (!props.anonymous) setView('pick') }}
              todayKey={todayKey}
              maxDaysOut={availability?.rules.maxDaysOut ?? 14}
            />
          )}
        </div>

        {/* Right column — slot picker (always shows slots in anonymous; flips to confirm only in tokened/reschedule) */}
        <div className="px-8 py-8 min-w-0">
          {loading && <div className="text-[#888] text-[13px]">Loading times…</div>}
          {!loading && !loadError && (props.anonymous || view === 'pick') && (
            <SlotColumns
              visibleDayKeys={visibleDayKeys}
              selectedDayKey={selectedDayKey}
              slotsByDay={slotsByDay}
              tz={tz}
              selectedSlotStartUtc={selectedSlot?.startUtc}
              onPickSlot={(s) => {
                setSelectedSlot(s)
                if (!props.anonymous) setView('confirm')
              }}
              shiftBy={(n) => {
                if (!selectedDayKey) return
                const next = addDays(parseDayKey(selectedDayKey), n)
                setSelectedDayKey(ymdToKey(next.year, next.month, next.day))
                setMonthAnchor({ year: next.year, month: next.month })
              }}
            />
          )}
          {!props.anonymous && view === 'confirm' && selectedSlot && (
            <ConfirmStep
              slot={selectedSlot}
              tz={tz}
              durationMinutes={availability?.rules.durationMinutes ?? 30}
              isReschedule={isReschedule}
              name={name} setName={setName}
              email={email} setEmail={setEmail}
              phone={phone} setPhone={setPhone}
              notes={notes} setNotes={setNotes}
              onCancel={() => { setSelectedSlot(null); setView('pick') }}
              onConfirm={handleConfirm}
              submitting={submitting}
              submitError={submitError}
            />
          )}
        </div>
      </div>
    </Shell>
  )
}

// ============ Subcomponents ============

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white" style={{ fontFamily: '"Inter", "Be Vietnam Pro", system-ui, -apple-system, sans-serif', color: '#262626' }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-12">
        <div className="border border-[#E5E7EB] rounded-lg overflow-hidden bg-white shadow-sm">
          {children}
        </div>
      </div>
    </div>
  )
}

function Avatar({ logoUrl, name }: { logoUrl: string | null; name: string }) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={name} className="w-7 h-7 rounded-full object-cover" />
  }
  const initial = (name || '?').charAt(0).toUpperCase()
  return (
    <div className="w-7 h-7 rounded-full bg-[#FF9500] text-white flex items-center justify-center text-[12px] font-medium">{initial}</div>
  )
}

function Icon({ kind }: { kind: 'clock' | 'video' | 'globe' }) {
  const cls = 'w-4 h-4 inline-block text-[#666] flex-shrink-0'
  if (kind === 'clock') return (<svg className={cls} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" strokeLinecap="round"/></svg>)
  if (kind === 'video') return (<svg className={cls} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>)
  return (<svg className={cls} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13 13 0 010 18M12 3a13 13 0 000 18"/></svg>)
}

function MonthCalendar({
  monthAnchor, setMonthAnchor, slotsByDay, selectedDayKey, onSelectDay, todayKey, maxDaysOut,
}: {
  monthAnchor: { year: number; month: number }
  setMonthAnchor: (m: { year: number; month: number }) => void
  slotsByDay: Map<string, unknown[]>
  selectedDayKey: string | null
  onSelectDay: (key: string) => void
  todayKey: string
  maxDaysOut: number
}) {
  const monthLabel = new Date(Date.UTC(monthAnchor.year, monthAnchor.month - 1, 1))
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  // Build the weeks grid. Sunday-first.
  const firstDayOfMonth = new Date(Date.UTC(monthAnchor.year, monthAnchor.month - 1, 1))
  const startOffset = firstDayOfMonth.getUTCDay() // 0 = Sun
  const daysInMonth = new Date(Date.UTC(monthAnchor.year, monthAnchor.month, 0)).getUTCDate()
  const cells: ({ day: number; key: string } | null)[] = []
  for (let i = 0; i < startOffset; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, key: ymdToKey(monthAnchor.year, monthAnchor.month, d) })
  }
  while (cells.length % 7 !== 0) cells.push(null)

  const todayY = parseInt(todayKey.split('-')[0], 10)
  const todayM = parseInt(todayKey.split('-')[1], 10)
  const todayD = parseInt(todayKey.split('-')[2], 10)
  const maxDate = new Date(Date.UTC(todayY, todayM - 1, todayD))
  maxDate.setUTCDate(maxDate.getUTCDate() + maxDaysOut)
  const maxKey = ymdToKey(maxDate.getUTCFullYear(), maxDate.getUTCMonth() + 1, maxDate.getUTCDate())

  const goPrev = () => {
    const d = new Date(Date.UTC(monthAnchor.year, monthAnchor.month - 2, 1))
    setMonthAnchor({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 })
  }
  const goNext = () => {
    const d = new Date(Date.UTC(monthAnchor.year, monthAnchor.month, 1))
    setMonthAnchor({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[14px] font-medium text-[#262626]">
          {monthLabel.replace(/\s\d{4}$/, '')} <span className="text-[#888] font-normal">{monthAnchor.year}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={goPrev} aria-label="Previous month" className="w-7 h-7 rounded hover:bg-[#F3F4F6] flex items-center justify-center text-[#444]">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button onClick={goNext} aria-label="Next month" className="w-7 h-7 rounded hover:bg-[#F3F4F6] flex items-center justify-center text-[#444]">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] font-medium text-[#9CA3AF] uppercase tracking-wider mb-2">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-y-1">
        {cells.map((cell, i) => {
          if (!cell) return <div key={i} />
          const hasSlots = (slotsByDay.get(cell.key)?.length || 0) > 0
          const isPast = cell.key < todayKey
          const isFuture = cell.key > maxKey
          const disabled = !hasSlots || isPast || isFuture
          const isSelected = cell.key === selectedDayKey
          const isToday = cell.key === todayKey
          return (
            <div key={cell.key} className="flex justify-center">
              <button
                onClick={() => !disabled && onSelectDay(cell.key)}
                disabled={disabled}
                aria-label={cell.key}
                className={`relative w-9 h-9 rounded-full text-[13px] transition-colors ${
                  isSelected ? 'bg-[#FF9500] text-white font-medium'
                  : disabled ? 'text-[#D1D5DB] cursor-default'
                  : isToday ? 'text-[#262626] font-semibold hover:bg-[#F3F4F6]'
                  : 'text-[#262626] hover:bg-[#F3F4F6]'
                }`}
              >
                {cell.day}
                {hasSlots && !isSelected && !disabled && (
                  <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#FF9500]" />
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SlotColumns({
  visibleDayKeys, selectedDayKey, slotsByDay, tz, onPickSlot, shiftBy, selectedSlotStartUtc,
}: {
  visibleDayKeys: string[]
  selectedDayKey: string | null
  slotsByDay: Map<string, SlotDto[]>
  tz: string
  onPickSlot: (s: SlotDto) => void
  shiftBy: (n: number) => void
  selectedSlotStartUtc?: string
}) {
  if (!selectedDayKey || visibleDayKeys.length === 0) {
    return <div className="text-[#888] text-[13px]">Pick a day on the calendar to see times.</div>
  }
  const headerLabel = (() => {
    const ymd = parseDayKey(selectedDayKey)
    const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, 12))
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  })()

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[14px] font-medium text-[#262626]">{headerLabel}</div>
        <div className="flex items-center gap-1">
          <button onClick={() => shiftBy(-1)} className="w-7 h-7 rounded hover:bg-[#F3F4F6] flex items-center justify-center text-[#444]" aria-label="Earlier days">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button onClick={() => shiftBy(1)} className="w-7 h-7 rounded hover:bg-[#F3F4F6] flex items-center justify-center text-[#444]" aria-label="Later days">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-3">
        {visibleDayKeys.map((dk, idx) => {
          const ymd = parseDayKey(dk)
          const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, 12))
          const slots = slotsByDay.get(dk) || []
          const isSelected = idx === 0
          return (
            <div key={dk}>
              <div className={`text-center pb-2 mb-2 text-[11px] font-medium uppercase tracking-wider ${isSelected ? 'text-[#262626]' : 'text-[#888]'}`}>
                <span>{d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</span>
                <span className={`ml-1.5 ${isSelected ? 'inline-flex items-center justify-center w-5 h-5 rounded-full bg-[#FF9500] text-white text-[11px]' : 'text-[#888]'}`}>{ymd.day}</span>
              </div>
              <div className="space-y-1.5 max-h-[480px] overflow-y-auto pr-1">
                {slots.length === 0 && <div className="text-center text-[12px] text-[#BBB] pt-3">—</div>}
                {slots.map((s) => {
                  const isSel = selectedSlotStartUtc === s.startUtc
                  return (
                    <button
                      key={s.startUtc}
                      onClick={() => onPickSlot(s)}
                      className={`w-full py-2 rounded-md border text-[13px] font-medium transition-colors ${
                        isSel
                          ? 'border-[#FF9500] bg-[#FF9500] text-white'
                          : 'border-[#E5E7EB] text-[#262626] hover:border-[#FF9500]'
                      }`}
                    >
                      {formatTime(new Date(s.startUtc), tz)}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ConfirmStep({
  slot, tz, durationMinutes, isReschedule,
  name, setName, email, setEmail, phone, setPhone, notes, setNotes,
  onCancel, onConfirm, submitting, submitError,
}: {
  slot: SlotDto; tz: string; durationMinutes: number; isReschedule: boolean
  name: string; setName: (v: string) => void
  email: string; setEmail: (v: string) => void
  phone: string; setPhone: (v: string) => void
  notes: string; setNotes: (v: string) => void
  onCancel: () => void; onConfirm: () => void; submitting: boolean; submitError: string | null
}) {
  return (
    <div className="max-w-md">
      <h2 className="text-[18px] font-semibold text-[#262626] mb-1">{isReschedule ? 'Confirm new time' : 'Enter your details'}</h2>
      <div className="text-[13px] text-[#666] mb-5">{formatSlotFull(new Date(slot.startUtc), tz, durationMinutes)}</div>
      {!isReschedule ? (
        <div className="space-y-3">
          <ConfirmField label="Name *" value={name} onChange={setName} />
          <ConfirmField label="Email *" type="email" value={email} onChange={setEmail} />
          <ConfirmField label="Phone" value={phone} onChange={setPhone} />
          <div>
            <label className="text-[12px] text-[#444] block mb-1">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              className="w-full px-3 py-2 border border-[#E5E7EB] rounded-md text-[13px] text-[#262626] focus:outline-none focus:border-[#FF9500]" />
          </div>
        </div>
      ) : (
        <div className="text-[13px] text-[#666] mb-2">We&apos;ll update your existing meeting to this time.</div>
      )}
      {submitError && <div className="mt-3 text-[12px] text-red-600">{submitError}</div>}
      <div className="flex gap-2 mt-6">
        <button onClick={onCancel} disabled={submitting}
          className="px-4 py-2 rounded-md border border-[#E5E7EB] text-[13px] text-[#444] hover:border-[#FF9500] transition-colors disabled:opacity-50">
          Back
        </button>
        <button onClick={onConfirm} disabled={submitting || (!isReschedule && !email)}
          className="px-5 py-2 rounded-md bg-[#FF9500] text-white text-[13px] font-medium hover:bg-[#E68500] transition-colors disabled:opacity-50">
          {submitting ? (isReschedule ? 'Rescheduling…' : 'Booking…') : (isReschedule ? 'Confirm reschedule' : 'Confirm booking')}
        </button>
      </div>
    </div>
  )
}

function InlineField({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="text-[12px] text-[#444] block mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2.5 py-1.5 border border-[#E5E7EB] rounded-md text-[13px] text-[#262626] focus:outline-none focus:border-[#FF9500]"
      />
    </div>
  )
}

function ConfirmField({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="text-[12px] text-[#444] block mb-1">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-[#E5E7EB] rounded-md text-[13px] text-[#262626] focus:outline-none focus:border-[#FF9500]" />
    </div>
  )
}

// ============ Helpers ============

function formatDayKey(d: Date, tz: string): string {
  return d.toLocaleDateString('en-CA', { timeZone: tz }) // YYYY-MM-DD
}
function parseDayKey(key: string): { year: number; month: number; day: number } {
  const [y, m, d] = key.split('-').map(Number)
  return { year: y, month: m, day: d }
}
function ymdToKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
function addDays({ year, month, day }: { year: number; month: number; day: number }, n: number) {
  const d = new Date(Date.UTC(year, month - 1, day))
  d.setUTCDate(d.getUTCDate() + n)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}
function formatTime(d: Date, tz: string): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).toLowerCase().replace(' ', '')
}
function formatSlotFull(d: Date, tz: string, durationMinutes: number): string {
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz })
  const start = formatTime(d, tz)
  const end = formatTime(new Date(d.getTime() + durationMinutes * 60_000), tz)
  return `${day}, ${start}–${end}`
}
