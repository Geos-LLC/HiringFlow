import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const sessionIds = [
    'd22d5f77-2e66-48f2-8c73-ccba61bbb960', // george test 4 (new, no exec)
    '926156d9-ec69-4adf-a884-37bd796fd66e', // geroge test (old, 1 exec)
    '672ade05-8832-4899-b339-15a68bd06c76', // George test 3
  ]
  for (const sessionId of sessionIds) {
    console.log('='.repeat(80))
    console.log('SESSION', sessionId)

  const audit = await prisma.pipelineStatusChange.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, fromStatus: true, toStatus: true, source: true, metadata: true },
  })
  console.log(`Audit (${audit.length}):`)
  for (const a of audit) {
    console.log(`  ${a.createdAt.toISOString()}  ${a.fromStatus ?? '∅'} -> ${a.toStatus}  src=${a.source}  meta=${a.metadata ? JSON.stringify(a.metadata).slice(0, 160) : '-'}`)
  }
  console.log()

  const subs = await prisma.candidateSubmission.findMany({
    where: { sessionId },
    select: { stepId: true, videoStorageKey: true, videoFilename: true, videoMimeType: true, submittedAt: true, textMessage: true },
  })
  console.log(`Submissions (${subs.length}):`)
  for (const s of subs) {
    console.log(`  step=${s.stepId} videoKey=${s.videoStorageKey ? s.videoStorageKey.slice(0, 60) : '-'} videoFile=${s.videoFilename ?? '-'} mime=${s.videoMimeType ?? '-'} submittedAt=${s.submittedAt?.toISOString()} text=${s.textMessage?.slice(0, 60) ?? '-'}`)
  }
  console.log()

  const answers = await prisma.sessionAnswer.findMany({
    where: { sessionId },
    orderBy: { answeredAt: 'asc' },
    select: { stepId: true, answeredAt: true, optionId: true },
  })
  console.log(`Answers (${answers.length}):`)
  for (const a of answers) {
    console.log(`  ${a.answeredAt?.toISOString()} step=${a.stepId} opt=${a.optionId ?? '-'}`)
  }
  console.log()
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
