import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const cutoff = new Date(Date.now() - 24*3600*1000)
const stale = await p.video.findMany({
  where: { status: 'uploading', createdAt: { lt: cutoff } },
  select: { id: true, filename: true, createdAt: true, workspaceId: true },
})
console.log('Stale uploading rows (>24h old):', stale.length)
stale.forEach(r => console.log(' ', r.createdAt.toISOString(), r.id, '|', r.filename))
if (stale.length === 0) { await p.$disconnect(); process.exit(0) }
const upd = await p.video.updateMany({
  where: { id: { in: stale.map(r => r.id) } },
  data: { status: 'failed', transcodeError: 'Upload never completed — R2 staging file expired (24h lifecycle). Please re-upload.' },
})
console.log('Updated:', upd.count)
await p.$disconnect()
