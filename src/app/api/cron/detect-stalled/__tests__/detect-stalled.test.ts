import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import { runStaleDetection } from '../runner'

// Integration tests for the unified stale-detection cron. Hits the real
// Prisma client / DB the rest of the suite uses (Railway prod via .env). Each
// test re-resets sessions in our scoped workspace so the assertions don't
// depend on test ordering or prior runs.

const prisma = new PrismaClient()

let ws: { id: string }
let wsOther: { id: string }
let user: { id: string }
let flow: { id: string }
let flowOther: { id: string }

beforeAll(async () => {
  const hash = await bcrypt.hash('test123', 12)
  user = await prisma.user.create({ data: { email: `stale-${nanoid(6)}@test.com`, passwordHash: hash } })
  ws = await prisma.workspace.create({
    data: { name: 'Stale Test Biz', slug: `stale-${nanoid(6)}`, defaultStalledDays: 7 },
  })
  wsOther = await prisma.workspace.create({
    data: { name: 'Other Biz', slug: `stale-other-${nanoid(6)}`, defaultStalledDays: 7 },
  })
  flow = await prisma.flow.create({
    data: { workspaceId: ws.id, createdById: user.id, name: 'F', slug: `stale-f-${nanoid(6)}` },
  })
  flowOther = await prisma.flow.create({
    data: { workspaceId: wsOther.id, createdById: user.id, name: 'F2', slug: `stale-f2-${nanoid(6)}` },
  })
})

afterAll(async () => {
  await prisma.session.deleteMany({ where: { workspaceId: { in: [ws.id, wsOther.id] } } })
  await prisma.flow.deleteMany({ where: { workspaceId: { in: [ws.id, wsOther.id] } } })
  await prisma.workspace.deleteMany({ where: { id: { in: [ws.id, wsOther.id] } } })
  await prisma.user.deleteMany({ where: { id: user.id } })
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.session.deleteMany({ where: { workspaceId: { in: [ws.id, wsOther.id] } } })
})

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

