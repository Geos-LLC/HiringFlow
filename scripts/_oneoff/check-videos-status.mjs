import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const rows = await p.video.findMany({
  where: { status: { not: 'ready' } },
  orderBy: { createdAt: 'desc' },
})
console.log(new Date().toISOString().slice(11,19), 'non-ready:', rows.length)
for (const r of rows) {
  const gb = (Number(r.sizeBytes)/1024/1024/1024).toFixed(2)
  console.log(' ', r.status.padEnd(11), gb.padStart(6)+'GB', r.hlsManifestUrl?'hls':'---', r.transcodeError?'ERR:'+String(r.transcodeError).slice(0,50):'---', '|', r.filename)
}
await p.$disconnect()
process.exit(rows.length === 0 ? 0 : 1)
