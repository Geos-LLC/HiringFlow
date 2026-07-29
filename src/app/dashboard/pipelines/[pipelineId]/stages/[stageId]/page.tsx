/**
 * Stage detail — matches Design/3-stage-meeting.png.
 *
 * Layout (top → bottom):
 *   StageStrip (horizontal chevron pills, selected stage highlighted)
 *   StageSummaryCard (title + primary CTA + uncertainty rows)
 *   StageInfoGrid (4 stat cards)
 *   3-col body: Today's interviews · Candidates here · (Stage config + Timeline)
 *   Advanced footer link
 */

'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import type { StageOverviewResponse } from '@/lib/hf-core/stage-overview'
import {
  StageStrip,
  StageSummaryCard,
  StageInfoGrid,
  StageSuggestions,
  StageTodaysInterviewsCol,
  StageCandidatesCol,
  StageConfigCol,
  StageTimelineCol,
} from '../../../_stage-shell'

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
        {error || 'Stage not found.'}{' '}
        <Link href="/dashboard/pipelines" className="text-brand-600 underline">Back to pipelines</Link>
      </div>
    )
  }

  const countsByStage: Record<string, number> = { [data.stage.id]: data.candidates.length }

  return (
    <div className="flex flex-col gap-5">
      <StageStrip
        pipelineId={data.pipeline.id}
        stages={data.pipeline.stages}
        selectedStageId={data.stage.id}
        countsByStageId={countsByStage}
      />

      <StageSummaryCard data={data} />

      <StageInfoGrid data={data} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <StageTodaysInterviewsCol rows={data.todaysInterviews} />
        <StageCandidatesCol rows={data.candidates} />
        <div className="flex flex-col gap-4">
          <StageConfigCol
            bookings={data.bookingPages}
            reminders={data.reminders}
            pipelineId={data.pipeline.id}
            stageId={data.stage.id}
          />
          <StageTimelineCol entries={data.timeline} />
        </div>
      </div>

      <StageSuggestions candidates={data.candidates} reminders={data.reminders} />

      <div className="pt-2">
        <Link
          href={`/dashboard/pipelines?stage=${encodeURIComponent(data.stage.id)}`}
          className="text-[12px] text-grey-40 hover:text-ink font-medium"
        >
          Advanced ▾
        </Link>
      </div>
    </div>
  )
}
