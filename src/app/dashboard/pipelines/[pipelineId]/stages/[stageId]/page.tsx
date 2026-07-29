/**
 * Stage detail — plugin-composed surface that renders any Stage Type using
 * the shared HFObject primitives.
 *
 * Layout follows the Meeting-stage spec (see docs/ux-vision.md):
 *   Header  → Uncertainty row → Info cards →
 *   Recommendations → Today's interviews → Candidates →
 *   Booking pages → Reminders → Timeline → Advanced ▾
 *
 * Which panels render is driven by `stage.panels` (from STAGE_TYPES in
 * src/lib/hf-core/stage-types.ts). Adding a new stage type = one entry in
 * the registry + any new panel components under `stage-panels/`.
 */

'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ObjectShell, Timeline } from '@/components/hf'
import { Card, Eyebrow, Badge } from '@/components/design'
import type { StageOverviewResponse } from '@/lib/hf-core/stage-overview'
import type { HFObject } from '@/lib/hf-core/types'
import {
  StageCandidatesPanel,
  StageTodaysInterviewsPanel,
  StageBookingPanel,
  StageRemindersPanel,
} from './_panels'

export default function StageDetailPage() {
  const params = useParams()
  const pipelineId = params.pipelineId as string
  const stageId = params.stageId as string
  const [data, setData] = useState<StageOverviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/hf/stages/${pipelineId}/${stageId}/overview`)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [pipelineId, stageId])

  if (loading) return <div className="text-grey-40 text-sm">Loading stage…</div>
  if (error || !data) {
    return (
      <div className="text-grey-40 text-sm">
        {error || 'Stage not found.'} <Link href="/dashboard/pipelines" className="text-brand-600 underline">Back to pipelines</Link>
      </div>
    )
  }

  const hfObject: HFObject = {
    id: `stage:${data.pipeline.id}:${data.stage.id}`,
    kind: 'stage',
    overview: data.overview,
    primaryAction: data.primaryAction,
    recommendations: [], // v1 — stage recommendations wired in Phase 2b follow-up
    related: [
      { kind: 'pipeline', id: data.pipeline.id, label: data.pipeline.name, href: '/dashboard/pipelines' },
    ],
    advanced: [
      { id: 'edit_stage_rules', label: 'Movement rules & stage settings', href: `/dashboard/pipelines?stage=${encodeURIComponent(data.stage.id)}` },
    ],
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb strip — the stage horizontal flow, kept visible so users
          know where in the pipeline they are. Clicking another stage
          navigates within the same pipeline. */}
      <StageStrip data={data} />

      <ObjectShell
        object={hfObject}
        body={
          <div className="flex flex-col gap-5">
            {data.stage.panels.includes('todays_interviews') && (
              <StageTodaysInterviewsPanel interviews={data.todaysInterviews} />
            )}
            {data.stage.panels.includes('candidates') && (
              <StageCandidatesPanel candidates={data.candidates} />
            )}
            {data.stage.panels.includes('booking') && (
              <StageBookingPanel bookings={data.bookingPages} />
            )}
            {data.stage.panels.includes('reminders') && (
              <StageRemindersPanel reminders={data.reminders} pipelineId={data.pipeline.id} stageId={data.stage.id} />
            )}
          </div>
        }
        timeline={
          <Card>
            <Timeline
              entries={data.timeline}
              title="Recent activity"
              initial={12}
              emptyLabel="Nothing happened at this stage in the last 7 days."
            />
          </Card>
        }
        advanced={
          <Card>
            <Eyebrow className="mb-2">Advanced</Eyebrow>
            <ul className="flex flex-col gap-1 text-[13px]">
              {(hfObject.advanced || []).map(a => (
                <li key={a.id}>
                  {a.href
                    ? <Link href={a.href} className="text-brand-600 hover:text-brand-700 hover:underline">{a.label} →</Link>
                    : <span className="text-grey-35">{a.label}</span>}
                </li>
              ))}
            </ul>
          </Card>
        }
      />
    </div>
  )
}

function StageStrip({ data }: { data: StageOverviewResponse }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Link href="/dashboard/pipelines" className="font-mono text-[11px] uppercase text-grey-40 hover:text-ink" style={{ letterSpacing: '0.1em' }}>
        {data.pipeline.name}
      </Link>
      <span className="text-grey-60">/</span>
      {data.pipeline.stages.map((s, i) => {
        const active = s.id === data.stage.id
        return (
          <span key={s.id} className="flex items-center gap-2">
            {i > 0 && <span className="text-grey-60">→</span>}
            {active ? (
              <Badge tone="brand">{s.label}</Badge>
            ) : (
              <Link
                href={`/dashboard/pipelines/${data.pipeline.id}/stages/${encodeURIComponent(s.id)}`}
                className="text-[13px] text-grey-35 hover:text-ink"
              >
                {s.label}
              </Link>
            )}
          </span>
        )
      })}
    </div>
  )
}
