/**
 * Provider-neutral seam for new simulation launches. Deliberately narrow
 * — the goal is a single boundary that new simulation providers plug
 * into, NOT a rewrite of HF's legacy AICall* subsystem. Legacy AICall*
 * code stays where it is; it does not implement this interface and is
 * not routed through here.
 *
 * PR1B ships a single implementation: McSimulationRunner. When we
 * eventually retire AICall* (separate approval per project brief), a
 * second runner may join; the interface stays this narrow until that
 * conversation happens.
 */

export interface LaunchSimulationInput {
  workspaceId: string
  candidateId: string // HF Session.id
  launchedByUserId: string
  // No scenario/persona selector in PR1B. Runners use the mapped MC
  // organization's default configuration.
}

export interface LaunchSimulationResult {
  simulationId: string
  status: string
  mcCallId: string | null
}

export interface SimulationRunner {
  launch(input: LaunchSimulationInput): Promise<LaunchSimulationResult>
}

// -----------------------------------------------------------------------------
// Failure taxonomy — surface stable reason strings the launch route can
// map to HTTP status codes. All non-`internal` reasons carry a
// recruiter-facing message; `internal` is opaque + logged loud.
// -----------------------------------------------------------------------------

export class SimulationLaunchError extends Error {
  reason:
    | 'candidate_not_found'
    | 'candidate_wrong_workspace'
    | 'mc_not_configured'
    | 'canary_disabled'
    | 'candidate_missing_phone'
    | 'mc_dial_rejected'
    | 'mc_timeout'
    | 'internal'
  detail?: string
  upstream?: unknown
  constructor(
    reason: SimulationLaunchError['reason'],
    message: string,
    detail?: string,
    upstream?: unknown,
  ) {
    super(message)
    this.name = 'SimulationLaunchError'
    this.reason = reason
    this.detail = detail
    this.upstream = upstream
  }
}
