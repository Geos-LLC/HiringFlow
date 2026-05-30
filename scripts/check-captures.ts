import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const ids = [
    'd22d5f77-2e66-48f2-8c73-ccba61bbb960', // george test 4
    '672ade05-8832-4899-b339-15a68bd06c76', // george test 3
    '926156d9-ec69-4adf-a884-37bd796fd66e', // geroge test (succeeded)
  ]
  for (const sessionId of ids) {
    const caps = await prisma.captureResponse.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, stepId: true, status: true, mode: true,
        mimeType: true, fileSizeBytes: true, durationSec: true,
        createdAt: true,
      },
    })
    console.log(`${sessionId}  CaptureResponses (${caps.length}):`)
    for (const c of caps) {
      console.log(`  ${c.id}  step=${c.stepId}  status=${c.status}  mode=${c.mode}  mime=${c.mimeType ?? '-'}  size=${c.fileSizeBytes ?? '-'}  created=${c.createdAt.toISOString()}`)
    }
  }
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
