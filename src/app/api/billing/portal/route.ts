import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized, forbidden, isOwner } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'

export async function POST(req: NextRequest) {
  const session = await getWorkspaceSession()
  if (!session) return unauthorized()
  if (!isOwner(session.role, session.isSuperAdmin)) {
    return forbidden('Only the workspace owner can manage subscription & billing')
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: session.workspaceId },
    select: { stripeCustomerId: true },
  })
  if (!workspace?.stripeCustomerId) {
    return NextResponse.json({ error: 'no_stripe_customer' }, { status: 400 })
  }

  const portal = await getStripe().billingPortal.sessions.create({
    customer: workspace.stripeCustomerId,
    return_url: `${req.nextUrl.origin}/dashboard/settings/billing`,
  })

  return NextResponse.json({ url: portal.url })
}
