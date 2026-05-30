import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function main() {
  const k = await prisma.platformSetting.findUnique({ where: { key: 'elevenlabs_api_key' } })
  if (!k?.value) return
  const r = await fetch('https://api.elevenlabs.io/v1/convai/conversations?agent_id=agent_4501k18xybcmfrqatj21c99egrza&page_size=25', { headers: { 'xi-api-key': k.value } })
  const list = (await r.json()).conversations || []
  console.log('Total returned:', list.length)
  for (const c of list) {
    const t = new Date((c.start_time_unix_secs || 0) * 1000).toISOString()
    console.log(c.conversation_id.slice(0, 28), t, c.status, 'success=' + JSON.stringify(c.call_successful), c.call_duration_secs + 's', c.message_count + 'msgs')
  }

  // Show candidate Volodimir's linked convs and their parsed status from the public link endpoint
  console.log('\n--- Candidate Volodimir linked conversations ---')
  const cand = await prisma.aICallCandidate.findFirst({ where: { name: 'Volodimir' }, orderBy: { createdAt: 'desc' } })
  console.log('candidate id=' + cand?.id, 'conversationIds=' + cand?.conversationIds.length)
  if (cand) for (const cid of cand.conversationIds) console.log('  ', cid)
}
main().catch(e => console.error(e)).finally(() => prisma.$disconnect())
