import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized, forbidden } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'
import { priceIdFor, PLAN_CATALOG, BILLING_INTERVALS, type BillingInterval } from '@/lib/billing/plans'

const TRIAL_DAYS = 14

export async function POST(req: NextRequest) {
  const session = await getWorkspaceSession()
  if (!session) return unauthorized()
  // Only owners/admins can change billing.
  if (session.role !== 'owner' && session.role !== 'admin') return forbidden()

  const body = await req.json().catch(() => ({}))
  const tier = body.tier as string | undefined
  const interval = body.interval as BillingInterval | undefined

  const validTier = PLAN_CATALOG.find((p) => p.tier === tier)
  if (!validTier) {
    return NextResponse.json({ error: 'invalid_tier' }, { status: 400 })
  }
  if (!interval || !BILLING_INTERVALS.includes(interval)) {
    return NextResponse.json({ error: 'invalid_interval' }, { status: 400 })
  }

  const priceId = priceIdFor(validTier.tier, interval)
  if (!priceId) {
    return NextResponse.json(
      { error: 'price_not_configured', tier, interval },
      { status: 500 },
    )
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: session.workspaceId },
    select: {
      id: true, name: true, slug: true, stripeCustomerId: true, subscriptionStatus: true,
    },
  })
  if (!workspace) return NextResponse.json({ error: 'workspace_not_found' }, { status: 404 })

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { email: true, name: true },
  })

  const stripe = getStripe()

  // Reuse the Stripe Customer across upgrades so card on file + invoice
  // history all live in one place. Create on first checkout.
  let customerId = workspace.stripeCustomerId
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user?.email,
      name: workspace.name,
      metadata: { workspaceId: workspace.id, workspaceSlug: workspace.slug },
    })
    customerId = customer.id
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { stripeCustomerId: customerId },
    })
  }

  const origin = req.nextUrl.origin
  // Workspaces that already had a trial don't get another one. Stripe rejects
  // trial_period_days on customers with an existing subscription anyway.
  const eligibleForTrial = !workspace.subscriptionStatus

  const checkout = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: eligibleForTrial
      ? { trial_period_days: TRIAL_DAYS, metadata: { workspaceId: workspace.id } }
      : { metadata: { workspaceId: workspace.id } },
    success_url: `${origin}/dashboard/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/dashboard/settings/billing?checkout=cancelled`,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    metadata: { workspaceId: workspace.id, tier: validTier.tier, interval },
  })

  return NextResponse.json({ url: checkout.url })
}
