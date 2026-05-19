/**
 * Marketing landing page — port of Design/landing-page.tsx. Sections (in order):
 *   1. Navbar
 *   2. Hero
 *   3. Logo strip
 *   4. Pain points (Old way vs Hirefunnel way)
 *   5. Feature triptych (branching / anti-AI / paid training)
 *   6. Feature rows (flow builder, analytics)
 *   7. How it works (4-step)
 *   8. Social proof (testimonial + 3 metrics)
 *   9. Pricing (3 tiers, Growth highlighted)
 *   10. FAQ (accordion)
 *   11. CTA band
 *   12. Footer
 *
 * Wordmark locked to "HireFunnel" (capital F) per product decision. The
 * design file uses "Hirefunnel"; we deliberately diverge here.
 */

'use client'

import Link from 'next/link'
import { useState } from 'react'

/* ------------------------------------------------------------------ */
/*  Icons — inline, stroke-based                                      */
/* ------------------------------------------------------------------ */
function Icon({ name, size = 20, className = '' }: { name: string; size?: number; className?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
  }
  switch (name) {
    case 'check':
      return (<svg {...common}><path d="M20 6 9 17l-5-5" /></svg>)
    case 'cross':
      return (<svg {...common}><path d="M18 6 6 18M6 6l12 12" /></svg>)
    case 'chevron':
      return (<svg {...common}><path d="m9 18 6-6-6-6" /></svg>)
    case 'branch':
      return (<svg {...common}><path d="M6 3v18" /><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M18 9c0 4-6 3-6 9" /></svg>)
    case 'shield':
      return (<svg {...common}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>)
    case 'sparkle':
      return (<svg {...common}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></svg>)
    case 'play':
      return (<svg {...common}><path d="M6 4v16l14-8L6 4Z" /></svg>)
    case 'arrow':
      return (<svg {...common}><path d="M5 12h14M13 6l6 6-6 6" /></svg>)
    case 'twitter':
      return (<svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>)
    case 'linkedin':
      return (<svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.37V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.26 2.37 4.26 5.45zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56z" /></svg>)
    default:
      return null
  }
}

/* ------------------------------------------------------------------ */
/*  Small primitives                                                  */
/* ------------------------------------------------------------------ */
function Eyebrow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`font-mono text-[11px] uppercase text-grey-35 mb-5 ${className}`} style={{ letterSpacing: '0.16em' }}>
      {children}
    </div>
  )
}

function SectionHeading({
  eyebrow,
  title,
  sub,
  align = 'left',
  titleAs = 'h2',
}: {
  eyebrow: string
  title: React.ReactNode
  sub?: React.ReactNode
  align?: 'left' | 'center'
  titleAs?: 'h2' | 'h3'
}) {
  const Tag = titleAs
  return (
    <div className={align === 'center' ? 'text-center mx-auto max-w-[640px]' : ''}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <Tag
        className="text-[40px] md:text-[48px] font-semibold text-ink leading-[1.05] mb-5"
        style={{ letterSpacing: '-0.02em' }}
      >
        {title}
      </Tag>
      {sub ? (
        <p className={`text-[17px] text-grey-35 leading-[1.55] ${align === 'center' ? 'mx-auto' : ''} max-w-[600px]`}>
          {sub}
        </p>
      ) : null}
    </div>
  )
}

function OrangeCheck({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center flex-shrink-0 rounded-full mt-[3px]"
      style={{ width: size, height: size, background: 'rgba(255,149,0,0.14)', color: '#C2710A' }}
    >
      <Icon name="check" size={size - 4} />
    </span>
  )
}

