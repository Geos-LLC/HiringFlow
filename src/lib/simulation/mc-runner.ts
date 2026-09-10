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

import type { PrismaClient } from '@prisma/client'
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
    const simulationId = makeId()
    const nowDate = now()
    await this.deps.prisma.mcSimulation.create({
      data: {
        id: simulationId,
        workspaceId: input.workspaceId,
        candidateId: input.candidateId,
        launchedByUserId: input.launchedByUserId,
        mcOrganizationId: mapping.mcOrganizationId,
        status: 'queued',
        queuedAt: nowDate,
      },
    })

    // 4. Dial MC. Any error here leaves the row visible in the UI as
    //    failed with a recruiter-facing reason. Row identity (id) is
    //    already reserved for correlation.
    const cfg =
      this.deps.mcClientOverride ??
      buildMcClientConfig({
        apiKey: mapping.mcApiKey,
        fetchImpl: this.deps.fetchImpl,
      })
    try {
      const dialResp = await mcDial(cfg, {
        destinationPhone: candidate.candidatePhone,
        clientReferenceId: simulationId,
        idempotencyKey: simulationId,
        callbackUrl: this.deps.webhookCallbackUrl,
        personaContext: DEFAULT_DESTINATION_PERSONA,
      })
      await this.deps.prisma.mcSimulation.update({
        where: { id: simulationId },
        data: {
          mcCallId: dialResp.callId,
        },
      })
      return {
        simulationId,
        status: 'queued',
        mcCallId: dialResp.callId,
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
      await this.deps.prisma.mcSimulation.update({
        where: { id: simulationId },
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
