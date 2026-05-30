// One-off: create the 3 HiringFlow products + 12 recurring prices in Stripe,
// then print the env vars to paste into Vercel.
//
// Usage:
//   STRIPE_SECRET_KEY=sk_test_xxx npx tsx scripts/_oneoff/seed-stripe-products.ts
//
// Idempotent on re-run: looks up existing products by metadata.hiringflow_tier
// and reuses them instead of creating duplicates. Prices are append-only in
// Stripe — if a price for (tier, interval) already exists with the right
// amount + interval, we reuse it; otherwise we create a new one and the old
// one is left active (you can archive it manually in the dashboard).

import Stripe from 'stripe'
import {
  PLAN_CATALOG,
  BILLING_INTERVALS,
  INTERVAL_MONTHS,
  INTERVAL_DISCOUNTS,
  type BillingInterval,
} from '../../src/lib/billing/plans'

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error('STRIPE_SECRET_KEY not set')
  process.exit(1)
}

const stripe = new Stripe(key, { apiVersion: '2026-05-27.dahlia' })

async function findOrCreateProduct(tier: string, name: string, description: string) {
  const existing = await stripe.products.search({
    query: `metadata['hiringflow_tier']:'${tier}' AND active:'true'`,
  })
  if (existing.data.length > 0) {
    const p = existing.data[0]
    console.log(`✓ Product ${tier}: reusing ${p.id}`)
    return p
  }
  const p = await stripe.products.create({
    name: `HiringFlow ${name}`,
    description,
    metadata: { hiringflow_tier: tier },
  })
  console.log(`+ Product ${tier}: created ${p.id}`)
  return p
}

async function findOrCreatePrice(
  productId: string,
  tier: string,
  interval: BillingInterval,
  unitAmountCents: number,
) {
  const months = INTERVAL_MONTHS[interval]
  const stripeInterval: Stripe.PriceCreateParams.Recurring.Interval =
    interval === 'annual' ? 'year' : 'month'
  const intervalCount = interval === 'annual' ? 1 : months

  const existing = await stripe.prices.list({ product: productId, active: true, limit: 100 })
  const match = existing.data.find(
    (p) =>
      p.metadata?.hiringflow_interval === interval &&
      p.unit_amount === unitAmountCents &&
      p.recurring?.interval === stripeInterval &&
      p.recurring?.interval_count === intervalCount,
  )
  if (match) {
    console.log(`  ✓ Price ${tier}/${interval}: reusing ${match.id} ($${(unitAmountCents/100).toFixed(2)})`)
    return match
  }
  const p = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: unitAmountCents,
    recurring: { interval: stripeInterval, interval_count: intervalCount },
    metadata: { hiringflow_tier: tier, hiringflow_interval: interval },
    nickname: `${tier}-${interval}`,
  })
  console.log(`  + Price ${tier}/${interval}: created ${p.id} ($${(unitAmountCents/100).toFixed(2)})`)
  return p
}

async function main() {
  const envOut: string[] = []
  for (const plan of PLAN_CATALOG) {
    const product = await findOrCreateProduct(plan.tier, plan.name, plan.description)
    for (const interval of BILLING_INTERVALS) {
      const months = INTERVAL_MONTHS[interval]
      const discount = INTERVAL_DISCOUNTS[interval]
      const cents = Math.round(plan.monthlyUsd * months * (1 - discount) * 100)
      const price = await findOrCreatePrice(product.id, plan.tier, interval, cents)
      envOut.push(`STRIPE_PRICE_${plan.tier.toUpperCase()}_${interval.toUpperCase()}=${price.id}`)
    }
  }
  console.log('\n=== Env vars — add to Vercel + local .env ===')
  console.log(envOut.join('\n'))
  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