/* ------------------------------------------------------------------ */
/*  Navbar                                                            */
/* ------------------------------------------------------------------ */
function Navbar() {
  return (
    <nav className="border-b border-surface-border sticky top-0 bg-[#FAF8F5]/85 backdrop-blur-sm z-50">
      <div className="max-w-[1200px] mx-auto px-6 md:px-10 flex items-center justify-between h-[64px]">
        <div className="flex items-center gap-10">
          <Link href="/" className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white font-bold text-[17px]"
              style={{ background: 'var(--brand-primary)', boxShadow: 'var(--shadow-brand)' }}
            >
              h
            </div>
            <span className="text-[16px] font-semibold text-ink" style={{ letterSpacing: '-0.01em' }}>
              HireFunnel
            </span>
          </Link>
          <div className="hidden md:flex items-center gap-7">
            <a href="#features" className="text-[13px] text-grey-35 hover:text-ink transition-colors">Features</a>
            <a href="#how-it-works" className="text-[13px] text-grey-35 hover:text-ink transition-colors">How it works</a>
            <a href="#pricing" className="text-[13px] text-grey-35 hover:text-ink transition-colors">Pricing</a>
            <a href="#faq" className="text-[13px] text-grey-35 hover:text-ink transition-colors">FAQ</a>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-[13px] text-ink hover:text-[color:var(--brand-primary)] transition-colors">
            Sign in
          </Link>
          <Link
            href="/register"
            className="px-4 py-2 rounded-[10px] text-white font-semibold text-[13px] transition-colors hover:opacity-90"
            style={{ background: 'var(--brand-primary)', boxShadow: 'var(--shadow-brand)' }}
          >
            Start free
          </Link>
        </div>
      </div>
    </nav>
  )
}

