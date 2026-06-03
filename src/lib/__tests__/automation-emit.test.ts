/**
 * Coverage for the AutomationEvent / emitAutomationEvent boundary.
 *
 * Architecture invariant being tested: the (workspaceId, eventKey) unique
 * constraint is the source-of-truth for automation idempotency. Pre-existing
 * AutomationExecution dedup (status='sent' + step-scoped unique key) is the
 * second line of defence; the spec for THIS file is that the FIRST line
 * holds even when raw-event triggers (`stageEntryId IS NULL`) defeat the
 * Postgres-NULL-distinct semantics of the existing AutomationExecution
 * constraint.
 *
 * These tests hit a real Postgres (whatever DATABASE_URL points at). They
 * do NOT mock prisma — the whole point of the boundary is the DB constraint,
 * which can't be exercised by a mocked client.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { nanoid } from 'nanoid'
import {
  emitAutomationEvent,
  findOrphanAutomationEvents,
  redispatchAcceptedEvent,
  eventKeys,
} from '../automation-emit'

const prisma = new PrismaClient()

let workspaceId: string
let userId: string
let flowId: string
let sessionId: string

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `emit-${nanoid(8)}@test.com`, passwordHash: 'x' },
  })
  userId = user.id
  const workspace = await prisma.workspace.create({
    data: { name: 'Emit Test WS', slug: `emit-${nanoid(8)}` },
  })
  workspaceId = workspace.id
  const flow = await prisma.flow.create({
    data: { workspaceId, createdById: userId, name: 'Emit Flow', slug: `ef-${nanoid(8)}` },
  })
  flowId = flow.id
  const session = await prisma.session.create({
    data: { workspaceId, flowId, candidateName: 'Emit Test', status: 'active' },
  })
  sessionId = session.id
})

afterAll(async () => {
  await prisma.automationEvent.deleteMany({ where: { workspaceId } })
  await prisma.session.deleteMany({ where: { workspaceId } })
  await prisma.flow.deleteMany({ where: { id: flowId } })
  await prisma.workspace.deleteMany({ where: { id: workspaceId } })
  await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.automationEvent.deleteMany({ where: { workspaceId } })
})

describe('emitAutomationEvent — happy path', () => {
  it('writes the event row and invokes dispatch when the key is fresh', async () => {
    let dispatchCalled = 0
    const eventKey = eventKeys.flowCompleted(sessionId) + ':' + nanoid(4)

    const result = await emitAutomationEvent({
      workspaceId,
      sessionId,
      triggerType: 'flow_completed',
      eventKey,
      source: 'lifecycle',
      dispatch: async () => {
        dispatchCalled++
        return 'ok' as const
      },
    })

    expect(result.accepted).toBe(true)
    expect(result.dispatchResult).toBe('ok')
    expect(dispatchCalled).toBe(1)

    const row = await prisma.automationEvent.findUnique({
      where: { workspaceId_eventKey: { workspaceId, eventKey } },
    })
    expect(row).not.toBeNull()
    expect(row!.dispatchedAt).not.toBeNull()
    expect(row!.dispatchError).toBeNull()
  })
})

describe('emitAutomationEvent — race protection', () => {
  // The duplicate-emission bug we set out to fix: two paths fire the same
  // business event at the same millisecond, both insert pending
  // AutomationExecution rows, both reach the SendGrid send path. With the
  // new boundary, exactly one of the two attempts wins the INSERT and the
  // other returns accepted=false with reason=duplicate. The loser's
  // dispatch callback is NEVER invoked — that's the entire point.
  it('two simultaneous emitters for the same eventKey produce one event and one dispatch', async () => {
    const eventKey = eventKeys.flowCompleted(sessionId) + ':' + nanoid(4)
    let dispatchedFromA = 0
    let dispatchedFromB = 0

    const [resA, resB] = await Promise.all([
      emitAutomationEvent({
        workspaceId,
        sessionId,
        triggerType: 'flow_completed',
        eventKey,
        source: 'lifecycle',
        dispatch: async () => { dispatchedFromA++ },
      }),
      emitAutomationEvent({
        workspaceId,
        sessionId,
        triggerType: 'flow_completed',
        eventKey,
        source: 'public_endpoint',
        dispatch: async () => { dispatchedFromB++ },
      }),
    ])

    const accepted = [resA, resB].filter((r) => r.accepted)
    const deduped = [resA, resB].filter((r) => !r.accepted)
    expect(accepted).toHaveLength(1)
    expect(deduped).toHaveLength(1)
    expect(deduped[0].reason).toBe('duplicate')
    expect(dispatchedFromA + dispatchedFromB).toBe(1)

    const rows = await prisma.automationEvent.findMany({ where: { workspaceId, eventKey } })
    expect(rows).toHaveLength(1)
  })

  // Raw-event triggers (flow_completed, meeting_*, training_completed) all
  // have stageEntryId IS NULL on the AutomationExecution side, which the
  // schema comment explicitly calls out as defeating DB-level dedup there.
  // The AutomationEvent boundary doesn't have any nullable identifiers in
  // its unique key, so dedup holds regardless of stage attribution.
  it('raw-event trigger keys (no stageEntryId in scope) still dedup', async () => {
    const eventKey = eventKeys.meetingEnded('meeting-' + nanoid(8))

    let dispatchCount = 0
    const dispatch = async () => { dispatchCount++ }

    const results = await Promise.all([
      emitAutomationEvent({ workspaceId, sessionId, triggerType: 'meeting_ended', eventKey, source: 'webhook', dispatch }),
      emitAutomationEvent({ workspaceId, sessionId, triggerType: 'meeting_ended', eventKey, source: 'lifecycle', dispatch }),
      emitAutomationEvent({ workspaceId, sessionId, triggerType: 'meeting_ended', eventKey, source: 'cron', dispatch }),
    ])

    expect(results.filter((r) => r.accepted)).toHaveLength(1)
    expect(dispatchCount).toBe(1)
  })

  it('different eventKeys for the same trigger still dispatch independently', async () => {
    const keyA = eventKeys.meetingStarted('meeting-' + nanoid(8))
    const keyB = eventKeys.meetingStarted('meeting-' + nanoid(8))

    let count = 0
    const dispatch = async () => { count++ }

    const [a, b] = await Promise.all([
      emitAutomationEvent({ workspaceId, sessionId, triggerType: 'meeting_started', eventKey: keyA, source: 'webhook', dispatch }),
      emitAutomationEvent({ workspaceId, sessionId, triggerType: 'meeting_started', eventKey: keyB, source: 'webhook', dispatch }),
    ])

    expect(a.accepted).toBe(true)
    expect(b.accepted).toBe(true)
    expect(count).toBe(2)
  })
})

describe('emitAutomationEvent — failure semantics', () => {
  it('records dispatchError when the dispatch callback throws', async () => {
    const eventKey = eventKeys.flowCompleted(sessionId) + ':' + nanoid(4)

    await expect(
      emitAutomationEvent({
        workspaceId,
        sessionId,
        triggerType: 'flow_completed',
        eventKey,
        source: 'lifecycle',
        dispatch: async () => { throw new Error('boom') },
      }),
    ).rejects.toThrow('boom')

    const row = await prisma.automationEvent.findUnique({
      where: { workspaceId_eventKey: { workspaceId, eventKey } },
    })
    expect(row).not.toBeNull()
    expect(row!.dispatchedAt).toBeNull()
    expect(row!.dispatchError).toContain('boom')
  })

  it('a deduped second call does not overwrite the winner\'s dispatchedAt', async () => {
    const eventKey = eventKeys.flowCompleted(sessionId) + ':' + nanoid(4)

    await emitAutomationEvent({
      workspaceId,
      sessionId,
      triggerType: 'flow_completed',
      eventKey,
      source: 'lifecycle',
      dispatch: async () => {},
    })

    const before = await prisma.automationEvent.findUnique({
      where: { workspaceId_eventKey: { workspaceId, eventKey } },
    })
    expect(before!.dispatchedAt).not.toBeNull()

    const dedup = await emitAutomationEvent({
      workspaceId,
      sessionId,
      triggerType: 'flow_completed',
      eventKey,
      source: 'public_endpoint',
      dispatch: async () => { throw new Error('should never run') },
    })

    expect(dedup.accepted).toBe(false)
    expect(dedup.reason).toBe('duplicate')

    const after = await prisma.automationEvent.findUnique({
      where: { workspaceId_eventKey: { workspaceId, eventKey } },
    })
    expect(after!.dispatchedAt!.getTime()).toBe(before!.dispatchedAt!.getTime())
  })
})

describe('findOrphanAutomationEvents + redispatchAcceptedEvent', () => {
  // The reconciler path. An event was accepted but its dispatch died (Vercel
  // killed the function mid-flight, exception swallowed, etc.). The row sits
  // with dispatchedAt=null. The reconciler sweeps these up after a grace
  // window and re-fires dispatch without re-inserting the event — preserving
  // the (workspaceId, eventKey) identity so any third emitter still sees
  // the constraint and skips.
  it('finds events past the grace window that never dispatched', async () => {
    const eventKey = eventKeys.flowCompleted(sessionId) + ':' + nanoid(4)
    const row = await prisma.automationEvent.create({
      data: {
        workspaceId,
        sessionId,
        triggerType: 'flow_completed',
        eventKey,
        source: 'lifecycle',
        acceptedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
      },
    })

    const orphans = await findOrphanAutomationEvents({
      minAgeMs: 60_000,
      maxAgeMs: 60 * 60 * 1000,
      take: 50,
    })
    expect(orphans.some((o) => o.id === row.id)).toBe(true)
  })

  it('excludes events with dispatchError set (deterministic failure)', async () => {
    const eventKey = eventKeys.flowCompleted(sessionId) + ':' + nanoid(4)
    await prisma.automationEvent.create({
      data: {
        workspaceId,
        sessionId,
        triggerType: 'flow_completed',
        eventKey,
        source: 'lifecycle',
        acceptedAt: new Date(Date.now() - 10 * 60 * 1000),
        dispatchError: 'previously failed',
      },
    })

    const orphans = await findOrphanAutomationEvents({
      minAgeMs: 60_000,
      maxAgeMs: 60 * 60 * 1000,
      take: 50,
    })
    expect(orphans.every((o) => o.eventKey !== eventKey)).toBe(true)
  })

  it('excludes events still inside the grace window', async () => {
    const eventKey = eventKeys.flowCompleted(sessionId) + ':' + nanoid(4)
    await prisma.automationEvent.create({
      data: {
        workspaceId,
        sessionId,
        triggerType: 'flow_completed',
        eventKey,
        source: 'lifecycle',
        // 30s ago — too fresh for a 60s minAge sweep
      },
    })

    const orphans = await findOrphanAutomationEvents({
      minAgeMs: 60_000,
      maxAgeMs: 60 * 60 * 1000,
      take: 50,
    })
    expect(orphans.every((o) => o.eventKey !== eventKey)).toBe(true)
  })

  it('redispatchAcceptedEvent stamps dispatchedAt and clears prior error', async () => {
    const eventKey = eventKeys.flowCompleted(sessionId) + ':' + nanoid(4)
    const row = await prisma.automationEvent.create({
      data: {
        workspaceId,
        sessionId,
        triggerType: 'flow_completed',
        eventKey,
        source: 'lifecycle',
        dispatchError: 'previous attempt died',
      },
    })

    let dispatched = 0
    await redispatchAcceptedEvent({
      eventId: row.id,
      dispatch: async () => { dispatched++ },
    })

    const after = await prisma.automationEvent.findUnique({ where: { id: row.id } })
    expect(dispatched).toBe(1)
    expect(after!.dispatchedAt).not.toBeNull()
    expect(after!.dispatchError).toBeNull()
  })

  it('a third emitter arriving after orphan redispatch still dedupes', async () => {
    // Setup: original emitter inserted but died, leaving dispatchedAt=null.
    const eventKey = eventKeys.flowCompleted(sessionId) + ':' + nanoid(4)
    const row = await prisma.automationEvent.create({
      data: { workspaceId, sessionId, triggerType: 'flow_completed', eventKey, source: 'lifecycle' },
    })

    // Reconciler redispatches.
    await redispatchAcceptedEvent({ eventId: row.id, dispatch: async () => {} })

    // A delayed sibling emitter (e.g., the public_endpoint path that lost
    // the original race but kept retrying) tries to emit again. The
    // unique constraint still rejects it — we don't want a third dispatch.
    const late = await emitAutomationEvent({
      workspaceId,
      sessionId,
      triggerType: 'flow_completed',
      eventKey,
      source: 'public_endpoint',
      dispatch: async () => { throw new Error('should never run') },
    })
    expect(late.accepted).toBe(false)
    expect(late.reason).toBe('duplicate')
  })
})
