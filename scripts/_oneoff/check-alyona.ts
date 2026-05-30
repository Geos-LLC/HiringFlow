import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const REGION_BASE_URLS: any = {
  'us-east-1': 'https://us-east-1.recall.ai',
  'us-west-2': 'https://us-west-2.recall.ai',
  'eu-central-1': 'https://eu-central-1.recall.ai',
  'ap-northeast-1': 'https://ap-northeast-1.recall.ai',
}

async function recall(path: string) {
  const url = `${REGION_BASE_URLS[process.env.RECALL_REGION || 'us-east-1']}${path}`
  const res = await fetch(url, { headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

;(async () => {
  const email = 'alser2026@ukr.net'
  const sessions = await prisma.session.findMany({
    where: { candidateEmail: { equals: email, mode: 'insensitive' } },
    select: {
      id: true,
      candidateName: true,
      candidateEmail: true,
      status: true,
      dispositionReason: true,
      pipelineStatus: true,
      startedAt: true,
      finishedAt: true,
      interviewMeetings: {
        select: {
          id: true,
          scheduledStart: true,
          scheduledEnd: true,
          actualStart: true,
          actualEnd: true,
          attendanceSource: true,
          meetSpaceName: true,
          meetingCode: true,
          meetingUri: true,
          recordingState: true,
          transcriptState: true,
          recallRecordingId: true,
          recallBotId: true,
          confirmedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { scheduledStart: 'desc' },
      },
      schedulingEvents: {
        select: {
          id: true,
          eventType: true,
          createdAt: true,
          metadata: true,
          eventAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: 60,
      },
      pipelineStatusChanges: {
        select: {
          fromStatus: true,
          toStatus: true,
          source: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  for (const s of sessions) {
    console.log(`\n=== session ${s.id} ${s.candidateName} <${s.candidateEmail}> ===`)
    console.log(`status=${s.status} dispositionReason=${s.dispositionReason || '-'} pipelineStatus=${s.pipelineStatus}`)
    console.log(`startedAt=${s.startedAt?.toISOString()} finishedAt=${s.finishedAt?.toISOString() || '-'}`)

    for (const m of s.interviewMeetings) {
      console.log(`\nmeeting ${m.id}`)
      console.log(`  scheduled: ${m.scheduledStart?.toISOString()} -> ${m.scheduledEnd?.toISOString()}`)
      console.log(`  actual:    ${m.actualStart?.toISOString() || '-'} -> ${m.actualEnd?.toISOString() || '-'}`)
      console.log(`  meetingUri: ${m.meetingUri}`)
      console.log(`  recallBotId: ${m.recallBotId || '(none)'}  src=${m.attendanceSource}`)
      console.log(`  recordingState: ${m.recordingState}  transcriptState: ${m.transcriptState}`)
      console.log(`  createdAt: ${m.createdAt.toISOString()}  updatedAt: ${m.updatedAt.toISOString()}`)

      if (m.recallBotId) {
        const b = await recall(`/api/v1/bot/${m.recallBotId}/`)
        const bo: any = b.body
        console.log(`  recall bot (HTTP ${b.status}):`)
        if (bo) {
          console.log(`    meeting_url: ${JSON.stringify(bo.meeting_url)}`)
          console.log(`    join_at: ${bo.join_at}`)
          console.log(`    status_changes:`)
          for (const sc of bo.status_changes || []) {
            console.log(`      ${sc.created_at}  ${sc.code}  ${sc.sub_code || ''}  ${(sc.message || '').slice(0, 200)}`)
          }
          console.log(`    recordings: ${(bo.recordings || []).length}`)
          for (const r of bo.recordings || []) {
            console.log(`      rec ${r.id} started=${r.started_at} completed=${r.completed_at}`)
          }
        }
        const p = await recall(`/api/v1/bot/${m.recallBotId}/participants/`)
        console.log(`  participants endpoint -> ${p.status}`)
        if (p.status === 200) {
          const arr = (p.body as any)?.results || []
          console.log(`  participants: ${arr.length}`)
          for (const x of arr) console.log(`    ${x.name} host=${x.is_host} events=${(x.events || []).length}`)
        }
      }

      const arts = await prisma.interviewMeetingArtifact.findMany({
        where: { interviewMeetingId: m.id },
        orderBy: { discoveredAt: 'asc' },
      })
      console.log(`  artifacts: ${arts.length}`)
      for (const a of arts) console.log(`    ${a.kind} drive=${a.driveFileId || '-'} discovered=${a.discoveredAt.toISOString()}`)
    }

    console.log(`\nscheduling events (oldest first, ${s.schedulingEvents.length}):`)
    for (const e of s.schedulingEvents) {
      const md = JSON.stringify(e.metadata || {}).slice(0, 260)
      console.log(`  ${e.createdAt.toISOString()}  ${e.eventType}  ${md}`)
    }

    console.log(`\npipeline status changes:`)
    for (const c of s.pipelineStatusChanges) {
      console.log(`  ${c.createdAt.toISOString()}  ${c.fromStatus || '(start)'} -> ${c.toStatus}  src=${c.source}`)
    }
  }

  await prisma.$disconnect()
})()