/* ------------------------------------------------------------------ */
/*  Hero                                                              */
/* ------------------------------------------------------------------ */
function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.55]"
        style={{
          background: `
            radial-gradient(ellipse at top left, rgba(255,149,0,0.16), transparent 55%),
            radial-gradient(ellipse at bottom right, rgba(255,149,0,0.08), transparent 55%),
            repeating-linear-gradient(135deg, rgba(26,24,21,0.03) 0 1px, transparent 1px 32px)`,
        }}
      />
      <div className="relative max-w-[1200px] mx-auto px-6 md:px-10 pt-20 pb-24">
        <div className="max-w-[900px]">
          <Eyebrow>HireFunnel · video-first hiring</Eyebrow>
          <h1
            className="text-[44px] md:text-[72px] font-semibold text-ink leading-[1.02] mb-7"
            style={{ letterSpacing: '-0.025em' }}
          >
            Hire people, not{' '}
            <em className="not-italic relative inline-block">
              <span style={{ color: 'var(--brand-primary)', fontStyle: 'italic' }}>résumés</span>
              <span
                className="absolute left-0 right-0 bottom-1 h-[8px] -z-10"
                style={{ background: 'rgba(255,149,0,0.22)', transform: 'skewX(-8deg)' }}
                aria-hidden
              />
            </em>
            .
          </h1>
          <p className="text-[18px] md:text-[20px] text-grey-35 leading-[1.55] mb-9 max-w-[640px]">
            Branching video interviews that surface real humans in minutes — not weeks of résumé triage.
            One shareable link, async review, zero scheduling thrash.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              href="/register"
              className="px-6 py-3.5 rounded-[10px] text-white font-semibold text-[14px] transition-colors hover:opacity-90"
              style={{ background: 'var(--brand-primary)', boxShadow: 'var(--shadow-brand)' }}
            >
              Start free — 14 days
            </Link>
            <a
              href="#how-it-works"
              className="px-6 py-3.5 rounded-[10px] text-ink font-medium text-[14px] border border-surface-border bg-white hover:bg-[#F7F3EB] transition-colors inline-flex items-center justify-center gap-2"
            >
              <Icon name="play" size={14} /> Watch a demo
            </a>
          </div>
          <div
            className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[10px] uppercase text-[#808080]"
            style={{ letterSpacing: '0.14em' }}
          >
            <span>No credit card</span>
            <span className="text-[#cbc6bb]">·</span>
            <span>50 candidates / mo free</span>
            <span className="text-[#cbc6bb]">·</span>
            <span>SOC 2 · GDPR</span>
          </div>
        </div>

        <div className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { top: 'Inbound', big: '1,247', sub: 'candidates this month' },
            { top: 'Completion', big: '94%', sub: 'finish the flow' },
            { top: 'Time-to-hire', big: '6 d', sub: 'down from 24' },
            { top: 'Interviews', big: '9', sub: 'booked this week' },
          ].map((c) => (
            <div key={c.top} className="bg-white rounded-[14px] border border-surface-border p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
              <div className="font-mono text-[10px] uppercase text-grey-35 mb-2" style={{ letterSpacing: '0.12em' }}>{c.top}</div>
              <div className="text-[28px] font-semibold text-ink leading-none" style={{ letterSpacing: '-0.02em' }}>{c.big}</div>
              <div className="text-[11px] text-grey-35 mt-1.5">{c.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Logo strip                                                        */
/* ------------------------------------------------------------------ */
function LogoStrip() {
  const logos = ['Northwind', 'Relay.co', 'Pilotworks', 'Moraine', 'Halogen', 'Evercrest']
  return (
    <section className="bg-[#F7F3EB] border-y border-surface-border">
      <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-[60px]">
        <div className="text-center font-mono text-[11px] uppercase text-grey-35 mb-7" style={{ letterSpacing: '0.16em' }}>
          Trusted by teams hiring at scale
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-5 opacity-55">
          {logos.map((l) => (
            <span key={l} className="text-[20px] font-semibold text-ink" style={{ fontFamily: 'var(--display-font)', letterSpacing: '-0.02em' }}>
              {l}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Pain points                                                       */
/* ------------------------------------------------------------------ */
function PainPoints() {
  const oldWay = [
    '400 résumés to screen for 5 real humans',
    'LinkedIn GPT slop blends every application together',
    'Candidates ghost because the process takes three weeks',
    'Bias creeps in through names, schools, and formatting',
  ]
  const newWay = [
    'Short video answers show personality and thought',
    'Branching skips questions that don\'t apply',
    'Same candidate experience — no scheduling thrash',
    'Review on your schedule — batch-watch at 1.5×',
  ]
  return (
    <section className="bg-[#FAF8F5]">
      <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-[80px] md:py-[120px]">
        <SectionHeading
          eyebrow="The problem"
          title={<>The résumé funnel wastes<br className="hidden md:block" /> everyone&apos;s time.</>}
          sub="Two paths diverge between you and your next hire. One of them still asks people to paste their job history into a PDF."
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-12">
          <div className="rounded-[14px] border border-surface-border p-7 md:p-8" style={{ background: '#F1EBE1' }}>
            <div className="font-mono text-[11px] uppercase text-grey-35 mb-4" style={{ letterSpacing: '0.16em' }}>The old way</div>
            <h3 className="text-[22px] font-semibold text-[#59595A] mb-5" style={{ letterSpacing: '-0.01em' }}>Paper-trail hiring</h3>
            <ul className="space-y-3.5">
              {oldWay.map((item) => (
                <li key={item} className="flex items-start gap-3 text-[14px] text-[#59595A] leading-[1.55]">
                  <span
                    className="inline-flex items-center justify-center flex-shrink-0 rounded-full mt-[3px]"
                    style={{ width: 16, height: 16, background: 'rgba(169,58,44,0.12)', color: '#A93A2C' }}
                  >
                    <Icon name="cross" size={10} />
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-[14px] border p-7 md:p-8 relative overflow-hidden" style={{ background: '#FFF3DF', borderColor: '#F0DCB4' }}>
            <div
              className="absolute -top-12 -right-12 w-48 h-48 rounded-full pointer-events-none"
              style={{ background: 'radial-gradient(circle, rgba(255,149,0,0.2), transparent 70%)' }}
              aria-hidden
            />
            <div className="font-mono text-[11px] uppercase mb-4 relative" style={{ letterSpacing: '0.16em', color: '#C2710A' }}>
              The HireFunnel way
            </div>
            <h3 className="text-[22px] font-semibold text-ink mb-5 relative" style={{ letterSpacing: '-0.01em' }}>Video-first screening</h3>
            <ul className="space-y-3.5 relative">
              {newWay.map((item) => (
                <li key={item} className="flex items-start gap-3 text-[14px] text-ink leading-[1.55]">
                  <OrangeCheck /> {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Feature triptych                                                  */
/* ------------------------------------------------------------------ */
function FeatureTriptych() {
  const features = [
    {
      icon: 'branch',
      title: 'Branching video flows',
      body: 'Ask different questions based on how candidates answer. Frontend vs backend, senior vs junior — one link handles all of it.',
    },
    {
      icon: 'shield',
      title: 'Anti-AI screening',
      body: 'Live video is harder to fake. We flag obvious AI submissions, detect copy-paste, and surface confident authentic answers.',
    },
    {
      icon: 'sparkle',
      title: 'Paid training funnels',
      body: 'Turn the top of your funnel into self-paced modules. Warm candidates who already understand your product before day one.',
    },
  ]
  return (
    <section id="features" className="bg-[#F7F3EB] border-y border-surface-border">
      <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-[80px] md:py-[120px]">
        <SectionHeading
          eyebrow="What you get"
          title="Everything the first mile of hiring needs."
          sub="Built for the messy part — screening, scoring, and deciding who's worth a real conversation."
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-14">
          {features.map((f) => (
            <div key={f.title} className="bg-white rounded-[14px] border border-surface-border p-7 flex flex-col" style={{ boxShadow: 'var(--shadow-card)' }}>
              <div className="w-11 h-11 rounded-[10px] flex items-center justify-center mb-5" style={{ background: '#FFF3DF', color: '#C2710A' }}>
                <Icon name={f.icon} size={20} />
              </div>
              <h3 className="text-[19px] font-semibold text-ink mb-2.5" style={{ letterSpacing: '-0.01em' }}>{f.title}</h3>
              <p className="text-[14px] text-grey-35 leading-[1.55] mb-6">{f.body}</p>
              <a
                href="#"
                className="mt-auto font-mono text-[11px] uppercase text-grey-35 hover:text-[color:var(--brand-primary)] transition-colors inline-flex items-center gap-1.5"
                style={{ letterSpacing: '0.14em' }}
              >
                Learn more <Icon name="arrow" size={12} />
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Feature rows                                                      */
/* ------------------------------------------------------------------ */
function FeatureRow({
  eyebrow,
  title,
  body,
  bullets,
  imageSide,
  glyph,
}: {
  eyebrow: string
  title: string
  body: string
  bullets: string[]
  imageSide: 'left' | 'right'
  glyph: 'builder' | 'analytics'
}) {
  const image = (
    <div
      className="aspect-[4/3] rounded-[16px] border border-surface-border relative overflow-hidden"
      style={{ background: 'linear-gradient(135deg, rgba(255,149,0,0.18), rgba(255,149,0,0.04))' }}
    >
      <div
        className="absolute inset-0 opacity-40"
        style={{ backgroundImage: 'radial-gradient(rgba(26,24,21,0.15) 1px, transparent 1px)', backgroundSize: '18px 18px' }}
        aria-hidden
      />
      {glyph === 'builder' ? (
        <div className="absolute inset-0 p-8 flex flex-col gap-3 justify-center">
          {['Tell us about yourself', 'Frontend or backend?', 'Record a 60s intro', 'Share a side project'].map((label, i) => (
            <div
              key={i}
              className="bg-white/95 border border-surface-border rounded-[10px] px-4 py-3 flex items-center gap-3 shadow-[0_2px_6px_rgba(26,24,21,0.04)]"
              style={{ marginLeft: `${i * 18}px`, maxWidth: 280 }}
            >
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-mono font-semibold" style={{ background: '#FFF3DF', color: '#C2710A' }}>
                {i + 1}
              </div>
              <span className="text-[12px] text-ink font-medium">{label}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="absolute inset-0 p-8 flex items-end">
          <svg viewBox="0 0 400 220" className="w-full h-[72%]" preserveAspectRatio="none">
            <defs>
              <linearGradient id="fillGrad" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#FF9500" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#FF9500" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d="M0,180 L40,160 L80,168 L120,130 L160,140 L200,100 L240,110 L280,70 L320,85 L360,50 L400,60 L400,220 L0,220 Z" fill="url(#fillGrad)" />
            <path d="M0,180 L40,160 L80,168 L120,130 L160,140 L200,100 L240,110 L280,70 L320,85 L360,50 L400,60" fill="none" stroke="#FF9500" strokeWidth="2.5" />
            {[40, 120, 200, 280, 360].map((x, i) => (
              <circle key={i} cx={x} cy={[160, 130, 100, 70, 50][i]} r="4" fill="#FF9500" />
            ))}
          </svg>
        </div>
      )}
    </div>
  )

  const text = (
    <div>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h3 className="text-[28px] md:text-[32px] font-semibold text-ink leading-[1.15] mb-4" style={{ letterSpacing: '-0.02em' }}>{title}</h3>
      <p className="text-[15px] text-grey-35 leading-[1.6] mb-6 max-w-[480px]">{body}</p>
      <ul className="space-y-2.5 mb-7">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-3 text-[14px] text-ink leading-[1.55]">
            <OrangeCheck /> {b}
          </li>
        ))}
      </ul>
      <a href="#" className="inline-flex items-center gap-2 text-[13px] font-medium text-ink border border-surface-border bg-white rounded-[10px] px-4 py-2.5 hover:bg-[#F7F3EB] transition-colors">
        See it live <Icon name="arrow" size={14} />
      </a>
    </div>
  )

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-14 items-center">
      {imageSide === 'left' ? (<>{image}{text}</>) : (<>{text}{image}</>)}
    </div>
  )
}

function FeatureRows() {
  return (
    <section className="bg-[#FAF8F5]">
      <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-[80px] md:py-[120px] space-y-[80px] md:space-y-[120px]">
        <FeatureRow
          imageSide="left"
          glyph="builder"
          eyebrow="Flow builder"
          title="Design branching interviews without writing code."
          body="Drag, drop, and test from a shareable link. Reorder questions, split paths by role or seniority, preview as a candidate in one click."
          bullets={[
            'Conditional logic on any multiple-choice answer',
            'Inline preview — no deploy, no refresh',
            'Duplicate, archive, or A/B test any flow',
          ]}
        />
        <FeatureRow
          imageSide="right"
          glyph="analytics"
          eyebrow="Analytics"
          title="Analytics that actually move hiring."
          body="Watch where candidates drop off. Compare flows. Export clean data to your ATS — or just stare at the numbers and know what's working."
          bullets={[
            'Funnel view per question, per role, per source',
            'Time-to-complete and drop-off heat-maps',
            'CSV + Greenhouse / Ashby export',
          ]}
        />
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  How it works                                                      */
/* ------------------------------------------------------------------ */
function HowItWorks() {
  const steps = [
    { n: '01', t: 'Build your flow', d: 'Pick questions, set branches, upload your welcome video.' },
    { n: '02', t: 'Share one link', d: 'Send it to candidates, paste it on your careers page, or embed it.' },
    { n: '03', t: 'Review submissions', d: 'Watch on your schedule. Score, comment, hand off.' },
    { n: '04', t: 'Schedule real interviews', d: 'Only candidates worth your time reach your calendar.' },
  ]
  return (
    <section id="how-it-works" className="bg-[#F7F3EB] border-y border-surface-border">
      <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-[80px] md:py-[120px]">
        <SectionHeading eyebrow="How it works" title="Four steps to your first hire." />
        <div className="mt-14 grid grid-cols-1 md:grid-cols-4 gap-8 md:gap-4 relative">
          <div
            className="hidden md:block absolute left-0 right-0 top-[26px] h-px pointer-events-none"
            style={{
              background: 'repeating-linear-gradient(to right, rgba(255,149,0,0.4) 0 6px, transparent 6px 14px)',
              marginLeft: 80,
              marginRight: 80,
            }}
            aria-hidden
          />
          {steps.map((s) => (
            <div key={s.n} className="relative bg-[#F7F3EB] pr-2">
              <div
                className="font-mono text-[30px] font-semibold leading-none mb-4 inline-block pr-4 bg-[#F7F3EB]"
                style={{ color: 'var(--brand-primary)', letterSpacing: '-0.02em' }}
              >
                {s.n}
              </div>
              <h3 className="text-[17px] font-semibold text-ink mb-2" style={{ letterSpacing: '-0.01em' }}>{s.t}</h3>
              <p className="text-[13px] text-grey-35 leading-[1.55]">{s.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Social proof                                                      */
/* ------------------------------------------------------------------ */
function SocialProof() {
  const metrics = [
    { eyebrow: 'Time-to-hire', big: '−42%', sub: 'Median across 120 teams' },
    { eyebrow: 'Qualified pipeline', big: '3.1×', sub: 'More candidates worth interviewing' },
    { eyebrow: 'Completion', big: '94%', sub: 'Candidates finish the flow' },
  ]
  return (
    <section className="bg-[#FAF8F5]">
      <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-[80px] md:py-[120px]">
        <SectionHeading
          eyebrow="Why teams switch"
          title="Faster pipelines. Better candidates."
          sub="The numbers we hear most from teams in their first 90 days."
        />
        <div className="grid grid-cols-1 md:grid-cols-5 gap-5 mt-12">
          <div className="md:col-span-3 rounded-[16px] p-8 md:p-10 relative overflow-hidden" style={{ background: '#1a2d26', color: '#F5F2EC' }}>
            <div
              className="absolute top-5 left-6 text-[140px] leading-none pointer-events-none"
              style={{ color: 'rgba(255,149,0,0.45)', fontFamily: 'Georgia, "Times New Roman", serif' }}
              aria-hidden
            >
              &ldquo;
            </div>
            <div className="relative pt-14 max-w-[480px]">
              <p className="text-[22px] font-medium leading-[1.3] mb-7" style={{ letterSpacing: '-0.01em' }}>
                We cut our hiring loop from three weeks to four days. Half the candidates we&apos;d have rejected on paper ended up being the strongest in person.
              </p>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full flex items-center justify-center font-semibold text-[13px]" style={{ background: 'rgba(255,149,0,0.2)', color: '#FFD89F' }}>
                  MB
                </div>
                <div>
                  <div className="text-[14px] font-semibold">Maya Bernstein</div>
                  <div className="text-[13px] opacity-70">Head of Talent · Relay.co</div>
                </div>
              </div>
            </div>
          </div>
          <div className="md:col-span-2 grid grid-cols-1 gap-4">
            {metrics.map((m) => (
              <div key={m.eyebrow} className="bg-white border border-surface-border rounded-[14px] p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
                <div className="font-mono text-[10px] uppercase text-grey-35 mb-2" style={{ letterSpacing: '0.14em' }}>{m.eyebrow}</div>
                <div className="text-[34px] font-semibold text-ink leading-none mb-1.5" style={{ letterSpacing: '-0.02em' }}>{m.big}</div>
                <div className="text-[13px] text-grey-35">{m.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Pricing                                                           */
/* ------------------------------------------------------------------ */
function Pricing() {
  const tiers = [
    {
      name: 'Starter',
      price: '$0',
      suffix: '/ forever',
      tagline: 'For teams trying it out.',
      bullets: ['1 active flow', '50 submissions / month', 'Email support', 'Basic analytics'],
      cta: 'Start free',
      highlight: false,
    },
    {
      name: 'Growth',
      price: '$149',
      suffix: '/ month',
      tagline: 'For teams hiring every week.',
      bullets: [
        'Unlimited submissions',
        '3 active flows + branching',
        'Slack-channel support',
        'Branching analytics & funnels',
        'Custom branding',
      ],
      cta: 'Start free',
      highlight: true,
    },
    {
      name: 'Scale',
      price: 'Custom',
      suffix: '',
      tagline: 'For hiring teams with structure.',
      bullets: ['SSO + SAML', 'SOC 2 documentation', 'API access', 'Training modules', 'Dedicated onboarding'],
      cta: 'Talk to sales',
      highlight: false,
    },
  ]
  return (
    <section id="pricing" className="bg-[#F7F3EB] border-y border-surface-border">
      <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-[80px] md:py-[120px]">
        <SectionHeading
          eyebrow="Pricing"
          title="Priced per seat. No per-candidate fees."
          sub="Unlimited submissions on Growth and above. You're never punished for a good ad."
          align="center"
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-14 items-stretch">
          {tiers.map((t) => (
            <div
              key={t.name}
              className={`relative rounded-[14px] p-8 flex flex-col bg-white border ${t.highlight ? 'border-[2px]' : 'border-surface-border'}`}
              style={{
                borderColor: t.highlight ? 'var(--brand-primary)' : undefined,
                boxShadow: t.highlight ? '0 14px 40px -16px rgba(255,149,0,0.35)' : 'var(--shadow-card)',
              }}
            >
              {t.highlight ? (
                <div
                  className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full font-mono text-[10px] uppercase font-semibold"
                  style={{ background: 'var(--brand-primary)', color: 'white', letterSpacing: '0.14em' }}
                >
                  Most popular
                </div>
              ) : null}
              <div className="mb-5">
                <div className="font-mono text-[11px] uppercase text-grey-35 mb-3" style={{ letterSpacing: '0.14em' }}>{t.name}</div>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-[38px] font-semibold text-ink leading-none" style={{ letterSpacing: '-0.03em' }}>{t.price}</span>
                  {t.suffix ? <span className="text-[14px] text-grey-35">{t.suffix}</span> : null}
                </div>
                <p className="text-[14px] text-grey-35 mt-2">{t.tagline}</p>
              </div>
              <ul className="space-y-3 mb-8 flex-1">
                {t.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-3 text-[14px] text-ink leading-[1.55]">
                    <OrangeCheck /> {b}
                  </li>
                ))}
              </ul>
              <Link
                href={t.cta === 'Talk to sales' ? '/contact' : '/register'}
                className={`block w-full text-center py-3 rounded-[10px] font-semibold text-[14px] transition-colors ${
                  t.highlight ? 'text-white hover:opacity-90' : 'text-ink border border-surface-border bg-white hover:bg-[#F7F3EB]'
                }`}
                style={t.highlight ? { background: 'var(--brand-primary)', boxShadow: 'var(--shadow-brand)' } : undefined}
              >
                {t.cta}
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  FAQ                                                               */
/* ------------------------------------------------------------------ */
function FAQ() {
  const items = [
    {
      q: 'Can candidates record from their phone?',
      a: 'Yes. The recorder works on any modern mobile browser — no app install, no signup. Candidates just open the link and hit record.',
    },
    {
      q: 'How do you prevent AI-generated video submissions?',
      a: 'We record the candidate live, flag copy-paste behaviour on text fields, and surface heuristics (unnatural pauses, lip-sync drift) for your review. You always make the final call.',
    },
    {
      q: 'Does this integrate with our ATS?',
      a: 'Native integrations with Greenhouse, Ashby, and Lever. CSV export and a REST API are available on Growth and Scale plans.',
    },
    {
      q: 'How long are videos stored?',
      a: 'Submissions are retained for 180 days by default, configurable up to 2 years on Scale. You can also delete any submission on demand.',
    },
    {
      q: 'Is it GDPR compliant? SOC 2?',
      a: 'GDPR compliant out of the box with EU data residency. SOC 2 Type II documentation is available on Scale.',
    },
    {
      q: 'Can we white-label?',
      a: 'Growth and Scale plans support custom branding — your logo, your colors, your subdomain. Candidates see your brand, not ours.',
    },
    {
      q: 'What happens at the end of the 14-day trial?',
      a: 'You drop to the free Starter plan. Your flows stay live, your data stays intact, and you can upgrade any time.',
    },
  ]
  const [open, setOpen] = useState<number | null>(0)
  return (
    <section id="faq" className="bg-[#FAF8F5]">
      <div className="max-w-[720px] mx-auto px-6 md:px-10 py-[80px] md:py-[120px]">
        <SectionHeading eyebrow="FAQ" title="Questions before you try." align="center" />
        <div className="mt-12">
          {items.map((item, i) => {
            const isOpen = open === i
            return (
              <div key={i} className="border-b border-surface-border">
                <button
                  type="button"
                  className="w-full flex items-center justify-between gap-6 py-5 text-left group"
                  onClick={() => setOpen(isOpen ? null : i)}
                  aria-expanded={isOpen}
                >
                  <span className="text-[16px] font-medium text-ink" style={{ letterSpacing: '-0.005em' }}>{item.q}</span>
                  <span
                    className="flex-shrink-0 text-grey-35 transition-transform duration-200"
                    style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                  >
                    <Icon name="chevron" size={18} />
                  </span>
                </button>
                <div className="grid transition-all duration-200 ease-out" style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}>
                  <div className="overflow-hidden">
                    <p className="text-[14px] text-grey-35 leading-[1.6] pb-5 pr-6">{item.a}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  CTA band                                                          */
/* ------------------------------------------------------------------ */
function CTABand() {
  return (
    <section className="relative" style={{ background: 'linear-gradient(135deg, #2d4a3e, #1a2d26)' }}>
      <div
        className="absolute inset-0 pointer-events-none opacity-40"
        style={{ background: 'radial-gradient(ellipse at top right, rgba(255,149,0,0.18), transparent 55%)' }}
        aria-hidden
      />
      <div className="relative max-w-[900px] mx-auto px-6 md:px-10 py-[80px] md:py-[100px] text-center">
        <h2 className="text-[40px] md:text-[52px] font-semibold text-white leading-[1.05] mb-5" style={{ letterSpacing: '-0.02em' }}>
          Stop screening résumés.
          <br /> Start meeting people.
        </h2>
        <p className="text-[17px] leading-[1.55] max-w-[520px] mx-auto mb-9" style={{ color: 'rgba(255,255,255,0.78)' }}>
          Fourteen days free, unlimited submissions, no credit card. Your first flow takes seven minutes.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/register"
            className="px-6 py-3.5 rounded-[10px] text-white font-semibold text-[14px] transition-colors hover:opacity-90"
            style={{ background: 'var(--brand-primary)', boxShadow: 'var(--shadow-brand)' }}
          >
            Start free — 14 days
          </Link>
          <Link
            href="/contact"
            className="px-6 py-3.5 rounded-[10px] font-medium text-[14px] border transition-colors"
            style={{ borderColor: 'rgba(255,255,255,0.3)', color: '#fff', background: 'transparent' }}
          >
            Book a demo
          </Link>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Footer                                                            */
/* ------------------------------------------------------------------ */
function Footer() {
  const cols: { title: string; links: { label: string; href: string }[] }[] = [
    {
      title: 'Product',
      links: [
        { label: 'Features', href: '#features' },
        { label: 'Pricing', href: '#pricing' },
        { label: 'Integrations', href: '#' },
        { label: 'Changelog', href: '#' },
        { label: 'Roadmap', href: '#' },
      ],
    },
    {
      title: 'Company',
      links: [
        { label: 'About', href: '#' },
        { label: 'Customers', href: '#' },
        { label: 'Careers', href: '#' },
        { label: 'Contact', href: 'mailto:hello@hirefunnel.app' },
      ],
    },
    {
      title: 'Resources',
      links: [
        { label: 'Documentation', href: '#' },
        { label: 'Templates', href: '#' },
        { label: 'Hiring guides', href: '#' },
        { label: 'Blog', href: '#' },
      ],
    },
    {
      title: 'Legal',
      links: [
        { label: 'Privacy', href: '/privacy' },
        { label: 'Terms', href: '/terms' },
        { label: 'Security', href: 'mailto:security@hirefunnel.app' },
        { label: 'DPA', href: 'mailto:privacy@hirefunnel.app?subject=DPA%20request' },
      ],
    },
  ]
  return (
    <footer style={{ background: '#1a1815', color: 'rgba(255,255,255,0.75)' }}>
      <div className="max-w-[1200px] mx-auto px-6 md:px-10 py-[60px]">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-10 mb-12">
          <div className="col-span-2">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white font-bold text-[17px]" style={{ background: 'var(--brand-primary)' }}>
                h
              </div>
              <span className="text-[16px] font-semibold text-white" style={{ letterSpacing: '-0.01em' }}>HireFunnel</span>
            </div>
            <p className="text-[13px] leading-[1.6] max-w-[260px]">
              Video-first hiring for teams who&apos;d rather meet people than read résumés.
            </p>
          </div>
          {cols.map((col) => (
            <div key={col.title}>
              <div className="font-mono text-[10px] uppercase text-white/50 mb-4" style={{ letterSpacing: '0.14em' }}>{col.title}</div>
              <ul className="space-y-2.5">
                {col.links.map((l) => {
                  const isInternal = l.href.startsWith('/')
                  return (
                    <li key={l.label}>
                      {isInternal ? (
                        <Link href={l.href} className="text-[13px] font-medium hover:text-white transition-colors duration-100">
                          {l.label}
                        </Link>
                      ) : (
                        <a href={l.href} className="text-[13px] font-medium hover:text-white transition-colors duration-100">
                          {l.label}
                        </a>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="pt-6 border-t border-white/10 flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="text-[12px] text-white/50">© {new Date().getFullYear()} HireFunnel. All rights reserved.</div>
          <div className="flex items-center gap-4 text-white/60">
            <a href="#" className="hover:text-white transition-colors" aria-label="Twitter"><Icon name="twitter" size={16} /></a>
            <a href="#" className="hover:text-white transition-colors" aria-label="LinkedIn"><Icon name="linkedin" size={16} /></a>
          </div>
        </div>
      </div>
    </footer>
  )
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */
export default function LandingPage() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', fontFamily: 'var(--body-font)' }}>
      <Navbar />
      <Hero />
      <LogoStrip />
      <PainPoints />
      <FeatureTriptych />
      <FeatureRows />
      <HowItWorks />
      <SocialProof />
      <Pricing />
      <FAQ />
      <CTABand />
      <Footer />
    </div>
  )
}
