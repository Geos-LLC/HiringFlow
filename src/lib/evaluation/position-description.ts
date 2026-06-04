/**
 * Build a position description for a candidate (Session).
 *
 * Resolution order:
 *   1. Caller override (recruiter pasted a custom JD into the eval form)
 *   2. The candidate's Flow.positionDescription (recruiter pre-filled on
 *      the flow — the cheap-to-edit "set once, reuse everywhere" path)
 *   3. The Ad the candidate was attributed to (session.adId → ad.* fields)
 *   4. Same-flow Ad fallback: the most-content-rich active Ad on the same
 *      flow. Most candidates have `session.adId=null` because they came
 *      via the bare flow URL — but the recruiter still likely has the JD
 *      written into one of the flow's Ad rows.
 *   5. Workspace-wide Ad fallback: the richest active Ad anywhere in the
 *      workspace whose name overlaps with the candidate's flow name. This
 *      catches the common pattern where a recruiter wrote a "Dispatcher
 *      May 2026" ad on one flow and runs a "Dispatcher Flow with speaking
 *      test" with no ads of its own — both flows are about the same role,
 *      and the JD belongs to that role, not to the specific flow.
 *   6. Flow startMessage (the role pitch shown to candidates)
 *   7. Bare flow + workspace name (last-resort)
 *
 * Async because steps 4-5 hit the DB. The `source` field on the return
 * value lets the UI label where the JD came from so the recruiter can
 * spot when it degraded to a poor fallback.
 */
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

type SessionWithFlowAndAd = Prisma.SessionGetPayload<{
  include: { flow: true; ad: true; workspace: true }
}>

export type PositionDescriptionSource =
  | 'override'
  | 'flow'
  | 'ad'
  | 'fallback_ad'
  | 'workspace_ad'
  | 'flow_start'
  | 'flow_name'

// Words that don't carry role meaning and shouldn't drive the token-overlap
// match. Lower-cased. Stripped from both flow names and ad names before
// scoring overlap.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'for', 'to', 'with', 'in', 'on', 'or',
  'flow', 'form', 'application', 'job', 'test', 'speaking', 'video', 'role',
  'hiring', 'now', 'new', 'live', 'free', 'free-form', 'final',
])

function tokenize(s: string | null | undefined): string[] {
  if (!s) return []
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

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

  // Workspace-wide ad fallback. Score every active ad by token overlap with
  // the candidate's flow name + body richness. The best match wins as long
  // as there's at least one shared role token AND the ad has real body
  // content. Catches the "Dispatcher Flow with speaking test" → "Dispatcher
  // May 2026" case where the JD lives on a different flow.
  if (session.flowId && session.flow?.name) {
    const flowTokens = new Set(tokenize(session.flow.name))
    if (flowTokens.size > 0) {
      const wsAds = await prisma.ad.findMany({
        where: { workspaceId: session.workspaceId, isActive: true, flowId: { not: session.flowId } },
        select: { name: true, campaign: true, headline: true, bodyText: true, requirements: true, benefits: true },
      })
      let best: { ad: typeof wsAds[number]; score: number; len: number } | null = null
      for (const ad of wsAds) {
        const adTokens = new Set([
          ...tokenize(ad.name),
          ...tokenize(ad.campaign),
          ...tokenize(ad.headline),
        ])
        let overlap = 0
        adTokens.forEach((t) => { if (flowTokens.has(t)) overlap++ })
        if (overlap === 0) continue
        const len = (ad.headline?.length ?? 0) + (ad.bodyText?.length ?? 0) + (ad.requirements?.length ?? 0) + (ad.benefits?.length ?? 0)
        if (len < 40) continue // skip placeholder ads with no real content
        // Rank: more overlap first, then more content.
        if (!best || overlap > best.score || (overlap === best.score && len > best.len)) {
          best = { ad, score: overlap, len }
        }
      }
      if (best) {
        return { text: renderAd(best.ad), source: 'workspace_ad' }
      }
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
