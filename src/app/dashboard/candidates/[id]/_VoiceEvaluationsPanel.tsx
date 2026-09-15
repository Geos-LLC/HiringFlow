/**
 * Candidate detail — Voice Evaluations (unified wrapper).
 *
 * Single card that hosts BOTH sub-panels the recruiter needs on the
 * candidate page:
 *
 *   - AI Customer Simulations   (MockCustomer-driven test calls)
 *   - AI Training Calls & Evaluation (HireFunnel's legacy training + JD scoring)
 *
 * Historically these lived in two separate cards which read as
 * "why are there two different things for the same job?" Real user
 * feedback. Wrapping both under one visual container fixes that
 * without touching either sub-panel's internal data model — each
 * still owns its own fetching, actions, and rendering. The sub-panels
 * accept a `chromeless` prop that skips their own outer card so we
 * don't end up with nested boxes.
 *
 * MC simulations render first because that's the newer, canary-gated
 * path and it hides itself entirely when a workspace isn't connected —
 * so on non-connected workspaces the card visually reduces to just
 * "AI Training Calls & Evaluation", matching the pre-integration UX.
 *
 * A deeper unification (merging both data models into one timeline of
 * rows sorted by createdAt, with a single "+ Add" action menu) is a
 * separate follow-up — that requires reconciling AICallCandidate +
 * McSimulation into a common shape and rewriting both sub-panels'
 * action affordances. This wrapper is Phase 1: visual + product framing.
 */

'use client'

import { AICallsPanel } from './_AICallsPanel'
import { McSimulationsPanel } from './_McSimulationsPanel'

interface Props {
  sessionId: string
  candidateName: string | null
}

export function VoiceEvaluationsPanel({ sessionId, candidateName }: Props) {
  return (
    <div className="bg-white rounded-[12px] border border-surface-border p-6 mb-6">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-grey-15">Voice Evaluations</h3>
        <p className="text-[12px] text-grey-50 mt-0.5">
          Every voice test for this candidate — AI customer simulations, training calls, and JD-based
          evaluation scoring.
        </p>
      </div>

      {/* Section 1: AI Customer Simulations (MockCustomer). Self-hides when
          the workspace isn't connected to MC (returns null), so the visual
          divider below is only useful when this section actually renders. */}
      <McSimulationsPanel sessionId={sessionId} candidateName={candidateName} chromeless />

      {/* Visual divider between the two sub-panels. Absent on the initial
          load flicker because both sub-panels handle their own loading
          states, and the McSimulationsPanel may render null entirely for
          non-canary workspaces. */}
      <div className="my-6 border-t border-surface-divider" />

      {/* Section 2: AI Training Calls & Evaluation (legacy HF). Owns
          agent linking, call-link creation, and the JD evaluation flow. */}
      <AICallsPanel sessionId={sessionId} candidateName={candidateName} chromeless />
    </div>
  )
}
