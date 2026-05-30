import Stripe from 'stripe'

// Lazy singleton — STRIPE_SECRET_KEY only required when billing endpoints are
// actually hit. Lets the rest of the app boot in environments without Stripe
// configured (CI, preview deploys without secrets, etc.).
let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (_stripe) return _stripe
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY not configured')
  }
  _stripe = new Stripe(key, {
    apiVersion: '2026-05-27.dahlia',
    typescript: true,
    appInfo: { name: 'HiringFlow', version: '1.0.0' },
  })
  return _stripe
}

export function stripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured')
  return secret
}
