/**
 * Query Recall.ai directly for Tetiana's bot + look at the most recent
 * Recall-attached meeting in the workspace to see why "the last recording
 * has the bot but no records as well."
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const WORKSPACE_ID = '739bcd71-69fd-4b30-a39e-242521b7ab20' // Spotless Homes Florida LLC
const TETIANA_BOT_ID = 'de2f6f06-128a-4ee7-a202-7d9b123d4469'

const REGION_BASE_URLS: Record<string, string> = {
  'us-east-1': 'https://us-east-1.recall.ai',
  'us-west-2': 'https://us-west-2.recall.ai',
  'eu-central-1': 'https://eu-central-1.recall.ai',
  'ap-northeast-1': 'https://ap-northeast-1.recall.ai',
}

function baseUrl() {
  const region = process.env.RECALL_REGION || 'us-east-1'
  return REGION_BASE_URLS[region]
}

async function recall(path: string) {
  const key = process.env.RECALL_API_KEY
  if (!key) throw new Error('RECALL_API_KEY not set')
  const url = `${baseUrl()}${path}`
  const res = await fetch(url, { headers: { Authorization: `Token ${key}` } })
  const text = await res.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

async function dumpBot(label: string, botId: string) {
  console.log('\n' + '#'.repeat(60))
  console.log(`# ${label}: bot ${botId}`)
  console.log('#'.repeat(60))

  const bot = await recall(`/api/v1/bot/${encodeURIComponent(botId)}/`)
  console.log(`GET /bot/ → ${bot.status}`)
  if (bot.status === 200 && typeof bot.body === 'object' && bot.body) {
    const b = bot.body as any
    console.log(`  bot_name: ${b.bot_name}`)
    console.log(`  meeting_url: ${JSON.stringify(b.meeting_url)}`)
    console.log(`  join_at: ${b.join_at}`)
    console.log(`  metadata: ${JSON.stringify(b.metadata)}`)
    console.log(`  status_changes:`)
    for (const sc of (b.status_changes || [])) {
      console.log(`    ${sc.created_at}  ${sc.code}  ${sc.message ?? ''} ${sc.sub_code ? '['+sc.sub_code+']' : ''}`)
    }
    console.log(`  recordings: ${(b.recordings || []).length}`)
    for (const r of (b.recordings || [])) {
      console.log(`    recording ${r.id}  started=${r.started_at}  completed=${r.completed_at}`)
      const ms = r.media_shortcuts || {}
      console.log(`      video=${!!ms.video_mixed?.data?.download_url}  audio=${!!ms.audio_mixed?.data?.download_url}  transcript=${!!ms.transcript?.data?.download_url}`)
    }
  } else {
    console.log('  body:', JSON.stringify(bot.body).slice(0, 600))
  }

  const parts = await recall(`/api/v1/bot/${encodeURIComponent(botId)}/participants/`)
  console.log(`\nGET /participants/ → ${parts.status}`)
  if (parts.status === 200 && typeof parts.body === 'object' && parts.body) {
    const results = (parts.body as any).results || []
    console.log(`  participants count: ${results.length}`)
    for (const p of results) {
      const joins = (p.events || []).filter((e: any) => /join/i.test(e.code)).map((e: any) => e.created_at).sort()
      const leaves = (p.events || []).filter((e: any) => /leave/i.test(e.code)).map((e: any) => e.created_at).sort()
      console.log(`    id=${p.id} name=${p.name ?? '-'} host=${p.is_host} email=${p.extra_data?.email ?? '-'}`)
      console.log(`      first_join=${joins[0] ?? '-'}  last_leave=${leaves[leaves.length-1] ?? '-'}  events=${(p.events||[]).length}`)
    }
  }
}

async function main() {
  console.log(`NOW: ${new Date().toISOString()}`)
  console.log(`RECALL_REGION = ${process.env.RECALL_REGION || 'us-east-1'}`)
  console.log(`RECALL_API_KEY set: ${!!process.env.RECALL_API_KEY}`)

  await dumpBot('Tetiana (orig book against old Meet URL pgv-tprd-yig)', TETIANA_BOT_ID)

  // Most recent meeting in this workspace with a recallBotId — to look at
  // "the last recording" case the user mentioned.
  const recent = await prisma.interviewMeeting.findMany({
    where: { workspaceId: WORKSPACE_ID, recallBotId: { not: null } },
    orderBy: { scheduledStart: 'desc' },
    take: 5,
    include: { session: { select: { candidateName: true, candidateEmail: true } } },
  })
  console.log(`\nLatest 5 meetings in workspace with recallBotId:`)
  for (const m of recent) {
    console.log(`  ${m.id}  candidate=${m.session?.candidateName} <${m.session?.candidateEmail}>`)
    console.log(`    scheduled=${m.scheduledStart.toISOString()} → ${m.scheduledEnd.toISOString()}`)
    console.log(`    meetingUri=${m.meetingUri}`)
    console.log(`    recallBotId=${(m as any).recallBotId}`)
    console.log(`    attendanceSource=${(m as any).attendanceSource}  recordingProvider=${(m as any).recordingProvider}  recordingState=${(m as any).recordingState}`)
    console.log(`    driveRecordingFileId=${(m as any).driveRecordingFileId ?? '-'}  recallRecordingId=${(m as any).recallRecordingId ?? '-'}`)
  }

  if (recent.length) {
    const latest = recent[0]
    const latestBotId = (latest as any).recallBotId as string
    if (latestBotId && latestBotId !== TETIANA_BOT_ID) {
      await dumpBot(`Latest meeting (${latest.session?.candidateName})`, latestBotId)
    } else {
      // pick the 2nd most recent that isn't Tetiana's
      const other = recent.find(m => (m as any).recallBotId !== TETIANA_BOT_ID)
      if (other) {
        await dumpBot(`Latest non-Tetiana meeting (${other.session?.candidateName})`, (other as any).recallBotId)
      }
    }
  }

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
