/**
 * SendGrid webhook integration test — exercises applyEventToExecution
 * against a mocked prisma client. Verifies:
 *   - delivered event updates the execution
 *   - cross-workspace events get dropped
 *   - unknown executionId is silently ignored
 *   - terminal failure isn't downgraded by a later processed/deferred
 *   - duplicate sg_event_id is a no-op
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

type ExecRow = {
  id: string
  sessionId: string
  deliveryStatus: string | null
  sendgridEventId: string | null
  automationRule: { workspaceId: string } | null
}

// vi.mock is hoisted above imports — use vi.hoisted so the shared row store
// is available when the factory runs at the top of the file.
const { rows, prismaMock } = vi.hoisted(() => {
  const rows = new Map<string, ExecRow>()
  const prismaMock = {
    automationExecution: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const row = rows.get(args.where.id)
        return row ? { ...row } : null
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(args.where.id)
        if (!row) throw new Error('not found')
        const updated = { ...row, ...args.data } as ExecRow
        rows.set(args.where.id, updated)
        return updated
      }),
    },
  }
  return { rows, prismaMock }
})

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

// Import AFTER mocks are registered.
import { applyEventToExecution } from '../route'

function seedExecution(id: string, workspaceId: string, prev: Partial<ExecRow> = {}) {
  rows.set(id, {
    id,
    sessionId: 'sess-' + id,
    deliveryStatus: null,
    sendgridEventId: null,
    automationRule: { workspaceId },
    ...prev,
  })
}

describe('applyEventToExecution', () => {
  beforeEach(() => {
    rows.clear()
    prismaMock.automationExecution.findUnique.mockClear()
    prismaMock.automationExecution.update.mockClear()
  })

  it('updates execution from null → delivered on a delivered event', async () => {
    seedExecution('exec-1', 'ws-1')
    const result = await applyEventToExecution('exec-1', 'delivered', {
      event: 'delivered',
      sg_message_id: 'sg.msg.1',
      sg_event_id: 'sg.event.1',
      timestamp: 1717000000,
      workspaceId: 'ws-1',
    })
    expect(result).toBe('updated')
    const row = rows.get('exec-1')
    expect(row?.deliveryStatus).toBe('delivered')
    expect(row?.sendgridEventId).toBe('sg.event.1')
  })

  it('drops cross-workspace events', async () => {
    seedExecution('exec-1', 'ws-1')
    const result = await applyEventToExecution('exec-1', 'delivered', {
      event: 'delivered',
      workspaceId: 'ws-OTHER',
    })
    expect(result).toBe('cross_workspace')
    const row = rows.get('exec-1')
    expect(row?.deliveryStatus).toBeNull()
  })

  it('silently ignores unknown executionId', async () => {
    const result = await applyEventToExecution('missing', 'delivered', { event: 'delivered' })
    expect(result).toBe('no_execution')
    expect(prismaMock.automationExecution.update).not.toHaveBeenCalled()
  })

  it('refuses to downgrade a terminal failure to processed/deferred', async () => {
    seedExecution('exec-1', 'ws-1', { deliveryStatus: 'bounce' })
    const result = await applyEventToExecution('exec-1', 'processed', {
      event: 'processed',
      sg_event_id: 'sg.event.late',
    })
    expect(result).toBe('no_status_change')
    expect(rows.get('exec-1')?.deliveryStatus).toBe('bounce')
    // It should still record the event id so we don't reprocess the same
    // late-arriving event again.
    expect(rows.get('exec-1')?.sendgridEventId).toBe('sg.event.late')
  })

  it('overrides delivered with a later async bounce', async () => {
    seedExecution('exec-1', 'ws-1', { deliveryStatus: 'delivered' })
    const result = await applyEventToExecution('exec-1', 'bounce', {
      event: 'bounce',
      reason: 'Mailbox full',
      workspaceId: 'ws-1',
      sg_event_id: 'sg.event.async',
    })
    expect(result).toBe('updated')
    expect(rows.get('exec-1')?.deliveryStatus).toBe('bounce')
  })

  it('treats a duplicate sg_event_id as idempotent no-op', async () => {
    seedExecution('exec-1', 'ws-1', { deliveryStatus: 'delivered', sendgridEventId: 'sg.event.dup' })
    const result = await applyEventToExecution('exec-1', 'delivered', {
      event: 'delivered',
      sg_event_id: 'sg.event.dup',
    })
    expect(result).toBe('duplicate')
    expect(prismaMock.automationExecution.update).not.toHaveBeenCalled()
  })

  it('accepts the event when no workspaceId is echoed back (defensive)', async () => {
    seedExecution('exec-1', 'ws-1')
    const result = await applyEventToExecution('exec-1', 'delivered', {
      event: 'delivered',
      // No workspaceId / customArgs.workspaceId — accept since our forgery
      // defense only fires when the event explicitly sets a *different*
      // workspaceId.
    })
    expect(result).toBe('updated')
  })
})
