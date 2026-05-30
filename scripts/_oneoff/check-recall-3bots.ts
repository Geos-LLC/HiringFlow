import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
const REGION_BASE_URLS: any = { 'us-east-1':'https://us-east-1.recall.ai','us-west-2':'https://us-west-2.recall.ai','eu-central-1':'https://eu-central-1.recall.ai','ap-northeast-1':'https://ap-northeast-1.recall.ai' }
async function recall(path: string) {
  const url = `${REGION_BASE_URLS[process.env.RECALL_REGION||'us-east-1']}${path}`
  const res = await fetch(url, { headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` } })
  return { status: res.status, body: await res.json().catch(()=>null) }
}
async function dump(label: string, botId: string) {
  console.log('\n=== '+label+' bot='+botId+' ===')
  const b = await recall(`/api/v1/bot/${botId}/`)
  const bo: any = b.body
  console.log('meeting_url:', JSON.stringify(bo?.meeting_url))
  console.log('join_at:', bo?.join_at)
  console.log('status_changes:')
  for (const sc of (bo?.status_changes||[])) console.log('  '+sc.created_at+'  '+sc.code+'  '+(sc.sub_code||'')+'  '+(sc.message||''))
  console.log('recordings: '+ (bo?.recordings||[]).length)
  for (const r of (bo?.recordings||[])) {
    console.log('  rec '+r.id+'  started='+r.started_at+' completed='+r.completed_at)
    const ms = r.media_shortcuts || {}
    console.log('    video.url present:'+!!ms.video_mixed?.data?.download_url+'  audio.url:'+!!ms.audio_mixed?.data?.download_url+'  transcript.url:'+!!ms.transcript?.data?.download_url)
  }
  const p = await recall(`/api/v1/bot/${botId}/participants/`)
  console.log('participants endpoint -> '+p.status)
  if (p.status===200) { const arr=(p.body as any)?.results||[]; console.log('participants:'+arr.length); for (const x of arr) console.log('  '+x.name+' host='+x.is_host+' events='+(x.events||[]).length) }
  // local HF record
  const m = await prisma.interviewMeeting.findFirst({ where: { recallBotId: botId } })
  if (m) {
    const events = await prisma.schedulingEvent.findMany({ where: { sessionId: m.sessionId }, orderBy:{eventAt:'asc'}, select:{eventType:true, eventAt:true, metadata:true} })
    console.log('\nHF SchedulingEvents for sessionId '+m.sessionId+':')
    for (const e of events) console.log('  '+e.eventAt.toISOString()+'  '+e.eventType+'  '+JSON.stringify(e.metadata||{}).slice(0,200))
    const arts = await prisma.interviewMeetingArtifact.findMany({ where:{interviewMeetingId:m.id}, orderBy:{discoveredAt:'asc'} })
    console.log('HF artifacts: '+arts.length)
    for (const a of arts) console.log('  '+a.kind+' drive='+(a.driveFileId||'-')+' discovered='+a.discoveredAt.toISOString())
  }
}
async function main(){
  // Henry's bot (latest completed)
  await dump('Henry', '0425b03a-55e2-4b77-9c5f-f9d97ae40aad')
  // Igor's bot (also Recall but stuck)
  await dump('Igor (recordingState=requested)', '60454f0d-411d-466d-963a-2e20368d9c4f')
  // Shedrack (the one that fully worked)
  await dump('Shedrack (full success)', '842b2935-ea46-49f7-85dc-525ce5a7002b')
  await prisma.$disconnect()
}
main().catch(e=>{console.error(e);process.exit(1)}).finally(()=>process.exit(0))
