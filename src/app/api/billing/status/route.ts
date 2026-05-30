import { NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getEffectivePlan } from '@/lib/billing/guard'
import { priceIdToPlan } from '@/lib/billing/plans'

export async function GET() {
  const session = await getWorkspaceSession()
  if (!session) return unauthorized()

  const effective = await getEffectivePlan(session.workspaceId)
  const ws = await prisma.workspace.findUnique({
    where: { id: session.workspaceId },
    select: { stripeCustomerId: true, stripePriceId: true, stripeSubscriptionId: true },
  })
  const interval = ws?.stripePriceId ? priceIdToPlan(ws.stripePriceId)?.interval ?? null : null

  return NextResponse.json({
    tier: effective.tier,
    status: effective.status,
    inTrial: effective.inTrial,
    trialEndsAt: effective.trialEndsAt,
    currentPeriodEnd: effective.currentPeriodEnd,
    cancelAtPeriodEnd: effective.cancelAtPeriodEnd,
    interval,
    hasStripeCustomer: Boolean(ws?.stripeCustomerId),
    limits: effective.limits,
    role: session.role,
  })
}
