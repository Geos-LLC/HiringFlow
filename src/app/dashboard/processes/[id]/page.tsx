/**
 * Hiring Process — create/edit page.
 *
 * Sectioned editor (not a hard stepper — the recruiter can jump between
 * sections and save as draft at any time). Sections mirror the candidate
 * journey:
 *
 *   1. Basics             name + description + status
 *   2. Application        select existing Flow
 *   3. Training           select existing Training (optional)
 *   4. Scheduling         select existing SchedulingConfig (optional)
 *   5. Pipeline           select existing Pipeline (required to activate)
 *   6. Automations        multi-select AutomationRules + stage warnings
 *   7. Review             candidate journey summary + booking link preview
 *
 * "Activate" lives on the Review section so the activation gate
 * (flow + pipeline required, no other active process on the same flow) is
 * the last thing the recruiter sees. Drafts save without those checks.
 */

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Badge, Button, Card, PageHeader, WipBadge } from '@/components/design'

interface FlowOption { id: string; name: string; slug: string; isPublished: boolean }
// FlowDetail mirrors the relevant subset of /api/flows/[id] — enough to render
// a "what candidates will be asked" preview without re-implementing the flow
// builder. video/options/captureConfig are present but lightly typed since we
// only display titles + question text here, not the editing surface.
interface FlowDetailStep {
  id: string
  stepOrder: number
  title: string | null
  stepType: string                // 'video' | 'question' | 'form' | 'screen'
  questionType: string | null
  questionText: string | null
  formEnabled: boolean
  formConfig: { fields?: Array<{ id?: string; label?: string; type?: string; required?: boolean }> } | null
  infoContent: string | null
  video: { id: string; url: string | null } | null
  options: Array<{ id: string; optionText: string }>
}
interface FlowDetail {
  id: string
  name: string
  slug: string
  isPublished: boolean
  startMessage: string
  endMessage: string
  positionDescription: string | null
  steps: FlowDetailStep[]
}
interface TrainingOption { id: string; title: string }
interface SchedulingOption { id: string; name: string }
interface PipelineOption { id: string; name: string; isDefault: boolean }
interface AutomationOption {
  id: string
  name: string
  triggerType: string
  stageId: string | null
  pipelineId: string | null
  isActive: boolean
}

interface ProcessDetail {
  id: string
  name: string
  description: string | null
  status: 'draft' | 'active' | 'archived'
  flow: { id: string; name: string; slug: string } | null
  training: { id: string; title: string; slug: string } | null
  schedulingConfig: { id: string; name: string; schedulingUrl: string; useBuiltInScheduler: boolean } | null
  pipeline: { id: string; name: string } | null
  automations: Array<{ id: string; name: string; triggerType: string; stageId: string | null; isActive: boolean; order: number }>
  stageWarnings: Array<{ ruleId: string; ruleName: string; stageId: string }>
  bookingUrlPreview: string | null
  candidatesCount: number
  createdAt: string
  updatedAt: string
}

const STATUS_TONE = { active: 'success', draft: 'brand', archived: 'neutral' } as const

const SECTIONS = [
  { key: 'basics',     label: '1. Basics' },
  { key: 'flow',       label: '2. Application Form' },
  { key: 'training',   label: '3. Training' },
  { key: 'scheduling', label: '4. Interview Booking' },
  { key: 'pipeline',   label: '5. Pipeline' },
  { key: 'automations',label: '6. Automations' },
  { key: 'review',     label: '7. Review' },
] as const
type SectionKey = (typeof SECTIONS)[number]['key']

