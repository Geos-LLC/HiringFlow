import { prisma } from './prisma'
import {
  readWorkspaceId,
  shouldUpdateStatus,
  readDeliveryError,
  type SendgridEvent,
  type DeliveryStatus,
} from './sendgrid-events'

export type ApplyResult = 'updated' | 'no_execution' | 'cross_workspace' | 'duplicate' | 'no_status_change'

/**
 * Apply a single mapped SendGrid event to an AutomationExecution row.
 * Pulled out of the route file because Next.js App Router rejects any
 * named export on route.ts that isn't an HTTP method handler or a
 * recognized config flag.
 *
 * Idempotency rules:
 *   - Unknown executionId      → no_execution (silent ignore)
 *   - Cross-workspace mismatch → cross_workspace (silent drop, defends
 *                                 against forged customArgs)
 *   - Same sg_event_id seen    → duplicate (no DB write)
 *   - shouldUpdateStatus says no → no_status_change (only the event id
 *                                  is recorded, status stays the same)
 *   - Otherwise                → updated
 */
export async function applyEventToExecution(
  executionId: string,
  next: DeliveryStatus,
  ev: SendgridEvent,
): Promise<ApplyResult> {
  const execution = await prisma.automationExecution.findUnique({
    where: { id: executionId },
    select: {
      id: true,
      sessionId: true,
      deliveryStatus: true,
      sendgridEventId: true,
      automationRule: { select: { workspaceId: true } },
    },
  })
  if (!execution) return 'no_execution'

  const ruleWsId = execution.automationRule?.workspaceId ?? null
  const eventWsId = readWorkspaceId(ev)
  if (eventWsId && ruleWsId && eventWsId !== ruleWsId) {
    console.warn('[SendGridWebhook] workspace mismatch — dropping', { executionId, eventWsId, ruleWsId })
    return 'cross_workspace'
  }

  if (ev.sg_event_id && execution.sendgridEventId === ev.sg_event_id) {
    return 'duplicate'
  }

  const willUpdate = shouldUpdateStatus(execution.deliveryStatus as DeliveryStatus | null, next)
  if (!willUpdate) {
    if (ev.sg_event_id) {
      await prisma.automationExecution.update({
        where: { id: executionId },
        data: { sendgridEventId: ev.sg_event_id },
      })
    }
    return 'no_status_change'
  }

  const error = next === 'delivered' || next === 'processed' ? null : readDeliveryError(ev)
  const evTimestamp = typeof ev.timestamp === 'number' && Number.isFinite(ev.timestamp)
    ? new Date(ev.timestamp * 1000)
    : new Date()

  await prisma.automationExecution.update({
    where: { id: executionId },
    data: {
      deliveryStatus: next,
      deliveryStatusAt: evTimestamp,
      deliveryErrorMessage: error,
      sendgridMessageId: ev.sg_message_id ?? undefined,
      sendgridEventId: ev.sg_event_id ?? undefined,
      deliveryRaw: {
        event: ev.event ?? null,
        type: ev.type ?? null,
        reason: ev.reason ?? null,
        response: ev.response ?? null,
        status: ev.status ?? null,
        timestamp: ev.timestamp ?? null,
      } as any,
    },
  })
  return 'updated'
}
