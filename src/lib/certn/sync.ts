/**
 * Certn case-state reconciliation.
 *
 * Single entry point used by both the webhook handler (event arrives → fetch
 * case → reconcile) and the reconciliation cron (poll any non-terminal case
 * older than X). Idempotent — calling it twice for the same case is a no-op
 * after the first state transition.
 */

import { prisma } from '../prisma'
import {
  CertnError,
  type CaseDetail,
  getCase,
  isTerminalStatus,
  outcomeFromScore,
  resolveClient,
} from './client'
import { fireBackgroundCheckAutomations } from '../automation'
import { emitAutomationEvent, eventKeys } from '../automation-emit'

export interface SyncResult {
  backgroundCheckId: string
  certnCaseId: string
  prevStatus: string
  newStatus: string
  prevScore: string | null
  newScore: string | null
  outcomeFired: 'passed' | 'failed' | 'needs_review' | null
  error?: string
}

/**
 * Reconcile a single BackgroundCheck row against Certn. Looks up the case
 * via the API, updates the local row, and — on the first transition into a
 * terminal+scored state — fires the corresponding automation trigger.
 *
 * `eventId` is optional; pass it from the webhook to set lastEventId for
 * dedupe diagnostics. The actual webhook deduplication happens in the route
 * handler via the ProcessedCertnEvent ledger.
 */
export async function syncBackgroundCheck(
  backgroundCheckId: string,
  opts?: { eventId?: string },
): Promise<SyncResult> {
  const bc = await prisma.backgroundCheck.findUnique({
    where: { id: backgroundCheckId },
  })
  if (!bc) throw new Error(`BackgroundCheck ${backgroundCheckId} not found`)

  const client = await resolveClient(bc.workspaceId)

  let detail: CaseDetail
  try {
    detail = await getCase(client, bc.certnCaseId)
  } catch (err) {
    if (err instanceof CertnError) {
      // 404 = case removed on Certn side. Mark cancelled locally so we stop
      // polling. Anything else, surface upward.
      if (err.status === 404) {
        await prisma.backgroundCheck.update({
          where: { id: bc.id },
          data: {
            status: 'CANCELLED',
            lastSyncedAt: new Date(),
            lastEventId: opts?.eventId ?? bc.lastEventId,
          },
        })
        return {
          backgroundCheckId: bc.id,
          certnCaseId: bc.certnCaseId,
          prevStatus: bc.status,
          newStatus: 'CANCELLED',
          prevScore: bc.overallScore,
          newScore: bc.overallScore,
          outcomeFired: null,
          error: 'case_not_found_on_certn',
        }
      }
    }
    throw err
  }

  const newStatus = String(detail.overall_status || bc.status).toUpperCase()
  const newScore = detail.overall_score ? String(detail.overall_score).toUpperCase() : null

  // Decide if this transition crosses the "first time we see a terminal,
  // scored case" line. Only fire automation triggers on that crossing —
  // re-syncing a COMPLETE case must not double-fire.
  const wasAlreadyResolved = !!bc.overallScore || isTerminalStatus(bc.status)
  const becomesResolved = !!newScore || isTerminalStatus(newStatus)
  const justResolved = !wasAlreadyResolved && becomesResolved
  const outcome = justResolved ? outcomeFromScore(newScore) : null

  await prisma.backgroundCheck.update({
    where: { id: bc.id },
    data: {
      status: newStatus,
      overallScore: newScore,
      lastSyncedAt: new Date(),
      lastEventId: opts?.eventId ?? bc.lastEventId,
      completedAt: justResolved && becomesResolved ? new Date() : bc.completedAt,
    },
  })

  if (outcome) {
    await emitAutomationEvent({
      workspaceId: bc.workspaceId,
      sessionId: bc.sessionId,
      triggerType: 'background_check',
      eventKey: eventKeys.backgroundCheck(bc.id, outcome),
      source: 'webhook',
      payload: { backgroundCheckId: bc.id, outcome },
      dispatch: () => fireBackgroundCheckAutomations(bc.sessionId, outcome),
    }).catch((err) => {
      console.error('[Certn] background_check emit failed:', err)
    })
    // The candidate cleared the background-check checkpoint — bump the stale
    // clock so a candidate who took 6 days to do Certn isn't immediately
    // stalled the next morning.
    await prisma.session.update({
      where: { id: bc.sessionId },
      data: { lastProgressAt: new Date(), lastActivityAt: new Date() },
    }).catch(() => {})
  }

  return {
    backgroundCheckId: bc.id,
    certnCaseId: bc.certnCaseId,
    prevStatus: bc.status,
    newStatus,
    prevScore: bc.overallScore,
    newScore,
    outcomeFired: outcome,
  }
}