export default function ProcessEditPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string

  const [section, setSection] = useState<SectionKey>('basics')

  // Source process (from server) — used to compute "unsaved" diff.
  const [serverProcess, setServerProcess] = useState<ProcessDetail | null>(null)

  // Form state (editable copy).
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [flowId, setFlowId] = useState<string | null>(null)
  const [trainingId, setTrainingId] = useState<string | null>(null)
  const [schedulingConfigId, setSchedulingConfigId] = useState<string | null>(null)
  const [pipelineId, setPipelineId] = useState<string | null>(null)
  const [automationRuleIds, setAutomationRuleIds] = useState<string[]>([])

  // Dropdown source data.
  const [flows, setFlows] = useState<FlowOption[]>([])
  const [trainings, setTrainings] = useState<TrainingOption[]>([])
  const [schedulingConfigs, setSchedulingConfigs] = useState<SchedulingOption[]>([])
  const [pipelines, setPipelines] = useState<PipelineOption[]>([])
  const [automations, setAutomations] = useState<AutomationOption[]>([])

  // Selected flow's full content — fetched lazily when flowId changes so
  // the Application Form section can show the actual screening steps
  // (questions, form fields, etc.) instead of a name-only picker. This is
  // what makes the Journey editor *the* screening surface: pick the flow
  // and immediately see what candidates will be asked.
  const [flowDetail, setFlowDetail] = useState<FlowDetail | null>(null)
  const [flowDetailLoading, setFlowDetailLoading] = useState(false)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedToast, setSavedToast] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [pRes, fRes, tRes, sRes, plRes, aRes] = await Promise.all([
      fetch(`/api/processes/${id}`),
      fetch('/api/flows'),
      fetch('/api/trainings'),
      fetch('/api/scheduling'),
      fetch('/api/pipelines'),
      fetch('/api/automations'),
    ])
    if (!pRes.ok) {
      setError('Process not found')
      setLoading(false)
      return
    }
    const p: ProcessDetail = await pRes.json()
    setServerProcess(p)
    setName(p.name)
    setDescription(p.description ?? '')
    setFlowId(p.flow?.id ?? null)
    setTrainingId(p.training?.id ?? null)
    setSchedulingConfigId(p.schedulingConfig?.id ?? null)
    setPipelineId(p.pipeline?.id ?? null)
    setAutomationRuleIds(p.automations.map((a) => a.id))

    if (fRes.ok) setFlows(await fRes.json())
    if (tRes.ok) setTrainings(await tRes.json())
    if (sRes.ok) setSchedulingConfigs(await sRes.json())
    if (plRes.ok) setPipelines(await plRes.json())
    if (aRes.ok) setAutomations(await aRes.json())
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  // Fetch the selected flow's steps whenever flowId changes. Clears the
  // preview when the recruiter picks "no flow" so the section reads as
  // intentionally empty rather than stale.
  useEffect(() => {
    if (!flowId) {
      setFlowDetail(null)
      return
    }
    let cancelled = false
    setFlowDetailLoading(true)
    fetch(`/api/flows/${flowId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: FlowDetail | null) => {
        if (cancelled) return
        setFlowDetail(data)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setFlowDetailLoading(false) })
    return () => { cancelled = true }
  }, [flowId])

  const save = async (opts: { activate?: boolean; archive?: boolean } = {}) => {
    setSaving(true)
    setError(null)
    setSavedToast(null)
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || null,
        flowId,
        trainingId,
        schedulingConfigId,
        pipelineId,
        automationRuleIds,
      }
      if (opts.activate) body.status = 'active'
      else if (opts.archive) body.status = 'archived'

      const res = await fetch(`/api/processes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Failed to save')
      }
      setSavedToast(opts.activate ? 'Activated' : opts.archive ? 'Archived' : 'Saved')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  // Live "would activation work?" check, mirroring the API gate. The Review
  // section uses this to disable the Activate button + show a checklist.
  const activationErrors = useMemo(() => {
    const errs: string[] = []
    if (!flowId) errs.push('Pick a Screening Flow.')
    if (!pipelineId) errs.push('Pick a Pipeline.')
    return errs
  }, [flowId, pipelineId])

  // Live stage-warning preview. Recomputed in the browser as the recruiter
  // toggles automations on/off so the warning shows up immediately instead
  // of after a save round-trip. The server recomputes authoritatively in GET.
  const liveStageWarnings = useMemo(() => {
    if (!pipelineId) return []
    const pipelineStageIds = new Set<string>()
    // We don't fetch the pipeline stages in this page yet, so derive from the
    // *currently saved* server stage warnings as a fallback. After save, the
    // server hand-back wins. For freshly-toggled rules we show no warning
    // until the next save — acceptable since the editor still warns on save.
    return automationRuleIds
      .map((rid) => automations.find((a) => a.id === rid))
      .filter((a): a is AutomationOption => !!a)
      .filter((a) => a.stageId && pipelineId && a.pipelineId && a.pipelineId !== pipelineId)
      .map((a) => ({ ruleId: a.id, ruleName: a.name, stageId: a.stageId! }))
  }, [automationRuleIds, automations, pipelineId])

  const allWarnings = serverProcess?.stageWarnings.length
    ? serverProcess.stageWarnings
    : liveStageWarnings

  if (loading) {
    return (
      <div>
        <PageHeader title="Loading…" />
      </div>
    )
  }

  if (!serverProcess) {
    return (
      <div>
        <PageHeader title="Not found" actions={<Link href="/dashboard/processes">Back</Link>} />
        {error && (
          <div className="px-4 py-3 rounded-[10px] bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        eyebrow="Journey"
        title={name || serverProcess.name}
        description={`Status: ${serverProcess.status}${serverProcess.candidatesCount ? ` · ${serverProcess.candidatesCount} candidates` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/processes"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] border border-surface-border text-[13px] text-ink hover:bg-surface-light"
            >
              &larr; All journeys
            </Link>
            <Badge tone={STATUS_TONE[serverProcess.status]}>{serverProcess.status}</Badge>
          </div>
        }
      />

      {error && (
        <div className="mb-4 px-4 py-3 rounded-[10px] bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}
      {savedToast && (
        <div className="mb-4 px-4 py-3 rounded-[10px] bg-green-50 border border-green-200 text-green-700 text-sm">
          {savedToast}
        </div>
      )}

      {/* === Visual block flow + Available blocks panel ===
          The visual flow renders whatever steps the journey has wired up
          (Application Form → Training → Interview Booking → Interview) as
          connected blocks. Click a block to jump to its config section in
          the editor below. The right-side blocks panel lists every block
          type the candidate journey can include; some are WIP (Wait,
          Conditional Split, Automation Trigger, Complete Journey) — they
          render visually but don't add to the journey yet. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-4 mb-6">
        <Card padding={20}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="font-semibold text-[14px] text-ink">Candidate journey</h2>
              <p className="text-[12px] text-grey-35">The path a candidate takes from application to hire. Click any block to edit.</p>
            </div>
            <WipBadge label="Drag-to-reorder coming" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Application Form — always shown. Required to activate. */}
            <JourneyBlock
              label="Application Form"
              entity={flows.find((f) => f.id === flowId)?.name}
              missing={!flowId}
              onClick={() => setSection('flow')}
            />
            <Connector />

            {/* Training — only renders when wired. Optional. */}
            {trainingId && (
              <>
                <JourneyBlock
                  label="Training"
                  entity={trainings.find((t) => t.id === trainingId)?.title}
                  onClick={() => setSection('training')}
                />
                <Connector />
              </>
            )}

            {/* Interview Booking — scheduling config. Optional. */}
            {schedulingConfigId && (
              <>
                <JourneyBlock
                  label="Interview Booking"
                  entity={schedulingConfigs.find((s) => s.id === schedulingConfigId)?.name}
                  onClick={() => setSection('scheduling')}
                />
                <Connector />
                <JourneyBlock
                  label="Interview"
                  entity="Meet"
                  onClick={() => setSection('scheduling')}
                />
                <Connector />
              </>
            )}

            {/* Complete Journey — visual terminator. WIP for any actual
                completion handler. */}
            <JourneyBlock
              label="Complete Journey"
              entity="Hired"
              wip
            />
          </div>

          {/* Hint when nothing is wired yet. */}
          {!flowId && !trainingId && !schedulingConfigId && (
            <div className="mt-3 text-[12px] text-grey-35">
              Wire at least an Application Form to give the journey a starting point.
            </div>
          )}
        </Card>

        <Card padding={16}>
          <h3 className="font-semibold text-[13px] text-ink mb-2">Available blocks</h3>
          <p className="text-[11px] text-grey-35 mb-3">Building blocks you can add to a journey.</p>
          <div className="space-y-1.5">
            <BlockOption label="Application Form"  available onClick={() => setSection('flow')} />
            <BlockOption label="Training"          available onClick={() => setSection('training')} />
            <BlockOption label="Interview Booking" available onClick={() => setSection('scheduling')} />
            <BlockOption label="AI Phone Screen"   wipReason="Connect AI Call to journey" />
            <BlockOption label="Wait"              wipReason="Time-based delay" />
            <BlockOption label="Conditional Split" wipReason="Branch by candidate answer" />
            <BlockOption label="Automation Trigger" wipReason="Fire an automation inline" />
            <BlockOption label="Complete Journey"  wipReason="Mark candidate as hired" />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6">
        {/* Section nav */}
        <nav className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`text-left px-3 py-2 rounded-[10px] text-[13px] whitespace-nowrap ${
                section === s.key
                  ? 'bg-brand-dim text-ink font-medium'
                  : 'text-grey-35 hover:text-ink hover:bg-surface-light'
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* Section content */}
        <div>
          {section === 'basics' && (
            <Card padding={20}>
              <h2 className="font-semibold text-[15px] text-ink mb-1">Basics</h2>
              <p className="text-[13px] text-grey-35 mb-4">
                Name and describe this Hiring Process. The name shows up on the candidate detail page and in analytics filters.
              </p>
              <label className="block mb-3">
                <div className="text-[12px] font-medium text-ink mb-1">Name</div>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-[10px] border border-surface-border text-[14px]"
                  placeholder="e.g. Residential Cleaner"
                />
              </label>
              <label className="block mb-3">
                <div className="text-[12px] font-medium text-ink mb-1">Description</div>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded-[10px] border border-surface-border text-[14px]"
                  placeholder="Internal notes — who this is for, what makes the journey different from other roles."
                />
              </label>
            </Card>
          )}

          {section === 'flow' && (
            <Card padding={20}>
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h2 className="font-semibold text-[15px] text-ink mb-1">Application Form</h2>
                  <p className="text-[13px] text-grey-35">
                    What the candidate fills out to apply. Required to activate.
                  </p>
                </div>
                {flowDetail && (
                  <Link
                    href={`/dashboard/flows/${flowDetail.id}/builder?view=schema`}
                    className="shrink-0 text-[12px] px-3 py-1.5 rounded-[8px] border border-surface-border text-ink hover:bg-surface-light"
                  >
                    Edit form →
                  </Link>
                )}
              </div>

              <SelectorList
                options={flows.map((f) => ({
                  id: f.id, label: f.name, hint: f.isPublished ? 'Published' : 'Draft',
                }))}
                value={flowId}
                onChange={setFlowId}
                emptyHint="No application forms yet."
                createHref="/dashboard/flows"
                createLabel="+ Create a new form"
              />

              {/* Live preview of the selected screening form. Reads the
                  same step list the candidate-facing flow uses, so the
                  recruiter sees exactly what will be asked without leaving
                  the Journey editor. */}
              {flowId && (
                <div className="mt-5 border-t border-surface-border pt-5">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35 mb-1">
                        Screening preview
                      </div>
                      <div className="font-semibold text-[14px] text-ink">
                        {flowDetail?.name || 'Loading…'}
                      </div>
                      {flowDetail && (
                        <div className="text-[12px] text-grey-35">
                          {flowDetail.steps.length} step{flowDetail.steps.length === 1 ? '' : 's'}
                          {flowDetail.isPublished
                            ? <span className="ml-2 text-green-700">· Published</span>
                            : <span className="ml-2 text-amber-700">· Draft</span>}
                        </div>
                      )}
                    </div>
                    {flowDetail && (
                      <a
                        href={`/f/${flowDetail.slug}?preview=true`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[12px] px-3 py-1.5 rounded-[8px] border border-surface-border text-ink hover:bg-surface-light"
                      >
                        Open candidate preview ↗
                      </a>
                    )}
                  </div>

                  {flowDetailLoading && (
                    <div className="text-[13px] text-grey-35 py-4 text-center">Loading screening content…</div>
                  )}
                  {!flowDetailLoading && flowDetail && flowDetail.steps.length === 0 && (
                    <div className="text-[13px] text-grey-35 py-4 text-center">
                      This form has no steps yet. <Link href={`/dashboard/flows/${flowDetail.id}/builder`} className="underline">Add some →</Link>
                    </div>
                  )}
                  {!flowDetailLoading && flowDetail && flowDetail.steps.length > 0 && (
                    <ol className="space-y-2">
                      {/* Start screen — implicit step the candidate hits
                          before any flow content. Show it so the preview
                          reads as the candidate-facing path, not the
                          internal step list. */}
                      {flowDetail.startMessage && (
                        <FlowStepCard
                          num={0}
                          kind="Welcome"
                          title="Welcome screen"
                          body={flowDetail.startMessage}
                        />
                      )}
                      {flowDetail.steps.map((step, idx) => (
                        <FlowStepCard
                          key={step.id}
                          num={idx + 1}
                          kind={stepKindLabel(step.stepType)}
                          title={step.title || stepKindLabel(step.stepType)}
                          body={renderStepBody(step)}
                          extras={renderStepExtras(step)}
                        />
                      ))}
                      {flowDetail.endMessage && (
                        <FlowStepCard
                          num={flowDetail.steps.length + 1}
                          kind="Thank you"
                          title="End screen"
                          body={flowDetail.endMessage}
                        />
                      )}
                    </ol>
                  )}
                </div>
              )}
            </Card>
          )}

          {section === 'training' && (
            <Card padding={20}>
              <h2 className="font-semibold text-[15px] text-ink mb-1">Training</h2>
              <p className="text-[13px] text-grey-35 mb-4">
                Optional. Reference an existing training so it can be selected by automations attached to this process. You still need an automation rule that actually enrolls candidates.
              </p>
              <SelectorList
                options={trainings.map((t) => ({ id: t.id, label: t.title }))}
                value={trainingId}
                onChange={setTrainingId}
                allowNone
                emptyHint="No trainings yet."
                createHref="/dashboard/trainings"
                createLabel="+ Create a training"
              />
              {trainingId && (
                <AutomationsThatEnrollHint
                  trainingId={trainingId}
                  selectedRuleIds={automationRuleIds}
                  allRules={automations}
                />
              )}
            </Card>
          )}

          {section === 'scheduling' && (
            <Card padding={20}>
              <h2 className="font-semibold text-[15px] text-ink mb-1">Scheduling</h2>
              <p className="text-[13px] text-grey-35 mb-4">
                Optional. The booking config candidates use to schedule their interview.
              </p>
              <SelectorList
                options={schedulingConfigs.map((s) => ({ id: s.id, label: s.name }))}
                value={schedulingConfigId}
                onChange={setSchedulingConfigId}
                allowNone
                emptyHint="No scheduling configs yet."
                createHref="/dashboard/scheduling"
                createLabel="+ Create a scheduling config"
              />
              {serverProcess.bookingUrlPreview && schedulingConfigId === serverProcess.schedulingConfig?.id && (
                <div className="mt-3 text-[12px] text-grey-35">
                  Booking link preview:{' '}
                  <a
                    href={serverProcess.bookingUrlPreview}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink underline"
                  >
                    {serverProcess.bookingUrlPreview}
                  </a>
                </div>
              )}
            </Card>
          )}

          {section === 'pipeline' && (
            <Card padding={20}>
              <h2 className="font-semibold text-[15px] text-ink mb-1">Pipeline</h2>
              <p className="text-[13px] text-grey-35 mb-4">
                The kanban stage list candidates flow through. Required to activate. Use the workspace default unless this role has a distinct hiring loop.
              </p>
              <SelectorList
                options={pipelines.map((p) => ({
                  id: p.id, label: p.name, hint: p.isDefault ? 'Workspace default' : undefined,
                }))}
                value={pipelineId}
                onChange={setPipelineId}
                emptyHint="No pipelines yet."
                createHref="/dashboard/pipelines"
                createLabel="+ Create a pipeline"
              />
            </Card>
          )}

          {section === 'automations' && (
            <Card padding={20}>
              <h2 className="font-semibold text-[15px] text-ink mb-1">Automations</h2>
              <p className="text-[13px] text-grey-35 mb-4">
                Pick the rules that should fire for candidates in this process. Rules still dispatch by their own trigger; this attachment is the orchestration record.
              </p>

              {allWarnings.length > 0 && (
                <div className="mb-3 px-3 py-2 rounded-[10px] bg-yellow-50 border border-yellow-200 text-yellow-800 text-[12px]">
                  Some attached rules reference stages that don&apos;t exist in the selected pipeline. They&apos;ll still fire (the engine dispatches by trigger, not stage) but the stage tag is broken:
                  <ul className="mt-1 list-disc pl-5">
                    {allWarnings.map((w) => (
                      <li key={w.ruleId}>
                        <strong>{w.ruleName}</strong> → stage <code>{w.stageId}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {automations.length === 0 ? (
                <div className="text-[13px] text-grey-35">
                  No automation rules yet. <Link href="/dashboard/automations" className="underline">Create one</Link>.
                </div>
              ) : (
                <ul className="space-y-1">
                  {automations.map((a) => {
                    const checked = automationRuleIds.includes(a.id)
                    return (
                      <li key={a.id}>
                        <label className="flex items-center gap-3 px-3 py-2 rounded-[10px] hover:bg-surface-light cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setAutomationRuleIds((cur) =>
                                e.target.checked ? [...cur, a.id] : cur.filter((x) => x !== a.id),
                              )
                            }}
                          />
                          <div className="flex-1">
                            <div className="text-[13px] font-medium text-ink">{a.name}</div>
                            <div className="text-[12px] text-grey-35">
                              Trigger: <code>{a.triggerType}</code>
                              {a.stageId && <> · Stage <code>{a.stageId}</code></>}
                              {!a.isActive && <> · <span className="text-orange-600">Disabled</span></>}
                            </div>
                          </div>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Card>
          )}

          {section === 'review' && (
            <Card padding={20}>
              <h2 className="font-semibold text-[15px] text-ink mb-1">Review</h2>
              <p className="text-[13px] text-grey-35 mb-4">
                Candidate journey summary. Activate when ready — only one active process per flow is allowed.
              </p>

              <ol className="space-y-2 mb-6">
                <ReviewRow num={1} label="Candidate applies" value={flows.find((f) => f.id === flowId)?.name} missing={!flowId ? 'Select a flow' : null} />
                <ReviewRow num={2} label="Candidate is auto-evaluated" value="Built into the flow" />
                <ReviewRow num={3} label="Training (optional)" value={trainings.find((t) => t.id === trainingId)?.title || 'None'} />
                <ReviewRow num={4} label="Books interview" value={schedulingConfigs.find((s) => s.id === schedulingConfigId)?.name || 'None'} />
                <ReviewRow num={5} label="Moves through pipeline" value={pipelines.find((p) => p.id === pipelineId)?.name} missing={!pipelineId ? 'Select a pipeline' : null} />
                <ReviewRow num={6} label="Automations send follow-ups" value={`${automationRuleIds.length} rule${automationRuleIds.length === 1 ? '' : 's'}`} />
                <ReviewRow num={7} label="Analytics track conversion" value="Filter analytics by this process" />
              </ol>

              {activationErrors.length > 0 && (
                <div className="mb-4 px-3 py-2 rounded-[10px] bg-yellow-50 border border-yellow-200 text-yellow-800 text-[13px]">
                  Before activating:
                  <ul className="list-disc pl-5 mt-1">
                    {activationErrors.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                </div>
              )}

              <div className="flex gap-2">
                {serverProcess.status !== 'active' && (
                  <Button
                    onClick={() => save({ activate: true })}
                    disabled={saving || activationErrors.length > 0}
                  >
                    {saving ? 'Working…' : 'Activate'}
                  </Button>
                )}
                {serverProcess.status === 'active' && (
                  <Button
                    onClick={() => save({ archive: true })}
                    disabled={saving}
                    variant="secondary"
                  >
                    {saving ? 'Working…' : 'Archive'}
                  </Button>
                )}
              </div>
            </Card>
          )}

          {/* Sticky save bar */}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save draft'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SelectorList({
  options,
  value,
  onChange,
  allowNone,
  emptyHint,
  createHref,
  createLabel,
}: {
  options: Array<{ id: string; label: string; hint?: string }>
  value: string | null
  onChange: (id: string | null) => void
  allowNone?: boolean
  emptyHint?: string
  createHref?: string
  createLabel?: string
}) {
  if (options.length === 0) {
    return (
      <div className="text-[13px] text-grey-35">
        {emptyHint || 'Nothing here yet.'}{' '}
        {createHref && <Link href={createHref} className="underline">{createLabel || 'Create one'}</Link>}
      </div>
    )
  }
  return (
    <>
      <ul className="space-y-1">
        {allowNone && (
          <li>
            <label className="flex items-center gap-3 px-3 py-2 rounded-[10px] hover:bg-surface-light cursor-pointer">
              <input type="radio" checked={value === null} onChange={() => onChange(null)} />
              <span className="text-[13px] text-grey-35">None</span>
            </label>
          </li>
        )}
        {options.map((o) => (
          <li key={o.id}>
            <label className="flex items-center gap-3 px-3 py-2 rounded-[10px] hover:bg-surface-light cursor-pointer">
              <input type="radio" checked={value === o.id} onChange={() => onChange(o.id)} />
              <div className="flex-1">
                <div className="text-[13px] text-ink">{o.label}</div>
                {o.hint && <div className="text-[12px] text-grey-35">{o.hint}</div>}
              </div>
            </label>
          </li>
        ))}
      </ul>
      {createHref && (
        <div className="mt-2 text-[12px]">
          <Link href={createHref} className="text-grey-35 hover:text-ink underline">
            {createLabel || 'Create new'}
          </Link>
        </div>
      )}
    </>
  )
}

function AutomationsThatEnrollHint({
  trainingId,
  selectedRuleIds,
  allRules,
}: {
  trainingId: string
  selectedRuleIds: string[]
  allRules: AutomationOption[]
}) {
  // Detect attached automations that "send the training". We can't see
  // AutomationRule.trainingId here without an extra fetch — but the rule's
  // triggerType + name hint is enough for an at-a-glance heuristic. We surface
  // every attached rule with triggerType referencing training, which the spec
  // calls for: "show which automation sends/enrolls it if detectable".
  const candidates = allRules.filter(
    (r) => selectedRuleIds.includes(r.id) && /training/i.test(r.triggerType),
  )
  if (candidates.length === 0) {
    return (
      <div className="mt-3 text-[12px] text-grey-35">
        No attached automation currently references training. The recruiter will need to enroll candidates manually unless you add a rule (e.g. send training after flow_completed).
      </div>
    )
  }
  return (
    <div className="mt-3 text-[12px] text-grey-35">
      Likely training-related rules attached: {candidates.map((c) => c.name).join(', ')}.
    </div>
  )
}

function ReviewRow({
  num,
  label,
  value,
  missing,
}: {
  num: number
  label: string
  value?: string
  missing?: string | null
}) {
  return (
    <li className="flex items-center gap-3 text-[13px]">
      <div className="w-6 h-6 rounded-full bg-surface-border flex items-center justify-center font-medium text-grey-35">{num}</div>
      <div className="flex-1">
        <div className="font-medium text-ink">{label}</div>
        <div className={missing ? 'text-orange-600' : 'text-grey-35'}>
          {missing || value || '—'}
        </div>
      </div>
    </li>
  )
}

// Individual block rendered in the visual journey flow at the top of the
// editor. Click jumps to the relevant section in the editor below.
function JourneyBlock({
  label,
  entity,
  missing,
  wip,
  onClick,
}: {
  label: string
  entity?: string
  missing?: boolean
  wip?: boolean
  onClick?: () => void
}) {
  const interactive = !!onClick && !wip
  return (
    <button
      onClick={onClick}
      disabled={!interactive}
      className={`flex flex-col items-start text-left min-w-[140px] px-3 py-2 rounded-[10px] border transition-colors ${
        wip
          ? 'border-dashed border-grey-35 bg-surface-light cursor-not-allowed'
          : missing
            ? 'border-dashed border-orange-300 bg-orange-50 hover:bg-orange-100'
            : 'border-surface-border bg-white hover:bg-surface-light'
      }`}
    >
      <span className={`font-mono text-[10px] uppercase tracking-[0.08em] ${wip ? 'text-grey-50' : 'text-grey-35'}`}>
        {label}
      </span>
      <span className={`text-[13px] font-medium mt-0.5 ${wip ? 'text-grey-35' : missing ? 'text-orange-700' : 'text-ink'}`}>
        {wip ? 'Not configured' : missing ? 'Pick one →' : entity || '—'}
      </span>
      {wip && (
        <span className="mt-1">
          <WipBadge label="WIP" />
        </span>
      )}
    </button>
  )
}

function Connector() {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" className="text-grey-50 shrink-0">
      <path d="M2 7h14m0 0l-4-4m4 4l-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Maps the technical stepType enum to a candidate-friendly label. Same
// vocabulary the Application Form section uses elsewhere in this PR.
function stepKindLabel(stepType: string): string {
  switch (stepType) {
    case 'video':    return 'Video answer'
    case 'question': return 'Question'
    case 'form':     return 'Form'
    case 'screen':   return 'Info screen'
    default:         return stepType
  }
}

// Render the primary body of a step in the preview. Question text wins;
// otherwise fall back to the infoContent block for screen steps. Returns a
// string the FlowStepCard truncates.
function renderStepBody(step: FlowDetailStep): string {
  if (step.questionText && step.questionText.trim()) return step.questionText
  if (step.stepType === 'screen' && step.infoContent) return step.infoContent
  if (step.stepType === 'form') return 'Custom form fields below.'
  if (step.stepType === 'video') return 'Candidate records a video answer.'
  return ''
}

// Pull form fields + multiple-choice options out as compact chip strips.
// Anything we can render in 1-2 lines per step belongs here so the preview
// reads as "what the candidate will see" rather than a list of step names.
function renderStepExtras(step: FlowDetailStep): React.ReactNode {
  const out: React.ReactNode[] = []
  if (step.options && step.options.length > 0) {
    out.push(
      <div key="opts" className="mt-2 flex flex-wrap gap-1.5">
        {step.options.slice(0, 8).map((o) => (
          <span key={o.id} className="text-[11px] px-2 py-0.5 rounded-full bg-surface-light border border-surface-border text-ink">
            {o.optionText}
          </span>
        ))}
        {step.options.length > 8 && (
          <span className="text-[11px] text-grey-35">+{step.options.length - 8} more</span>
        )}
      </div>,
    )
  }
  if (step.formEnabled && step.formConfig?.fields && step.formConfig.fields.length > 0) {
    out.push(
      <div key="form" className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-1.5 text-[12px]">
        {step.formConfig.fields.map((f, i) => (
          <div key={f.id || i} className="px-2 py-1 rounded-[6px] bg-surface-light border border-surface-border text-ink truncate">
            <span className="text-grey-35 mr-1">{f.type || 'text'}:</span>
            {f.label || '—'}
            {f.required && <span className="text-orange-600 ml-1">*</span>}
          </div>
        ))}
      </div>,
    )
  }
  return out.length > 0 ? <>{out}</> : null
}

function FlowStepCard({
  num,
  kind,
  title,
  body,
  extras,
}: {
  num: number
  kind: string
  title: string
  body?: string
  extras?: React.ReactNode
}) {
  return (
    <li className="flex gap-3 px-3 py-3 rounded-[10px] border border-surface-border bg-white">
      <div className="shrink-0 w-7 h-7 rounded-full bg-surface-light border border-surface-border flex items-center justify-center font-mono text-[11px] text-grey-35 tabular-nums">
        {num}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-grey-35">{kind}</span>
        </div>
        <div className="font-medium text-[13px] text-ink">{title}</div>
        {body && (
          <div className="text-[12px] text-grey-35 mt-0.5 whitespace-pre-line line-clamp-3">{body}</div>
        )}
        {extras}
      </div>
    </li>
  )
}

// One row in the Available blocks panel on the right.
function BlockOption({
  label,
  available,
  wipReason,
  onClick,
}: {
  label: string
  available?: boolean
  wipReason?: string
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={!available}
      title={wipReason || undefined}
      className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-[8px] text-[12px] text-left transition-colors ${
        available
          ? 'text-ink hover:bg-surface-light'
          : 'text-grey-35 cursor-not-allowed'
      }`}
    >
      <span className="truncate">{label}</span>
      {!available && <WipBadge label="WIP" />}
    </button>
  )
}
