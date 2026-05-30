import { PrismaClient } from '@prisma/client'
import { getAuthedClientForWorkspace } from '../../src/lib/google'
import { searchMeetRecordings, findMeetRecordingsFolderId } from '../../src/lib/meet/google-drive'

const prisma = new PrismaClient()

;(async () => {
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'
  const meetingCode = 'jaj-acxe-ayr'

  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) { console.log('no client'); process.exit(1) }

  const integ = await prisma.googleIntegration.findUnique({
    where: { workspaceId },
    select: { meetRecordingsFolderId: true },
  })
  const folderId = integ?.meetRecordingsFolderId
    ?? await findMeetRecordingsFolderId(authed.client).catch(() => null)
  console.log('folderId:', folderId)

  const matches = await searchMeetRecordings(authed.client, {
    folderId,
    meetingCode,
    limit: 10,
  })
  console.log(`matches for code=${meetingCode}: ${matches.length}`)
  for (const f of matches) {
    console.log(' ', f.id, '  ', f.createdTime, '  size=', f.size, '  ', f.name)
  }

  await prisma.$disconnect()
})()
