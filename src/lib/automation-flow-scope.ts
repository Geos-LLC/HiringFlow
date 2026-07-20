/**
 * Flow scoping for AutomationRule matching.
 *
 * Every rule lookup that's about "what should fire for this candidate?" must
 * filter by the candidate's flow so a rule scoped to flows A + B doesn't fire
 * against a candidate submitting flow C. The multi-flow scope is stored on
 * the AutomationRuleFlow join table (see prisma/schema.prisma). The match
 * condition is:
 *
 *   rule.flows IS EMPTY (workspace-wide)
 *     OR
 *   candidate's flowId IS IN rule.flows[].flowId
 *
 * Rules with an empty flows set are the "any flow" equivalent — the same
 * semantics the pre-join `flowId=null` column carried. New rules created via
 * the UI default to empty (workspace-wide) unless the recruiter picks flows.
 *
 * This module mirrors the pipeline-scope helper structure so the two scope
 * dimensions can be composed inside the same AND list at each dispatch site.
 */

// Prisma where fragment matching AutomationRule rows scoped to a specific
// candidate flow. Composes inside `AND: [...]` alongside pipelineScopeFragment
// and any trigger-specific filters.
export interface FlowScopeFragment {
  OR: Array<
    | { flows: { none: Record<string, never> } }
    | { flows: { some: { flowId: string } } }
  >
}

// Build the OR clause matching rules whose flow scope is empty (workspace-wide)
// or explicitly includes the candidate's flowId. Callers push this onto the
// AND list of an AutomationRule query.
export function flowScopeFragment(candidateFlowId: string): FlowScopeFragment {
  return {
    OR: [
      { flows: { none: {} } },
      { flows: { some: { flowId: candidateFlowId } } },
    ],
  }
}

// Reverse direction: given a rule's flows list (as loaded from Prisma),
// build an InterviewMeeting `where` fragment restricting to meetings whose
// session belongs to one of the scoped flows. Empty scope → no filter
// (workspace-wide rule matches every meeting). Used by
// autoBackfillRuleForUpcomingMeetings when a rule is created/edited and we
// need to enumerate the meetings it would now apply to.
export function flowScopeForMeetingsWhere(
  ruleFlows: Array<{ flowId: string }>,
): Record<string, never> | { session: { flowId: { in: string[] } } } {
  if (ruleFlows.length === 0) return {}
  return { session: { flowId: { in: ruleFlows.map((f) => f.flowId) } } }
}
