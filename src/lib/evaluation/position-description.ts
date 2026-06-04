/**
 * Build a position description for a candidate (Session).
 *
 * Resolution order:
 *   1. Caller override (recruiter pasted a custom JD into the eval form)
 *   2. The candidate's Flow.positionDescription (recruiter pre-filled on
 *      the flow — the cheap-to-edit "set once, reuse everywhere" path)
 *   3. The Ad the candidate was attributed to (session.adId → ad.* fields)
 *   4. Fallback Ad lookup: the most-content-rich active Ad on the same
 *      flow. Most candidates have `session.adId=null` because they came
 *      via the bare flow URL — but the recruiter still likely has the JD
 *      written into one of the flow's Ad rows. Picks the active ad with
 *      the most bodyText so an empty placeholder ad doesn't win over a
 *      real one.
 *   5. Flow startMessage (the role pitch shown to candidates)
 *   6. Bare flow + workspace name (last-resort)
 *
 * Async because step 4 may need a DB lookup. The `source` field on the
 * return value lets the UI label where the JD came from so the recruiter
 * can spot when it degraded to a poor fallback.
 */
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

type SessionWithFlowAndAd = Prisma.SessionGetPayload<{
  include: { flow: true; ad: true; workspace: true }
}>

export type PositionDescriptionSource = 'override' | 'flow' | 'ad' | 'fallback_ad' | 'flow_start' | 'flow_name'

export interface PositionDescriptionResult {
  text: string
  source: PositionDescriptionSource
}

function renderAd(ad: {
  name: string
  headline: string | null
  bodyText: string | null
  requirements: string | null
  benefits: string | null
}): string {
  const parts: string[] = []
  parts.push(`Role: ${ad.name}`)
  if (ad.headline) parts.push(ad.headline)
  if (ad.bodyText) parts.push(ad.bodyText)
  if (ad.requirements) parts.push(`Requirements:\n${ad.requirements}`)
  if (ad.benefits) parts.push(`Benefits:\n${ad.benefits}`)
  return parts.join('\n\n')
}

export async function buildPositionDescription(
  session: SessionWithFlowAndAd,
  override?: string | null,
): Promise<PositionDescriptionResult> {
  const trimmedOverride = override?.trim()
  if (trimmedOverride) return { text: trimmedOverride, source: 'override' }

  if (session.flow?.positionDescription?.trim()) {
    return { text: session.flow.positionDescription.trim(), source: 'flow' }
  }

  // Linked ad — only count it if it has real body content (some ads carry
  // just a name with empty body fields, which would still degrade to a
  // title-only JD; the fallback ad lookup handles those better).
  const linked = session.ad
  if (linked && (linked.headline || linked.bodyText || linked.requirements || linked.benefits)) {
    return { text: renderAd(linked), source: 'ad' }
  }

  // Fallback: the richest active ad on the same flow. Most candidates come
  // through the bare flow URL with adId=null, but the flow's ads usually
  // carry the JD the recruiter wrote.
  if (session.flowId) {
    const flowAds = await prisma.ad.findMany({
      where: { flowId: session.flowId, workspaceId: session.workspaceId, isActive: true },
      select: { name: true, headline: true, bodyText: true, requirements: true, benefits: true },
    })
    let best: typeof flowAds[number] | null = null
    let bestLen = 0
    for (const ad of flowAds) {
      const len = (ad.headline?.length ?? 0) + (ad.bodyText?.length ?? 0) + (ad.requirements?.length ?? 0) + (ad.benefits?.length ?? 0)
      if (len > bestLen) {
        best = ad
        bestLen = len
      }
    }
    if (best && bestLen > 0) {
      return { text: renderAd(best), source: 'fallback_ad' }
    }
  }

  // Flow start message is sometimes the candidate-facing role pitch.
  if (session.flow?.startMessage && session.flow.startMessage.length > 40) {
    return {
      text: `Role: ${session.flow.name}\n\n${session.flow.startMessage}`,
      source: 'flow_start',
    }
  }

  return {
    text: `Role: ${session.flow?.name ?? 'Unknown'} at ${session.workspace?.name ?? 'company'}`,
    source: 'flow_name',
  }
}
