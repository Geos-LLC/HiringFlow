import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const flow = await prisma.flow.findFirst({
    where: { slug: 'JjeGbRzlG5' },
    select: {
      id: true, name: true, slug: true,
      videoInterviewTimeoutDays: true,
      trainingTimeoutDays: true,
      noShowTimeoutHours: true,
      workspaceId: true,
    },
  })
  console.log('Flow:', flow?.name, flow?.id)
  console.log('  videoInterviewTimeoutDays:', flow?.videoInterviewTimeoutDays)
  console.log('  trainingTimeoutDays:', flow?.trainingTimeoutDays)
  console.log('  noShowTimeoutHours:', flow?.noShowTimeoutHours)
  console.log()

  const ws = await prisma.workspace.findUnique({
    where: { id: flow!.workspaceId },
    select: { id: true, name: true, settings: true },
  })
  console.log('Workspace settings.funnelStages:')
  const settings = ws?.settings as Record<string, unknown> | null
  const stages = settings?.funnelStages
  if (Array.isArray(stages)) {
    for (const st of stages as Array<Record<string, unknown>>) {
      console.log(`  id=${st.id}  order=${st.order}  "${st.label ?? st.name ?? '?'}"  triggers=${JSON.stringify(st.triggers ?? '-')}`)
    }
  } else {
    console.log('  (none) — workspace uses legacy/hardcoded fallback')
  }
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
