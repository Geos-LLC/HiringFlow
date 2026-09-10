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
  /**
   * Client-generated request idempotency key. The recruiter UI mints
   * a UUID before POSTing and reuses it on any retry-with-same-intent
   * (network hiccup, double-click, browser back button). The runner
   * dedups by `(workspaceId, launchRequestId)`: a duplicate/concurrent
   * launch returns the SAME McSimulation and does NOT dial MC twice.
   *
   * Required in production paths. Left optional at the type level so
   * legacy internal callers (Flow automation in PR2, one-off scripts)
   * can opt in incrementally — but a null value degrades to
   * "no launch-level dedup," so callers with any concurrency risk
   * must supply one.
   */
  launchRequestId?: string | null
}

export interface LaunchSimulationResult {
  simulationId: string
  status: string
  mcCallId: string | null
  /**
   * True when the runner reused an existing McSimulation instead of
   * creating a new one. Lets the API/UI distinguish a fresh launch
   * from a duplicate — telemetry only, no functional effect on the
   * response shape.
   */
  reusedExisting: boolean
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
    | 'launch_request_id_conflict'
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
