'use client'

import { useEffect, useMemo, useState } from 'react'
import { Badge, PageHeader, type BadgeTone } from '@/components/design'
import {
  PLAN_CATALOG,
  BILLING_INTERVALS,
  INTERVAL_LABELS,
  INTERVAL_DISCOUNTS,
  INTERVAL_MONTHS,
  effectiveMonthlyUsd,
  intervalPriceUsd,
  type BillingInterval,
} from '@/lib/billing/plans'

interface BillingStatus {
  tier: 'free' | 'starter' | 'pro' | 'enterprise'
  status: string | null
  inTrial: boolean
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  interval: BillingInterval | null
  hasStripeCustomer: boolean
  limits: Record<string, number | boolean>
  role: string
}

const FEATURES_BY_TIER: Record<'starter' | 'pro' | 'enterprise', string[]> = {
  starter: [
    '2 team seats',
    '3 active flows',
    '5 automation rules',
    '100 candidates / month',
    'Email + SMS notifications',
  ],
  pro: [
    '10 team seats',
    '25 active flows',
    '5 pipelines',
    '50 automation rules',
    '1,000 candidates / month',
    '500 AI Calls minutes / month',
    'Recall.ai meeting recording',
    'Background checks (Certn)',
    'Custom sender domain',
  ],
  enterprise: [
    'Unlimited seats, flows, pipelines',
    'Unlimited automation rules',
    'Unlimited candidates',
    '2,000 AI Calls minutes / month',
    'Recall.ai meeting recording',
    'Background checks (Certn)',
    'Custom sender domain',
    'Priority support',
  ],
}

