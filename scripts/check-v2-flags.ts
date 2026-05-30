// TEMP DIAGNOSTIC / SAFE TO DELETE
// Confirms V2 flags are still off everywhere after the V2 deploy.
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
;(async () => {
  const wsOn = await p.workspace.count({ where: { pipelineTransitionsV2Enabled: true } })
  const pOn = await p.pipeline.count({ where: { transitionsV2Enabled: true } })
  const wsTotal = await p.workspace.count()
  const pTotal = await p.pipeline.count()
  const rules = await p.pipelineTransitionRule.count()
  const entries = await p.stageEntry.count()
  console.log(`workspaces with V2 on: ${wsOn} / ${wsTotal}`)
  console.log(`pipelines with V2 on:  ${pOn} / ${pTotal}`)
  console.log(`PipelineTransitionRule rows: ${rules}`)
  console.log(`StageEntry rows:            ${entries}`)
  await p.$disconnect()
})()
