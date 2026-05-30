// TEMP DIAGNOSTIC / SAFE TO DELETE
import { PrismaClient } from '@prisma/client'
import { listWorkspacePipelinesWithCounts } from '../src/lib/pipelines'
const p = new PrismaClient()
;(async () => {
  const wsList = await p.workspace.findMany({ select: { id: true, name: true } })
  for (const ws of wsList) {
    const rows = await listWorkspacePipelinesWithCounts(ws.id)
    if (rows.length === 0) continue
    console.log(`\n=== ${ws.name} (${ws.id}) ===`)
    rows.forEach((r, i) => {
      console.log(`  ${i+1}. ${r.pipeline.isDefault ? '[DEFAULT] ' : '         '}${r.pipeline.name}  (createdAt=${r.pipeline.createdAt.toISOString()})`)
    })
  }
  await p.$disconnect()
})()
