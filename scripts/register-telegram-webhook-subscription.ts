/**
 * One-time bootstrap: register HF as a subscriber to Sigcore's
 * `telegram.placement.sent` and `telegram.placement.failed` outbound events.
 *
 * Once this script has run once against prod, Sigcore will POST to
 *   {APP_BASE_URL}/api/webhooks/sigcore/telegram-placement
 * for every per-channel placement callback. The route's HMAC verify uses
 * `SIGCORE_WEBHOOK_KEY` (already shared with the SMS subscription, so we
 * pass the same value as the subscription `secret`).
 *
 * Idempotency:
 *   - Sigcore /api/webhooks/subscriptions accepts the same payload repeatedly
 *     and returns the existing subscription if `name` collides. We pass a
 *     deterministic name so repeated runs are safe.
 *
 * Usage:
 *   # Local against staging Sigcore:
 *   set -a; source .env; set +a
 *   SIGCORE_API_URL=https://sigcore-staging.up.railway.app \
 *     npx tsx scripts/register-telegram-webhook-subscription.ts --dry-run
 *
 *   # Against prod:
 *   set -a; source .env.prod; set +a
 *   npx tsx scripts/register-telegram-webhook-subscription.ts --apply
 *
 * Env required:
 *   SIGCORE_API_URL, SIGCORE_API_KEY, SIGCORE_WEBHOOK_KEY,
 *   APP_BASE_URL (e.g. https://hirefunnel.app)
 */

const REQUIRED_EVENTS = ['telegram.placement.sent', 'telegram.placement.failed'] as const
const SUBSCRIPTION_NAME = 'HF Telegram placement events'

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

  const webhookUrl = `${appBaseUrl!.replace(/\/+$/, '')}/api/webhooks/sigcore/telegram-placement`
  const payload = {
    name: SUBSCRIPTION_NAME,
    webhookUrl,
    secret: webhookKey,
    events: REQUIRED_EVENTS,
  }

  console.log('Sigcore URL :', apiUrl)
  console.log('Webhook URL :', webhookUrl)
  console.log('Events      :', REQUIRED_EVENTS.join(', '))
  console.log('Mode        :', apply ? 'APPLY' : 'DRY-RUN (pass --apply to write)')

  if (!apply) {
    console.log('\nPayload that would be POSTed:')
    console.log(JSON.stringify({ ...payload, secret: '*****' }, null, 2))
    return
  }

  const res = await fetch(`${apiUrl!.replace(/\/+$/, '')}/api/webhooks/subscriptions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey!,
    },
    body: JSON.stringify(payload),
  })

  const text = await res.text()
  console.log(`\nResponse: ${res.status} ${res.statusText}`)
  console.log(text)
  if (!res.ok) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
