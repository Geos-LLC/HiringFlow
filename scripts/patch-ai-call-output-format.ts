import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const OUTPUT_FORMAT_FOOTER = `**OUTPUT FORMAT — REQUIRED:**
Your rationale MUST begin with the lines below, in this exact order, using these exact headers. Bullets must start with "- ". Do not output any other format.

Score: <N>/100 (<Excellent | Good | Needs Improvement | Requires Retraining>)

Areas Done Well:
- <one short sentence per item>

Areas for Improvement:
- <one short sentence per item>`

async function main() {
  const platformKey = await prisma.platformSetting.findUnique({ where: { key: 'elevenlabs_api_key' } })
  if (!platformKey?.value) throw new Error('No api key')
  const apiKey = platformKey.value
  const agentId = 'agent_4501k18xybcmfrqatj21c99egrza'

  const ar = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    headers: { 'xi-api-key': apiKey },
  })
  const agent = await ar.json()
  const criteria = agent.platform_settings?.evaluation?.criteria || []
  const c0 = criteria[0]
  if (!c0) throw new Error('No criteria on agent')

  const current: string = c0.conversation_goal_prompt || ''
  if (current.includes('OUTPUT FORMAT — REQUIRED')) {
    console.log('Already has OUTPUT FORMAT footer, nothing to do')
    return
  }
  const next = current.trimEnd() + '\n\n' + OUTPUT_FORMAT_FOOTER

  console.log(`Patching agent ${agentId} criteria ${c0.id} (${c0.name})`)
  console.log(`Old length: ${current.length} → new length: ${next.length}`)

  const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform_settings: {
        evaluation: {
          criteria: [{
            id: c0.id,
            name: c0.name,
            type: 'prompt',
            conversation_goal_prompt: next,
          }],
        },
      },
    }),
  })
  if (!r.ok) {
    console.error('Patch failed:', r.status, await r.text())
    return
  }
  console.log('Patch succeeded.')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
