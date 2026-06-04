/**
 * Build a position description for a candidate (Session).
 *
 * Resolution order:
 *   1. Caller override (recruiter pasted a custom JD into the eval form)
 *   2. The candidate's Flow.positionDescription (recruiter pre-filled on the flow)
 *   3. The linked Ad copy (headline + bodyText + requirements + benefits)
 *   4. Bare flow + workspace name (last-resort fallback)
 *
 * Returned string is plain text — fed straight into the model prompt.
 */
import type { Prisma } from '@prisma/client'

type SessionWithFlowAndAd = Prisma.SessionGetPayload<{
  include: { flow: true; ad: true; workspace: true }
}>

export function buildPositionDescription(
  session: SessionWithFlowAndAd,
  override?: string | null,
): string {
  const trimmed = override?.trim()
  if (trimmed) return trimmed

  if (session.flow?.positionDescription?.trim()) {
    return session.flow.positionDescription.trim()
  }

  const ad = session.ad
  if (ad) {
    const parts: string[] = []
    parts.push(`Role: ${ad.name}`)
    if (ad.headline) parts.push(ad.headline)
    if (ad.bodyText) parts.push(ad.bodyText)
    if (ad.requirements) parts.push(`Requirements:\n${ad.requirements}`)
    if (ad.benefits) parts.push(`Benefits:\n${ad.benefits}`)
    return parts.join('\n\n')
  }

  return `Role: ${session.flow?.name ?? 'Unknown'} at ${session.workspace?.name ?? 'company'}`
}
