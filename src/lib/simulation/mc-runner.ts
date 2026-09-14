/**
 * MC-backed simulation launcher.
 *
 * Sequencing (load-bearing — fixes the webhook-before-response race):
 *   1. Load + validate the candidate belongs to the workspace.
 *   2. Load + validate the McWorkspaceMapping is canary-enabled.
 *   3. CREATE the McSimulation row BEFORE dialing MC. The row's `id`
 *      becomes both the MC `Idempotency-Key` header AND the request-body
 *      `clientReferenceId`. This means MC can echo `clientReferenceId`
 *      back in a webhook that races the dial's HTTP response, and the
 *      webhook receiver already has a row to look up.
 *   4. Dial MC.
 *   5. On success, patch `mcCallId` onto the row. On failure, mark the
 *      row as terminal-failed with a stable reason string so the UI
 *      surfaces it clearly.
 *
 * MC failure paths are strictly local: the McSimulation row moves to
 * `failed`, but NO candidate/Session state, pipeline stage,
 * AICallCandidate, Interview, or Training row is created or mutated.
 * That posture is enforced by keeping this runner from touching any
 * table other than McSimulation and McWorkspaceMapping.
 */

import { Prisma, type PrismaClient } from '@prisma/client'
import { resolveMcMapping } from '../mockcustomer/mapping'
import {
  buildMcClientConfig,
  mcDial,
  McApiError,
  type DialInput,
  type McClientConfig,
} from '../mockcustomer/client'
import {
  SimulationLaunchError,
  type LaunchSimulationInput,
  type LaunchSimulationResult,
  type SimulationRunner,
} from './runner'

export interface McSimulationRunnerDeps {
  prisma: Pick<PrismaClient, 'mcWorkspaceMapping' | 'mcSimulation' | 'session'>
  /** Absolute URL where MC will POST webhooks (per-env). */
  webhookCallbackUrl: string
  /** Test seams. */
  now?: () => Date
  makeId?: () => string
  /** Injected for tests; production callers use real fetch. */
  mcClientOverride?: McClientConfig
  fetchImpl?: typeof fetch
}

const DEFAULT_DESTINATION_PERSONA = {
  businessName: 'HireFunnel',
  businessIndustry: 'Recruiting',
  businessSummary:
    'HireFunnel is a hiring platform running an AI-driven candidate screening simulation. This call is part of a recruiter-initiated test.',
  leadRequestDetails:
    'Recruiter has requested a MockCustomer voice simulation for this candidate.',
  priorConversation: [] as DialInput['personaContext']['priorConversation'],
}

export class McSimulationRunner implements SimulationRunner {
  constructor(private readonly deps: McSimulationRunnerDeps) {}

