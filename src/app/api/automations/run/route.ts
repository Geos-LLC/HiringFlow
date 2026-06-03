import { NextRequest, NextResponse } from 'next/server'
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs'
import { executeRule, executeStep } from '@/lib/automation'

export const maxDuration = 60

/**
 * QStash delayed-callback handler. Every queued automation step eventually
 * lands here when its delay elapses. The handler re-loads session/rule/step
 * state from the DB and runs the same central guard the immediate-dispatch
 * path uses — so a step that was eligible at enqueue time but stopped being
 * eligible by callback time (candidate became stalled, lost, hired,
 * rescheduled, completed prereqs invalidated) is skipped at the door, not
 * silently sent.
 *
 * Always 200 on guard skips: QStash retries non-2xx responses, and a guard
 * skip is a successful business outcome (the row gets a `skipped_*` status
 * for the audit trail). Only true infrastructure errors (DB unreachable,
 * code exception) return 5xx so QStash will retry.
 */
async function handler(request: NextRequest) {
  const trace: string[] = []
  try {
    const body = await request.text()
    trace.push(`body=${body.slice(0, 300)}`)
    const payload = JSON.parse(body || '{}')
    trace.push(`parsed payload=${JSON.stringify(payload)}`)

    // New step-shaped messages: { stepId, sessionId, channel, triggerType?, triggerContext? }
    // triggerType/triggerContext were threaded through at enqueue time by
    // queueStepAtDelay so the guard can re-evaluate the original trigger
    // context (e.g. trainingId for training_completed prerequisites) instead
    // of having to re-derive it from the rule alone.
    if (payload.stepId && payload.sessionId) {
      const channel = payload.channel === 'sms' ? 'sms' : 'email'
      await executeStep(payload.stepId, payload.sessionId, channel, {
        dispatchCtx: {
          triggerType: typeof payload.triggerType === 'string' ? payload.triggerType : 'unknown',
          triggerContext: typeof payload.triggerContext === 'object' && payload.triggerContext !== null
            ? payload.triggerContext
            : undefined,
          executionMode: 'delayed_callback',
          // Rehydrate the StageEntry pin set by queueStepAtDelay so the
          // delayed send's idempotency and execution row land on the same
          // StageEntry as the enqueue-time decision. Missing/null in the
          // payload for raw-event triggers; required for stage_entered.
          stageEntryId: typeof payload.stageEntryId === 'string' ? payload.stageEntryId : null,
          // Rehydrate the pre-applyStageTrigger pipelineStatus snapshot.
          // Without this, a rule pinned to the candidate's stage-at-trigger-
          // time fails the guard's delayed-callback stage check whenever the
          // trigger event auto-advanced them off that stage.
          triggerStageSnapshot: typeof payload.triggerStageSnapshot === 'string'
            ? payload.triggerStageSnapshot
            : null,
        },
      })
      trace.push('executeStep returned')
      return NextResponse.json({ ok: true, trace })
    }

    // Legacy rule-shaped messages still in flight: { ruleId, sessionId }.
    // We fan out to every step and every channel under the rule. This is a
    // best-effort safety net; new dispatches always use the step shape.
    // executionMode='delayed_callback' so the guard reads fresh state.
    if (payload.ruleId && payload.sessionId) {
      await executeRule(payload.ruleId, payload.sessionId, {
        dispatchCtx: {
          triggerType: 'unknown',
          executionMode: 'delayed_callback',
        },
      })
      trace.push('executeRule (legacy shape) returned')
      return NextResponse.json({ ok: true, trace })
    }

    return NextResponse.json({ error: 'missing stepId/sessionId or ruleId/sessionId', trace }, { status: 400 })
  } catch (err: any) {
    console.error('[Automation /run] Error:', err)
    trace.push(`error=${err?.message || String(err)}`)
    return NextResponse.json({ error: 'Execution failed', trace }, { status: 500 })
  }
}

export const POST = process.env.QSTASH_CURRENT_SIGNING_KEY
  ? verifySignatureAppRouter(handler)
  : handler
