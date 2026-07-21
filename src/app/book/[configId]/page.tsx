/**
 * Public booking page.
 *
 * Two modes:
 *  - With ?t=<token>: per-candidate flow. Token is verified server-side and
 *    the slot picker is rendered with the candidate's prefilled info.
 *  - Without ?t=: anonymous global-link flow (Calendly-style). Calendar +
 *    slots render immediately; name/email is collected in the same confirm
 *    step that runs after the candidate picks a slot.
 */

import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { verifyBookingToken } from '@/lib/scheduling/booking-links'
import { parseCustomFieldsOrEmpty } from '@/lib/scheduling/custom-fields'
import { BookingClient } from './BookingClient'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: { configId: string }
  searchParams: { t?: string }
}

export default async function BookPage({ params, searchParams }: PageProps) {
  const config = await prisma.schedulingConfig.findUnique({
    where: { id: params.configId },
    select: {
      id: true,
      name: true,
      isActive: true,
      useBuiltInScheduler: true,
      customFields: true,
      workspace: {
        select: { name: true, logoUrl: true, senderName: true, timezone: true },
      },
    },
  })
  if (!config || !config.isActive || !config.useBuiltInScheduler) return notFound()

  const customFields = parseCustomFieldsOrEmpty(config.customFields)

  // Anonymous flow: render the picker without prefilled candidate info; the
  // confirm step asks for name/email and the booking endpoint creates the
  // session inline.
  if (!searchParams.t) {
    return (
      <BookingClient
        configId={params.configId}
        token=""
        candidateName={null}
        candidateEmail={null}
        candidatePhone={null}
        workspaceName={config.workspace.name}
        workspaceLogo={config.workspace.logoUrl}
        configName={config.name}
        customFields={customFields}
        anonymous
      />
    )
  }

  // Tokened (per-candidate) flow.
  const verified = verifyBookingToken(searchParams.t)
  if (!verified.ok) return notFound()
  if (verified.payload.purpose !== 'book') return notFound()
  if (verified.payload.configId !== params.configId) return notFound()

  const session = await prisma.session.findUnique({
    where: { id: verified.payload.sessionId },
    select: { id: true, candidateName: true, candidateEmail: true, candidatePhone: true, workspaceId: true },
  })
  if (!session) return notFound()

  return (
    <BookingClient
      configId={params.configId}
      token={searchParams.t!}
      candidateName={session.candidateName}
      candidateEmail={session.candidateEmail}
      candidatePhone={session.candidatePhone}
      workspaceName={config.workspace.name}
      workspaceLogo={config.workspace.logoUrl}
      configName={config.name}
      customFields={customFields}
    />
  )
}