  async launch(input: LaunchSimulationInput): Promise<LaunchSimulationResult> {
    const now = this.deps.now ?? (() => new Date())
    const makeId = this.deps.makeId ?? (() => crypto.randomUUID())

    // 1. Candidate + workspace scoping. `session` is HF's row for what
    //    the UI calls a candidate; the workspaceId filter here is a
    //    hard security boundary — a cross-workspace request must 404.
    const candidate = await this.deps.prisma.session.findFirst({
      where: { id: input.candidateId, workspaceId: input.workspaceId },
      select: {
        id: true,
        candidateName: true,
        candidateEmail: true,
        candidatePhone: true,
      },
    })
    if (!candidate) {
      throw new SimulationLaunchError(
        'candidate_not_found',
        'Candidate not found in this workspace',
      )
    }
    if (!candidate.candidatePhone) {
      throw new SimulationLaunchError(
        'candidate_missing_phone',
        'Candidate has no phone number recorded — MockCustomer needs a destination number to dial.',
      )
    }

    // 2. MC mapping + canary gate.
    const mappingResult = await resolveMcMapping(this.deps.prisma, input.workspaceId)
    if (!mappingResult.ok) {
      throw new SimulationLaunchError(
        mappingResult.reason === 'not_configured' ? 'mc_not_configured' : 'canary_disabled',
        mappingResult.reason === 'not_configured'
          ? 'MockCustomer is not configured for this workspace.'
          : 'MockCustomer simulations are disabled for this workspace (canary flag off).',
      )
    }
    const mapping = mappingResult.mapping

    // 3. Create the McSimulation row FIRST. row.id doubles as MC's
    //    Idempotency-Key + clientReferenceId. Committing before the
    //    outbound dial guarantees the webhook receiver has a row to
    //    look up even if MC's webhook races HF's DB write of mcCallId.
    //
    //    LAUNCH-LEVEL IDEMPOTENCY:
    //    When the caller supplies `launchRequestId`, we dedup on
    //    `(workspaceId, launchRequestId)` via the unique constraint.
    //    A duplicate/concurrent POST → try-insert throws P2002 → we
    //    re-query and reuse the existing row (returning its mcCallId
    //    from whatever the original launch already got). This closes
    //    the double-click / retry-after-loss / two-parallel-requests
    //    race that MC's per-callId idempotency alone cannot cover.
    const simulationId = makeId()
    const nowDate = now()
    let created = true
    let effectiveRow: {
      id: string
      candidateId: string
      mcCallId: string | null
      status: string
    }
    try {
      const inserted = await this.deps.prisma.mcSimulation.create({
        data: {
          id: simulationId,
          workspaceId: input.workspaceId,
          candidateId: input.candidateId,
          launchedByUserId: input.launchedByUserId,
          mcOrganizationId: mapping.mcOrganizationId,
          status: 'queued',
          queuedAt: nowDate,
          launchRequestId: input.launchRequestId ?? null,
        },
      })
      effectiveRow = {
        id: inserted.id,
        candidateId: inserted.candidateId,
        mcCallId: inserted.mcCallId,
        status: inserted.status,
      }
    } catch (err) {
      // Only reuse-on-conflict when the caller opted in via
      // launchRequestId AND the conflict was on that key. Any other
      // constraint failure is a real error.
      const isLaunchReqConflict =
        input.launchRequestId &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        // meta.target is either a string (older Prisma) or string[]
        (function () {
          const t = (err.meta as { target?: unknown } | undefined)?.target
          if (!t) return true // best-effort — assume it's ours
          if (typeof t === 'string') {
            return t.includes('launch_request_id') || t.includes('workspace_launch_request_unique')
          }
          if (Array.isArray(t)) {
            return t.some(
              (x) => typeof x === 'string' && (x.includes('launch_request_id') || x.includes('workspaceId')),
            )
          }
          return false
        })()
      if (!isLaunchReqConflict) throw err

      // Duplicate/concurrent launch — find the winning row.
      const existing = await this.deps.prisma.mcSimulation.findFirst({
        where: {
          workspaceId: input.workspaceId,
          launchRequestId: input.launchRequestId!,
        },
        select: { id: true, candidateId: true, mcCallId: true, status: true },
      })
      if (!existing) {
        // Extremely rare — the conflicting row was deleted between
        // insert-fail and re-fetch. Bubble as internal so ops sees it.
        throw new SimulationLaunchError(
          'internal',
          'launchRequestId conflict but no existing row found',
          undefined,
          err,
        )
      }
      // Cross-candidate reuse is a client-side error — the same UUID
      // should not appear under two different candidates. Reject
      // loudly rather than silently returning the other candidate's
      // simulation (which would leak existence).
      if (existing.candidateId !== input.candidateId) {
        throw new SimulationLaunchError(
          'launch_request_id_conflict',
          'launchRequestId is already bound to a different candidate in this workspace',
        )
      }
      created = false
      effectiveRow = existing
    }

    // 4. Decide whether to dial. Three cases:
    //    - Fresh row (created=true): always dial.
    //    - Reused row with mcCallId already set: the winning launch's
    //      dial succeeded and patched mcCallId. Nothing to do — return
    //      the existing row's state.
    //    - Reused row already terminal: the winning launch reached its
    //      terminal (via webhooks or a prior dial that recorded failure).
    //      Dialing would be wrong; return the existing state.
    //    - Reused row with mcCallId==null AND non-terminal: STRANDED —
    //      the winning launch crashed between row-create and mcCallId
    //      persist. Retry dial using the EXISTING simulationId as MC's
    //      Idempotency-Key + clientReferenceId. MC's own idempotency
    //      guarantees the same physical ExternalCall (returns cached
    //      callId if it already dialed; dials fresh if the crashed
    //      request never reached MC).
    const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
    const rowTerminal = TERMINAL_STATUSES.has(effectiveRow.status)
    if (!created && (effectiveRow.mcCallId || rowTerminal)) {
      return {
        simulationId: effectiveRow.id,
        status: effectiveRow.status,
        mcCallId: effectiveRow.mcCallId,
        reusedExisting: true,
      }
    }

    // 5. Dial MC. Uses `effectiveRow.id` (fresh-created id OR reused
    //    existing id) — that value is what MC receives as the
    //    Idempotency-Key AND clientReferenceId. A resumed stranded
    //    launch therefore hits MC with the SAME key as the original,
    //    so MC's per-request idempotency returns the same ExternalCall
    //    rather than creating a second physical call.
    const dialCallId = effectiveRow.id
    const cfg =
      this.deps.mcClientOverride ??
      buildMcClientConfig({
        apiKey: mapping.mcApiKey,
        fetchImpl: this.deps.fetchImpl,
      })
    try {
      const dialResp = await mcDial(cfg, {
        destinationPhone: candidate.candidatePhone,
        clientReferenceId: dialCallId,
        idempotencyKey: dialCallId,
        callbackUrl: this.deps.webhookCallbackUrl,
        personaContext: DEFAULT_DESTINATION_PERSONA,
      })
      // Patch/backfill mcCallId. On the resume path the row's
      // mcCallId may already be null (that's what put us here) — the
      // updateMany with `mcCallId: null` guard prevents overwriting a
      // concurrently-back-filled value that snuck in via the webhook
      // receiver between our findFirst and now.
      if (created) {
        await this.deps.prisma.mcSimulation.update({
          where: { id: dialCallId },
          data: { mcCallId: dialResp.callId },
        })
      } else {
        // Reused row — do NOT clobber a value that a concurrent
        // webhook may have back-filled between our conflict lookup
        // and this write.
        await this.deps.prisma.mcSimulation.updateMany({
          where: { id: dialCallId, mcCallId: null },
          data: { mcCallId: dialResp.callId },
        })
      }
      return {
        simulationId: dialCallId,
        status: created ? 'queued' : effectiveRow.status,
        mcCallId: dialResp.callId,
        reusedExisting: !created,
      }
    } catch (err) {
      const isTimeout =
        err instanceof Error &&
        (err.name === 'AbortError' || /timeout/i.test(err.message))
      const isApi = err instanceof McApiError
      const reason: SimulationLaunchError['reason'] = isTimeout
        ? 'mc_timeout'
        : isApi
          ? 'mc_dial_rejected'
          : 'internal'
      const detail = isApi
        ? `MC ${err.status} — ${
            typeof err.body === 'string'
              ? err.body.slice(0, 500)
              : JSON.stringify(err.body).slice(0, 500)
          }`
        : err instanceof Error
          ? err.message
          : String(err)
      // Only stamp `failed` when the row is still pre-terminal —
      // matches applyMcSimulationState's ladder posture. A concurrent
      // webhook that already advanced the row to terminal must not be
      // clobbered by this failure branch.
      await this.deps.prisma.mcSimulation.updateMany({
        where: { id: dialCallId, status: { in: ['queued', 'ringing', 'in_progress'] } },
        data: {
          status: 'failed',
          failedAt: now(),
          failureReason:
            reason === 'mc_timeout'
              ? 'mc_timeout'
              : reason === 'mc_dial_rejected'
                ? 'mc_dial_rejected'
                : 'internal',
        },
      })
      throw new SimulationLaunchError(
        reason,
        reason === 'mc_timeout'
          ? 'MockCustomer did not respond in time. Try again in a moment.'
          : reason === 'mc_dial_rejected'
            ? 'MockCustomer rejected the dial request.'
            : 'Unexpected error launching MockCustomer simulation.',
        detail,
        err,
      )
    }
  }
}