describe('runStaleDetection — unified inactivity rule', () => {
  it('flips an active candidate with no progress in 8 days to stalled', async () => {
    const s = await prisma.session.create({
      data: {
        workspaceId: ws.id,
        flowId: flow.id,
        candidateName: 'Stale Candidate',
        status: 'active',
        startedAt: daysAgo(10),
        lastProgressAt: daysAgo(8),
      },
    })

    const result = await runStaleDetection({ dryRun: false, workspaceIds: [ws.id] })
    expect(result.stalled).toBeGreaterThanOrEqual(1)

    const after = await prisma.session.findUnique({ where: { id: s.id } })
    expect(after?.status).toBe('stalled')
    expect(after?.stalledAt).not.toBeNull()
    expect(after?.dispositionReason).not.toBeNull()
  })

  it('leaves an active candidate with progress 3 days ago alone', async () => {
    const s = await prisma.session.create({
      data: {
        workspaceId: ws.id,
        flowId: flow.id,
        candidateName: 'Recently Active',
        status: 'active',
        startedAt: daysAgo(10),
        lastProgressAt: daysAgo(3),
      },
    })

    await runStaleDetection({ dryRun: false, workspaceIds: [ws.id] })

    const after = await prisma.session.findUnique({ where: { id: s.id } })
    expect(after?.status).toBe('active')
    expect(after?.stalledAt).toBeNull()
  })

  it('flips a candidate whose lastProgressAt is null but startedAt is old', async () => {
    // Models existing rows that predate the bumpSessionProgress wiring: the
    // column is null but the candidate has been around for 9 days. The
    // fallback to startedAt should catch them.
    const s = await prisma.session.create({
      data: {
        workspaceId: ws.id,
        flowId: flow.id,
        candidateName: 'Legacy Row',
        status: 'active',
        startedAt: daysAgo(9),
        lastProgressAt: null,
      },
    })

    await runStaleDetection({ dryRun: false, workspaceIds: [ws.id] })

    const after = await prisma.session.findUnique({ where: { id: s.id } })
    expect(after?.status).toBe('stalled')
  })

  it('respects a per-workspace threshold override', async () => {
    // ws=7d default. Override to 14d and make the candidate 10d quiet —
    // should NOT stall on a 14d threshold.
    await prisma.workspace.update({ where: { id: ws.id }, data: { defaultStalledDays: 14 } })
    const s = await prisma.session.create({
      data: {
        workspaceId: ws.id,
        flowId: flow.id,
        candidateName: 'Within Override',
        status: 'active',
        startedAt: daysAgo(20),
        lastProgressAt: daysAgo(10),
      },
    })

    await runStaleDetection({ dryRun: false, workspaceIds: [ws.id] })

    const after = await prisma.session.findUnique({ where: { id: s.id } })
    expect(after?.status).toBe('active')

    // Reset for downstream tests.
    await prisma.workspace.update({ where: { id: ws.id }, data: { defaultStalledDays: 7 } })
    await prisma.session.delete({ where: { id: s.id } })
  })

  it('ignores hired / lost / nurture / archived candidates entirely', async () => {
    const seedIds = await Promise.all(
      (['hired', 'lost', 'nurture', 'stalled'] as const).map(async (status) => {
        const s = await prisma.session.create({
          data: {
            workspaceId: ws.id,
            flowId: flow.id,
            candidateName: `Already-${status}`,
            status,
            startedAt: daysAgo(30),
            lastProgressAt: daysAgo(30),
          },
        })
        return { id: s.id, status }
      }),
    )

    await runStaleDetection({ dryRun: false, workspaceIds: [ws.id] })

    for (const { id, status } of seedIds) {
      const after = await prisma.session.findUnique({ where: { id } })
      expect(after?.status).toBe(status)
    }
  })

  it('treats a passive-only candidate (lastActivityAt fresh, lastProgressAt stale) as stalled', async () => {
    // Simulates a candidate who keeps re-opening the training landing page
    // (bumps lastActivityAt) but has actually completed nothing. The cron
    // must trust lastProgressAt, not lastActivityAt.
    const s = await prisma.session.create({
      data: {
        workspaceId: ws.id,
        flowId: flow.id,
        candidateName: 'Page-Opener',
        status: 'active',
        startedAt: daysAgo(15),
        lastProgressAt: daysAgo(15),
        lastActivityAt: daysAgo(1),
      },
    })

    await runStaleDetection({ dryRun: false, workspaceIds: [ws.id] })

    const after = await prisma.session.findUnique({ where: { id: s.id } })
    expect(after?.status).toBe('stalled')
  })

  it('derives scheduling_not_booked for a candidate who got the invite but never picked a slot', async () => {
    const s = await prisma.session.create({
      data: {
        workspaceId: ws.id,
        flowId: flow.id,
        candidateName: 'Never Booked',
        status: 'active',
        finishedAt: daysAgo(10), // flow completed
        startedAt: daysAgo(12),
        lastProgressAt: daysAgo(9),
        schedulingEvents: {
          create: {
            eventType: 'scheduling_invite_sent',
            createdAt: daysAgo(9),
          },
        },
      },
    })

    await runStaleDetection({ dryRun: false, workspaceIds: [ws.id] })

    const after = await prisma.session.findUnique({ where: { id: s.id } })
    expect(after?.status).toBe('stalled')
    expect(after?.dispositionReason).toBe('scheduling_not_booked')
  })

  it('is idempotent — running twice does not re-stamp stalledAt', async () => {
    const s = await prisma.session.create({
      data: {
        workspaceId: ws.id,
        flowId: flow.id,
        candidateName: 'Idem',
        status: 'active',
        startedAt: daysAgo(12),
        lastProgressAt: daysAgo(10),
      },
    })

    await runStaleDetection({ dryRun: false, workspaceIds: [ws.id] })
    const first = await prisma.session.findUnique({ where: { id: s.id } })
    expect(first?.stalledAt).not.toBeNull()
    const firstStamp = first!.stalledAt!.toISOString()

    await runStaleDetection({ dryRun: false, workspaceIds: [ws.id] })
    const second = await prisma.session.findUnique({ where: { id: s.id } })
    // status='active' guard prevents a second stamp — value is preserved.
    expect(second?.stalledAt?.toISOString()).toBe(firstStamp)
  })

  it('dryRun=true does not write anything', async () => {
    const s = await prisma.session.create({
      data: {
        workspaceId: ws.id,
        flowId: flow.id,
        candidateName: 'DryRun',
        status: 'active',
        startedAt: daysAgo(10),
        lastProgressAt: daysAgo(8),
      },
    })

    const result = await runStaleDetection({ dryRun: true })
    expect(result.stalled).toBeGreaterThanOrEqual(1)

    const after = await prisma.session.findUnique({ where: { id: s.id } })
    expect(after?.status).toBe('active')
    expect(after?.stalledAt).toBeNull()
  })
})
