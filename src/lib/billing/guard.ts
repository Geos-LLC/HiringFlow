import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'
import {
  type PlanTier,
  type PlanLimits,
  PLAN_TIERS,
  PLAN_LIMITS,
  limitsForTier,
} from './plans'

// Treat these statuses as "subscription gives you access". Past_due gives a
// grace window — Stripe retries for ~3 weeks before flipping to canceled.
const ACCESS_STATUSES = new Set([
  'trialing',
  'active',
  'past_due',
])

export interface EffectivePlan {
  tier: PlanTier
  limits: PlanLimits
  status: string | null
  inTrial: boolean
  trialEndsAt: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
}

// Single source of truth: read the workspace, decide what tier they actually
// get. If subscriptionStatus is canceled / unpaid / null, downgrade to free
// regardless of what Workspace.plan still says.
export async function getEffectivePlan(workspaceId: string): Promise<EffectivePlan> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      plan: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
    },
  })
  if (!ws) {
    return {
      tier: 'free',
      limits: limitsForTier('free'),
      status: null,
      inTrial: false,
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    }
  }
  const hasAccess = ws.subscriptionStatus && ACCESS_STATUSES.has(ws.subscriptionStatus)
  const tier: PlanTier = hasAccess && PLAN_TIERS.includes(ws.plan as PlanTier)
    ? (ws.plan as PlanTier)
    : 'free'
  return {
    tier,
    limits: limitsForTier(tier),
    status: ws.subscriptionStatus,
    inTrial: ws.subscriptionStatus === 'trialing',
    trialEndsAt: ws.trialEndsAt,
    currentPeriodEnd: ws.currentPeriodEnd,
    cancelAtPeriodEnd: ws.cancelAtPeriodEnd,
  }
}

const TIER_RANK: Record<PlanTier, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  enterprise: 3,
}

// Returns true if the workspace's effective tier is >= required tier.
export async function hasPlan(
  workspaceId: string,
  required: PlanTier,
): Promise<boolean> {
  const effective = await getEffectivePlan(workspaceId)
  return TIER_RANK[effective.tier] >= TIER_RANK[required]
}

// Use in API routes to short-circuit with a 402 (Payment Required) when the
// workspace lacks the tier. 402 is the standard HTTP code for paywalls — the
// frontend can detect it and pop the upgrade modal.
export async function requirePlan(
  workspaceId: string,
  required: PlanTier,
): Promise<NextResponse | null> {
  const effective = await getEffectivePlan(workspaceId)
  if (TIER_RANK[effective.tier] >= TIER_RANK[required]) return null
  return NextResponse.json(
    {
      error: 'plan_upgrade_required',
      message: `This feature requires the ${required} plan or higher.`,
      currentTier: effective.tier,
      requiredTier: required,
    },
    { status: 402 },
  )
}

// Boolean feature check — for capabilities tied to flags rather than tier rank.
// e.g. requireFeature(ws, 'recallBot') — currently both Pro and Enterprise
// have it, but if we ever sell it as an add-on the tier ladder breaks.
type BooleanFeature = {
  [K in keyof PlanLimits]: PlanLimits[K] extends boolean ? K : never
}[keyof PlanLimits]

export async function hasFeature(
  workspaceId: string,
  feature: BooleanFeature,
): Promise<boolean> {
  const effective = await getEffectivePlan(workspaceId)
  return Boolean(effective.limits[feature])
}

export async function requireFeature(
  workspaceId: string,
  feature: BooleanFeature,
): Promise<NextResponse | null> {
  const ok = await hasFeature(workspaceId, feature)
  if (ok) return null
  const effective = await getEffectivePlan(workspaceId)
  return NextResponse.json(
    {
      error: 'plan_upgrade_required',
      message: `Your plan does not include this feature.`,
      currentTier: effective.tier,
      feature,
    },
    { status: 402 },
  )
}

// Numeric limit check. -1 = unlimited. Used at write paths where we count
// rows in the same transaction window — e.g. before creating an AutomationRule:
//   const blocked = await assertWithinLimit(ws, 'automationRules',
//     () => prisma.automationRule.count({ where: { workspaceId } }))
type NumericLimit = {
  [K in keyof PlanLimits]: PlanLimits[K] extends number ? K : never
}[keyof PlanLimits]

export async function assertWithinLimit(
  workspaceId: string,
  limit: NumericLimit,
  currentCount: () => Promise<number>,
): Promise<NextResponse | null> {
  const effective = await getEffectivePlan(workspaceId)
  const max = effective.limits[limit]
  if (max === -1) return null
  const current = await currentCount()
  if (current < max) return null
  return NextResponse.json(
    {
      error: 'plan_limit_reached',
      message: `You have reached your ${limit} limit (${max}) on the ${effective.tier} plan.`,
      currentTier: effective.tier,
      limit,
      max,
      current,
    },
    { status: 402 },
  )
}
