/**
 * Bootstrap: register HF as a subscriber to Sigcore's outbound Telegram events.
 *
 * Two subscriptions are registered (each with its own webhook URL + HMAC
 * secret reused from `SIGCORE_WEBHOOK_KEY`):
 *
 *   1. HF Telegram placement events  → /api/webhooks/sigcore/telegram-placement
 *      events: telegram.placement.sent, telegram.placement.failed
 *
 *   2. HF Telegram account events    → /api/webhooks/sigcore/telegram-account
 *      events: telegram.account.linked, telegram.account.revoked
 *      (account-mode v2 — Sigcore wrapper must be live for these to fire)
 *
 * Both routes verify with the existing SIGCORE_WEBHOOK_KEY HMAC contract
 * (X-Callio-Signature / X-Callio-Timestamp, ±5 min skew).
 *
 * Idempotency:
 *   - Sigcore /api/webhooks/subscriptions accepts the same payload repeatedly
 *     and returns the existing subscription if `name` collides. Names are
 *     deterministic so repeated runs are safe — re-running this script after
 *     the placement subscription was registered will skip-or-noop on it and
 *     only register the account subscription if it's missing.
 *
 * Usage:
 *   # Local against staging Sigcore:
 *   set -a; source .env; set +a
 *   SIGCORE_API_URL=https://sigcore-staging.up.railway.app \
 *     npx tsx scripts/register-telegram-webhook-subscription.ts
 *
 *   # Against prod (apply):
 *   set -a; source .env.prod; set +a
 *   APP_BASE_URL=https://hirefunnel.app \
 *     npx tsx scripts/register-telegram-webhook-subscription.ts --apply
 *
 * Env required:
 *   SIGCORE_API_URL, SIGCORE_API_KEY, SIGCORE_WEBHOOK_KEY,
 *   APP_BASE_URL (e.g. https://hirefunnel.app)
 */

interface SubscriptionConfig {
  name: string
  path: string
  events: readonly string[]
}

const SUBSCRIPTIONS: SubscriptionConfig[] = [
  {
    name: 'HF Telegram placement events',
    path: '/api/webhooks/sigcore/telegram-placement',
    events: ['telegram.placement.sent', 'telegram.placement.failed'],
  },
  {
    name: 'HF Telegram account events',
    path: '/api/webhooks/sigcore/telegram-account',
    events: ['telegram.account.linked', 'telegram.account.revoked'],
  },
]

async function main() {
  const apply = process.argv.includes('--apply')
  const apiUrl = process.env.SIGCORE_API_URL?.trim()
  const apiKey = process.env.SIGCORE_API_KEY?.trim()
  const webhookKey = process.env.SIGCORE_WEBHOOK_KEY?.trim()
  const appBaseUrl = process.env.APP_BASE_URL?.trim()

  const missing: string[] = []
  if (!apiUrl) missing.push('SIGCORE_API_URL')
  if (!apiKey) missing.push('SIGCORE_API_KEY')
  if (!webhookKey) missing.push('SIGCORE_WEBHOOK_KEY')
  if (!appBaseUrl) missing.push('APP_BASE_URL')
  if (missing.length > 0) {
    console.error('Missing env vars:', missing.join(', '))
    process.exit(1)
  }

  console.log('Sigcore URL :', apiUrl)
  console.log('App base    :', appBaseUrl)
  console.log('Mode        :', apply ? 'APPLY' : 'DRY-RUN (pass --apply to write)')
  console.log('')

  const apiBase = apiUrl!.replace(/\/+$/, '')
  const appBase = appBaseUrl!.replace(/\/+$/, '')

  let failed = 0
  for (const sub of SUBSCRIPTIONS) {
    const webhookUrl = `${appBase}${sub.path}`
    const payload = {
      name: sub.name,
      webhookUrl,
      secret: webhookKey,
      events: sub.events,
    }

    console.log(`── ${sub.name}`)
    console.log(`   URL    : ${webhookUrl}`)
    console.log(`   Events : ${sub.events.join(', ')}`)

    if (!apply) {
      console.log('   Payload:', JSON.stringify({ ...payload, secret: '*****' }))
      console.log('')
      continue
    }

    try {
      const res = await fetch(`${apiBase}/api/webhooks/subscriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey!,
        },
        body: JSON.stringify(payload),
      })
      const text = await res.text()
      console.log(`   Result : ${res.status} ${res.statusText}`)
      console.log(`            ${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`)
      if (!res.ok) failed++
    } catch (err) {
      console.error(`   Error  : ${(err as Error).message}`)
      failed++
    }
    console.log('')
  }

  if (failed > 0) {
    console.error(`${failed}/${SUBSCRIPTIONS.length} subscription(s) failed`)
    process.exit(1)
  }
  console.log(`All ${SUBSCRIPTIONS.length} subscription(s) ${apply ? 'registered' : 'previewed'}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
