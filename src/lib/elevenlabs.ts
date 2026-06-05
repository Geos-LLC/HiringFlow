import { prisma } from '@/lib/prisma'

// Temporary dual-key support: both PlatformSetting rows are honored so AI Calls
// can talk to two ElevenLabs accounts at once. Remove the `_2` row and revert
// callers to a single key when the second account is no longer needed.
export async function getElevenLabsApiKeys(): Promise<string[]> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: ['elevenlabs_api_key', 'elevenlabs_api_key_2'] } },
  })
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  return [byKey.get('elevenlabs_api_key'), byKey.get('elevenlabs_api_key_2')]
    .filter((v): v is string => !!v)
}

// Try each key in order; return the first response whose status is 2xx.
// If every key 4xx/5xx's, return the last response so the caller can surface
// the upstream status code/body.
export async function fetchWithEachKey(
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const keys = await getElevenLabsApiKeys()
  let last: Response | null = null
  for (const key of keys) {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), 'xi-api-key': key },
    })
    if (res.ok) return res
    last = res
  }
  return last ?? new Response(JSON.stringify({ error: 'No ElevenLabs API key configured' }), { status: 400 })
}
