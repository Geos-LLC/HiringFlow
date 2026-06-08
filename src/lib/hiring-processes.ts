/**
 * HiringProcess — orchestration layer that connects an existing Flow,
 * Training, SchedulingConfig, Pipeline, and AutomationRule[] under one
 * recruiter-facing "recruiting journey for a role" object.
 *
 * This module owns the business rules that the API routes and the candidate-
 * attach path both depend on. Keeping them here means the contract stays in
 * one place — no drift between "the editor blocked activation" and "the
 * candidate path silently attached an archived process".
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import { normalizeStages } from './funnel-stages'

export type HiringProcessStatus = 'draft' | 'active' | 'archived'

export function isHiringProcessStatus(v: unknown): v is HiringProcessStatus {
  return v === 'draft' || v === 'active' || v === 'archived'
}

export interface ActivateValidationInput {
  flowId: string | null | undefined
  pipelineId: string | null | undefined
}

/**
 * A process can only enter `active` if it has both a Flow (the entry point
 * candidates apply through) and a Pipeline (the stage list they flow
 * through). Training and SchedulingConfig are optional — a Cleaner process
 * has both; a Dispatcher process might skip Training.
 *
 * Returns an array of human-readable errors. Empty array = OK to activate.
 */
export function validateActivate(input: ActivateValidationInput): string[] {
  const errors: string[] = []
  if (!input.flowId) errors.push('Select a Screening Flow before activating.')
  if (!input.pipelineId) errors.push('Select a Pipeline before activating.')
  return errors
}

/**
 * Stage-reference validation. AutomationRule.stageId is a plain string keyed
 * to Pipeline.stages[*].id — not a FK — so it's possible to wire a rule that
 * references a stage that doesn't exist in the selected pipeline. The editor
 * surfaces this as a warning (not an error) because the rule still dispatches
 * by triggerType — stageId is metadata. But the recruiter almost always wants
 * to fix it, so we flag it explicitly.
 *
 * Returns the subset of rules with a problematic stageId, paired with the
 * stageId in question. Rules without a stageId are fine.
 */
export interface StageWarning {
  ruleId: string
  ruleName: string
  stageId: string
}

export function findStageReferenceWarnings(
  rules: Array<{ id: string; name: string; stageId: string | null }>,
  pipelineStages: unknown,
): StageWarning[] {
  const stages = normalizeStages(pipelineStages)
  const stageIds = new Set(stages.map((s) => s.id))
  const warnings: StageWarning[] = []
  for (const r of rules) {
    if (r.stageId && !stageIds.has(r.stageId)) {
      warnings.push({ ruleId: r.id, ruleName: r.name, stageId: r.stageId })
    }
  }
  return warnings
}

/**
 * Returns the active HiringProcess for a given flow in a given workspace, or
 * null if none. If multiple are accidentally active (the unique constraint is
 * enforced at the app layer; nothing prevents a race-condition double-write)
 * we return null and let the caller log a warning — better to fall through
 * than to attach an arbitrary process.
 *
 * Used by /api/public/sessions at session-create time to set Session.processId.
 */
export async function findActiveProcessForFlow(
  prisma: PrismaClient | Prisma.TransactionClient,
  args: { workspaceId: string; flowId: string },
): Promise<{ id: string } | null> {
  const rows = await prisma.hiringProcess.findMany({
    where: {
      workspaceId: args.workspaceId,
      flowId: args.flowId,
      status: 'active',
    },
    select: { id: true },
    take: 2,
  })
  if (rows.length === 1) return rows[0]
  return null
}

/**
 * Returns true iff activating/creating a process with flowId would violate
 * the "one active per flow per workspace" rule. Excludes the process being
 * edited (excludeProcessId) so a save that doesn't change flowId stays valid.
 */
export async function hasConflictingActiveProcessOnFlow(
  prisma: PrismaClient | Prisma.TransactionClient,
  args: { workspaceId: string; flowId: string; excludeProcessId?: string },
): Promise<boolean> {
  const existing = await prisma.hiringProcess.findFirst({
    where: {
      workspaceId: args.workspaceId,
      flowId: args.flowId,
      status: 'active',
      ...(args.excludeProcessId ? { id: { not: args.excludeProcessId } } : {}),
    },
    select: { id: true },
  })
  return !!existing
}
