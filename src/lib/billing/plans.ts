// Plan & price catalog. The 12 Stripe Price IDs are resolved from env vars set
// after running scripts/_oneoff/seed-stripe-products.ts. Limits / features
// here are the source of truth — Stripe just handles money. The active price
// ID coming back from a webhook is mapped to a tier via priceIdToPlan().

export type PlanTier = 'free' | 'starter' | 'pro' | 'enterprise'
export type BillingInterval = 'monthly' | 'quarterly' | 'semiannual' | 'annual'

export const PLAN_TIERS: PlanTier[] = ['free', 'starter', 'pro', 'enterprise']
export const BILLING_INTERVALS: BillingInterval[] = [
  'monthly',
  'quarterly',
  'semiannual',
  'annual',
]

// Feature flags + numeric limits per tier. -1 means unlimited.
export interface PlanLimits {
  seats: number
  flows: number
  pipelines: number
  automationRules: number
  candidatesPerMonth: number
  aiCallMinutesPerMonth: number
  recallBot: boolean
  backgroundChecks: boolean
  customSenderDomain: boolean
  prioritySupport: boolean
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    seats: 1,
    flows: 1,
    pipelines: 1,
    automationRules: 0,
    candidatesPerMonth: 10,
    aiCallMinutesPerMonth: 0,
    recallBot: false,
    backgroundChecks: false,
    customSenderDomain: false,
    prioritySupport: false,
  },
  starter: {
    seats: 2,
    flows: 3,
    pipelines: 1,
    automationRules: 5,
    candidatesPerMonth: 100,
    aiCallMinutesPerMonth: 0,
    recallBot: false,
    backgroundChecks: false,
    customSenderDomain: false,
    prioritySupport: false,
  },
  pro: {
    seats: 10,
    flows: 25,
    pipelines: 5,
    automationRules: 50,
    candidatesPerMonth: 1000,
    aiCallMinutesPerMonth: 500,
    recallBot: true,
    backgroundChecks: true,
    customSenderDomain: true,
    prioritySupport: false,
  },
  enterprise: {
    seats: -1,
    flows: -1,
    pipelines: -1,
    automationRules: -1,
    candidatesPerMonth: -1,
    aiCallMinutesPerMonth: 2000,
    recallBot: true,
    backgroundChecks: true,
    customSenderDomain: true,
    prioritySupport: true,
  },
}

// Catalog used by the pricing UI. Prices in USD; amounts also in cents at the
// bottom in case a callsite wants to drive Stripe API directly.
export interface PlanCatalogEntry {
  tier: Exclude<PlanTier, 'free'>
  name: string
  description: string
  monthlyUsd: number
}

export const PLAN_CATALOG: PlanCatalogEntry[] = [
  {
    tier: 'starter',
    name: 'Starter',
    description: 'Solo recruiters and small teams getting started.',
    monthlyUsd: 29,
  },
  {
    tier: 'pro',
    name: 'Pro',
    description: 'Growing teams running automations and AI calls.',
    monthlyUsd: 79,
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    description: 'High-volume hiring with unlimited everything.',
    monthlyUsd: 129,
  },
]

export const INTERVAL_DISCOUNTS: Record<BillingInterval, number> = {
  monthly: 0,
  quarterly: 0.10,
  semiannual: 0.15,
  annual: 0.20,
}

export const INTERVAL_MONTHS: Record<BillingInterval, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
}

export const INTERVAL_LABELS: Record<BillingInterval, string> = {
  monthly: 'Monthly',
  quarterly: '3 months',
  semiannual: '6 months',
  annual: 'Annual',
}

// Compute the upfront billed amount for a tier+interval. Returns dollars
// (rounded to 2dp) — Stripe price unit_amount is dollars*100 (see seed script).
export function intervalPriceUsd(
  monthlyUsd: number,
  interval: BillingInterval,
): number {
  const months = INTERVAL_MONTHS[interval]
  const discount = INTERVAL_DISCOUNTS[interval]
  return Math.round(monthlyUsd * months * (1 - discount) * 100) / 100
}

// Effective per-month rate after discount — what the UI shows under the big number.
export function effectiveMonthlyUsd(
  monthlyUsd: number,
  interval: BillingInterval,
): number {
  return Math.round(monthlyUsd * (1 - INTERVAL_DISCOUNTS[interval]) * 100) / 100
}

// ---- Env-driven price ID lookup ----------------------------------------------
// Conventions: STRIPE_PRICE_<TIER>_<INTERVAL>, e.g. STRIPE_PRICE_PRO_ANNUAL.
// The seed script (scripts/_oneoff/seed-stripe-products.ts) prints the exact
// env vars to paste into Vercel after running.

function envKey(tier: Exclude<PlanTier, 'free'>, interval: BillingInterval): string {
  return `STRIPE_PRICE_${tier.toUpperCase()}_${interval.toUpperCase()}`
}

export function priceIdFor(
  tier: Exclude<PlanTier, 'free'>,
  interval: BillingInterval,
): string | null {
  return process.env[envKey(tier, interval)] || null
}

// Reverse lookup used by the webhook handler to map a Stripe price ID back to
// our internal tier. Walks the env vars once per call — fine for webhook
// volumes; if it ever gets hot we can memoize at boot.
export function priceIdToPlan(priceId: string): {
  tier: Exclude<PlanTier, 'free'>
  interval: BillingInterval
} | null {
  for (const entry of PLAN_CATALOG) {
    for (const interval of BILLING_INTERVALS) {
      if (process.env[envKey(entry.tier, interval)] === priceId) {
        return { tier: entry.tier, interval }
      }
    }
  }
  return null
}

// Free-tier limits exposed as the safe default when no subscription is active.
export function limitsForTier(tier: PlanTier): PlanLimits {
  return PLAN_LIMITS[tier]
}
