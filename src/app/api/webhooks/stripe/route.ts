import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { prisma } from '@/lib/prisma'
import { getStripe, stripeWebhookSecret } from '@/lib/stripe'
import { priceIdToPlan, type PlanTier } from '@/lib/billing/plans'

// Stripe needs the raw request body to verify the signature, so we cannot
// use req.json(). Route segment config — Next 14 App Router defaults are fine
// but we set runtime explicitly to avoid Edge (Stripe SDK is node-only).
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 400 })
  }
  const rawBody = await req.text()

  let event: Stripe.Event
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, stripeWebhookSecret())
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid signature'
    return NextResponse.json({ error: 'invalid_signature', message: msg }, { status: 400 })
  }

  // Idempotency — Stripe retries on 5xx for up to 3 days. Unique constraint on
  // stripe_event_id rejects duplicates so the handlers below run exactly once.
  const dupe = await prisma.billingEvent.findUnique({
    where: { stripeEventId: event.id },
    select: { id: true },
  })
  if (dupe) {
    return NextResponse.json({ received: true, deduped: true })
  }

  let workspaceId: string | null = null
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        workspaceId = await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session)
        break
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        workspaceId = await handleSubscriptionChange(event.data.object as Stripe.Subscription)
        break
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed':
        workspaceId = await handleInvoice(event.data.object as Stripe.Invoice)
        break
      default:
        // Log unknown events but ack — Stripe sends many we don't care about.
        break
    }
  } catch (err) {
    // Log error but DON'T 500 — Stripe will retry which causes our idempotency
    // record below to not exist on retry, so we'd loop forever. We capture
    // the failure on the BillingEvent payload for forensics.
    console.error('[stripe webhook] handler error', event.type, event.id, err)
  }

  await prisma.billingEvent.create({
    data: {
      stripeEventId: event.id,
      workspaceId,
      type: event.type,
      payload: event as unknown as object,
    },
  })

  return NextResponse.json({ received: true })
}

// ---- handlers ----------------------------------------------------------------

async function handleCheckoutCompleted(s: Stripe.Checkout.Session): Promise<string | null> {
  const workspaceId = s.metadata?.workspaceId
  if (!workspaceId) return null
  // The subscription object is referenced by id at this point; the full sync
  // happens on customer.subscription.created which fires right after.
  // Nothing to do here besides associating customer id (already done at
  // checkout-creation time).
  return workspaceId
}

async function handleSubscriptionChange(sub: Stripe.Subscription): Promise<string | null> {
  const workspaceId = await resolveWorkspaceId(sub)
  if (!workspaceId) return null

  const item = sub.items.data[0]
  const priceId = item?.price?.id ?? null
  const mapped = priceId ? priceIdToPlan(priceId) : null
  const tier: PlanTier = mapped?.tier ?? 'free'

  // On deleted (canceled at period end of one-final-cycle), still surface the
  // status but downgrade plan. getEffectivePlan() will respect status too.
  const status = sub.status
  // Stripe's typings say current_period_end exists on Subscription but the
  // runtime field can be missing on some new sub variants — fall back safely.
  const periodEndSec = (sub as unknown as { current_period_end?: number }).current_period_end
  const currentPeriodEnd = periodEndSec ? new Date(periodEndSec * 1000) : null
  const trialEndSec = (sub as unknown as { trial_end?: number | null }).trial_end
  const trialEndsAt = trialEndSec ? new Date(trialEndSec * 1000) : null

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      plan: tier,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId,
      subscriptionStatus: status,
      currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      trialEndsAt,
    },
  })
  return workspaceId
}

async function handleInvoice(inv: Stripe.Invoice): Promise<string | null> {
  const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id
  if (!customerId) return null
  const ws = await prisma.workspace.findUnique({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  })
  return ws?.id ?? null
}

async function resolveWorkspaceId(sub: Stripe.Subscription): Promise<string | null> {
  // Prefer metadata stamped at checkout creation; fall back to customer lookup.
  const fromMeta = sub.metadata?.workspaceId
  if (fromMeta) return fromMeta
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const ws = await prisma.workspace.findUnique({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  })
  return ws?.id ?? null
}
