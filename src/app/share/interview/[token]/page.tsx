'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

interface SharedInterview {
  candidateName: string | null
  flowName: string | null
  scheduledStart: string
  scheduledEnd: string
  playbackUrl: string
  playbackExpiresAt: string
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export default function SharedInterviewPage() {
  const params = useParams()
  const token = params.token as string
  const [data, setData] = useState<SharedInterview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/public/interview-meetings/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 404) throw new Error('This share link is no longer valid.')
          if (res.status === 409) throw new Error('Recording is not ready yet — try again in a moment.')
          throw new Error(`Could not load recording (HTTP ${res.status}).`)
        }
        return res.json()
      })
      .then((d: SharedInterview) => { if (!cancelled) setData(d) })
      .catch((err: Error) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-8" style={{ background: '#FAF8F5' }}>
      {/* HireFunnel brand header — same mark + wordmark used on the marketing
          navbar so external viewers see consistent identity. */}
      <header className="w-full max-w-3xl flex items-center gap-2.5 mb-6">
        <a href="https://www.hirefunnel.app" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white font-bold text-[17px]"
            style={{ background: 'var(--brand-primary)', boxShadow: 'var(--shadow-brand)' }}
          >
            h
          </div>
          <span className="text-[16px] font-semibold text-ink" style={{ letterSpacing: '-0.01em' }}>
            HireFunnel
          </span>
        </a>
      </header>

      <div className="bg-white rounded-[12px] border border-surface-border shadow-sm w-full max-w-3xl p-6">
        <h1 className="text-lg font-semibold text-grey-15 mb-1">Shared interview recording</h1>
        <p className="text-xs text-grey-40 mb-5">Sent to you by a HireFunnel recruiter.</p>

        {loading ? (
          <div className="text-sm text-grey-40 py-8 text-center">Loading…</div>
        ) : error ? (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-[8px] p-4">
            {error}
          </div>
        ) : data ? (
          <>
            <div className="mb-4 pb-4 border-b border-surface-divider">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35 mb-1">
                Candidate
              </div>
              <div className="text-base font-medium text-ink mb-2">
                {data.candidateName || 'Unnamed candidate'}
              </div>
              <dl className="grid grid-cols-2 gap-y-1 text-[12px]">
                {data.flowName && (
                  <>
                    <dt className="text-grey-35">Flow</dt>
                    <dd className="text-ink">{data.flowName}</dd>
                  </>
                )}
                <dt className="text-grey-35">Interview</dt>
                <dd className="text-ink">{fmtDateTime(data.scheduledStart)}</dd>
              </dl>
            </div>

            <video
              src={data.playbackUrl}
              controls
              playsInline
              preload="metadata"
              className="w-full rounded-[8px] bg-black"
            />
          </>
        ) : null}
      </div>
      <a href="https://www.hirefunnel.app" className="mt-6 text-xs text-grey-40 hover:text-grey-15">
        hirefunnel.app
      </a>
    </div>
  )
}