export default function BillingPage() {
  const [status, setStatus] = useState<BillingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [interval, setInterval] = useState<BillingInterval>('monthly')
  const [busy, setBusy] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null)

  useEffect(() => {
    fetchStatus()
    if (typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search)
      if (q.get('checkout') === 'success') {
        setBanner({ tone: 'success', text: 'Subscription activated. It can take a few seconds to reflect here.' })
      } else if (q.get('checkout') === 'cancelled') {
        setBanner({ tone: 'info', text: 'Checkout cancelled — no charge was made.' })
      }
    }
  }, [])

  const fetchStatus = async () => {
    const r = await fetch('/api/billing/status')
    if (r.ok) setStatus(await r.json())
    setLoading(false)
  }

  const startCheckout = async (tier: 'starter' | 'pro' | 'enterprise') => {
    setBusy(tier)
    try {
      const r = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, interval }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        setBanner({ tone: 'error', text: err.error || 'Checkout failed' })
        return
      }
      const { url } = await r.json()
      if (url) window.location.href = url
    } finally {
      setBusy(null)
    }
  }

  const openPortal = async () => {
    setBusy('portal')
    try {
      const r = await fetch('/api/billing/portal', { method: 'POST' })
      if (!r.ok) {
        setBanner({ tone: 'error', text: 'Could not open billing portal' })
        return
      }
      const { url } = await r.json()
      if (url) window.location.href = url
    } finally {
      setBusy(null)
    }
  }

  // Billing is owner-only. Admins can view the current plan but cannot
  // upgrade/downgrade or open the Stripe portal. Kept the variable name
  // for minimal churn against the existing render sites.
  const isOwnerOrAdmin = status?.role === 'owner'

  const planTone: BadgeTone = useMemo(() => {
    if (!status) return 'neutral'
    if (status.tier === 'enterprise') return 'info'
    if (status.tier === 'pro') return 'brand'
    if (status.tier === 'starter') return 'success'
    return 'neutral'
  }, [status])

  if (loading) {
    return <div className="py-14 text-center font-mono text-[11px] uppercase text-grey-35" style={{ letterSpacing: '0.1em' }}>Loading…</div>
  }

  return (
    <div className="-mx-6 lg:-mx-[132px]">
      <PageHeader
        eyebrow="Settings"
        title="Billing & Plans"
        description="Pick a plan, manage payment methods, view invoices."
        actions={status ? <Badge tone={planTone}>{status.tier}</Badge> : undefined}
      />

      <div className="px-8 py-4 space-y-6">
        {banner && (
          <div
            className={`rounded-[8px] border px-4 py-3 text-[13px] ${
              banner.tone === 'success'
                ? 'border-green-200 bg-green-50 text-green-900'
                : banner.tone === 'error'
                ? 'border-red-200 bg-red-50 text-red-900'
                : 'border-blue-200 bg-blue-50 text-blue-900'
            }`}
          >
            {banner.text}
          </div>
        )}

        {/* Current subscription card */}
        {status && status.status && (
          <div className="bg-white rounded-[12px] border border-surface-border p-6 max-w-3xl">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="text-[11px] uppercase font-mono text-grey-35 mb-1" style={{ letterSpacing: '0.1em' }}>Current subscription</div>
                <div className="text-xl font-semibold text-grey-15 capitalize">{status.tier} plan</div>
                <div className="mt-2 text-[13px] text-grey-35 space-y-1">
                  <div>Status: <span className="text-grey-15 capitalize">{status.status.replace(/_/g, ' ')}</span></div>
                  {status.interval && <div>Billing: <span className="text-grey-15">{INTERVAL_LABELS[status.interval]}</span></div>}
                  {status.inTrial && status.trialEndsAt && (
                    <div>Trial ends: <span className="text-grey-15">{new Date(status.trialEndsAt).toLocaleDateString()}</span></div>
                  )}
                  {status.currentPeriodEnd && !status.inTrial && (
                    <div>
                      {status.cancelAtPeriodEnd ? 'Ends' : 'Renews'}:{' '}
                      <span className="text-grey-15">{new Date(status.currentPeriodEnd).toLocaleDateString()}</span>
                    </div>
                  )}
                  {status.cancelAtPeriodEnd && (
                    <div className="text-[color:var(--danger-fg)]">Will not renew after current period.</div>
                  )}
                </div>
              </div>
              {status.hasStripeCustomer && isOwnerOrAdmin && (
                <button
                  onClick={openPortal}
                  disabled={busy === 'portal'}
                  className="px-4 py-2.5 rounded-[8px] border border-surface-border text-[13px] font-medium text-grey-15 hover:bg-grey-95 disabled:opacity-50"
                >
                  {busy === 'portal' ? 'Opening…' : 'Manage subscription'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Interval toggle */}
        <div className="flex items-center gap-2 max-w-3xl">
          <span className="text-[13px] text-grey-35 mr-2">Billing period:</span>
          <div className="inline-flex bg-grey-95 rounded-[8px] p-1">
            {BILLING_INTERVALS.map((i) => (
              <button
                key={i}
                onClick={() => setInterval(i)}
                className={`px-3 py-1.5 rounded-[6px] text-[12px] font-medium transition-colors ${
                  interval === i ? 'bg-white text-grey-15 shadow-sm' : 'text-grey-35 hover:text-grey-15'
                }`}
              >
                {INTERVAL_LABELS[i]}
                {INTERVAL_DISCOUNTS[i] > 0 && (
                  <span className="ml-1 text-[10px] text-green-700">
                    −{Math.round(INTERVAL_DISCOUNTS[i] * 100)}%
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Plan cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl">
          {PLAN_CATALOG.map((plan) => {
            const isCurrent = status?.tier === plan.tier && status?.interval === interval
            const effMonthly = effectiveMonthlyUsd(plan.monthlyUsd, interval)
            const totalBilled = intervalPriceUsd(plan.monthlyUsd, interval)
            const months = INTERVAL_MONTHS[interval]
            return (
              <div
                key={plan.tier}
                className={`bg-white rounded-[12px] border p-6 flex flex-col ${
                  isCurrent ? 'border-[color:var(--brand-primary)] ring-2 ring-[color:var(--brand-primary)]/15' : 'border-surface-border'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="text-lg font-semibold text-grey-15">{plan.name}</div>
                  {isCurrent && <Badge tone="brand">Current</Badge>}
                </div>
                <p className="text-[13px] text-grey-35 mb-4">{plan.description}</p>

                <div className="mb-4">
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-semibold text-grey-15">${effMonthly}</span>
                    <span className="text-[13px] text-grey-35">/mo</span>
                  </div>
                  {interval !== 'monthly' && (
                    <div className="text-[12px] text-grey-35 mt-1">
                      ${totalBilled.toFixed(2)} billed every {months} months
                    </div>
                  )}
                </div>

                <ul className="space-y-2 mb-6 flex-1">
                  {FEATURES_BY_TIER[plan.tier].map((f) => (
                    <li key={f} className="text-[13px] text-grey-15 flex items-start gap-2">
                      <span className="text-[color:var(--brand-primary)] mt-0.5">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => startCheckout(plan.tier)}
                  disabled={!isOwnerOrAdmin || busy === plan.tier || isCurrent}
                  className={`w-full py-2.5 rounded-[8px] text-[13px] font-medium transition-colors ${
                    isCurrent
                      ? 'bg-grey-95 text-grey-35 cursor-default'
                      : 'bg-[color:var(--brand-primary)] text-white hover:opacity-90'
                  } disabled:opacity-50`}
                  title={!isOwnerOrAdmin ? 'Only the workspace owner can change subscription plans.' : undefined}
                >
                  {isCurrent
                    ? 'Current plan'
                    : busy === plan.tier
                    ? 'Redirecting…'
                    : status?.tier === 'free' || !status?.status
                    ? `Start 14-day trial`
                    : 'Switch to this plan'}
                </button>
              </div>
            )
          })}
        </div>

        {!isOwnerOrAdmin && (
          <div className="text-[12px] text-grey-35 max-w-3xl">
            Only the workspace owner can change subscription plans. Ask your owner to upgrade.
          </div>
        )}
      </div>
    </div>
  )
}
