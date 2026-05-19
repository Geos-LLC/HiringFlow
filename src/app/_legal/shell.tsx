/**
 * Shared chrome for public legal pages (Privacy, Terms).
 * Mirrors the landing-page navbar + footer so users feel they're in the
 * same site without us hauling all the marketing sections along.
 */

'use client'

import Link from 'next/link'
import { ReactNode } from 'react'

type TocItem = { id: string; label: string }

export function LegalShell({
  eyebrow,
  title,
  lastUpdated,
  effectiveDate,
  tableOfContents,
  children,
}: {
  eyebrow: string
  title: string
  lastUpdated: string
  effectiveDate?: string
  tableOfContents?: TocItem[]
  children: ReactNode
}) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', fontFamily: 'var(--body-font)' }}>
      <LegalNav />
      <main className="max-w-[1100px] mx-auto px-6 md:px-10 pt-16 pb-24">
        <header className="mb-12 max-w-[760px]">
          <div
            className="font-mono text-[11px] uppercase text-grey-35 mb-5"
            style={{ letterSpacing: '0.16em' }}
          >
            {eyebrow}
          </div>
          <h1
            className="text-[44px] md:text-[56px] font-semibold text-ink leading-[1.05] mb-5"
            style={{ letterSpacing: '-0.025em' }}
          >
            {title}
          </h1>
          <div
            className="font-mono text-[11px] uppercase text-grey-35 flex flex-wrap gap-x-5 gap-y-1"
            style={{ letterSpacing: '0.14em' }}
          >
            <span>Last updated · {lastUpdated}</span>
            {effectiveDate ? <span>Effective · {effectiveDate}</span> : null}
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)] gap-10 lg:gap-14">
          {tableOfContents && tableOfContents.length > 0 ? (
            <aside className="lg:sticky lg:top-[88px] self-start">
              <div
                className="font-mono text-[10px] uppercase text-grey-35 mb-3"
                style={{ letterSpacing: '0.16em' }}
              >
                On this page
              </div>
              <nav>
                <ul className="space-y-2">
                  {tableOfContents.map((t) => (
                    <li key={t.id}>
                      <a
                        href={`#${t.id}`}
                        className="text-[13px] text-grey-35 hover:text-ink transition-colors block"
                      >
                        {t.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </aside>
          ) : null}

          <article className="legal-prose max-w-[720px]">{children}</article>
        </div>
      </main>
      <LegalFooter />

      <style jsx global>{`
        .legal-prose {
          color: var(--ink, #1a1815);
          font-size: 15px;
          line-height: 1.7;
        }
        .legal-prose section {
          margin-bottom: 40px;
          scroll-margin-top: 96px;
        }
        .legal-prose h2 {
          font-size: 24px;
          font-weight: 600;
          letter-spacing: -0.015em;
          margin: 8px 0 14px;
          color: var(--ink, #1a1815);
        }
        .legal-prose h3 {
          font-size: 17px;
          font-weight: 600;
          letter-spacing: -0.005em;
          margin: 24px 0 10px;
          color: var(--ink, #1a1815);
        }
        .legal-prose p {
          margin: 0 0 14px;
          color: #444140;
        }
        .legal-prose ul,
        .legal-prose ol {
          margin: 0 0 16px;
          padding-left: 22px;
        }
        .legal-prose li {
          margin-bottom: 8px;
          color: #444140;
        }
        .legal-prose li::marker {
          color: rgba(255, 149, 0, 0.65);
        }
        .legal-prose a {
          color: #c2710a;
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .legal-prose a:hover {
          color: #a35d05;
        }
        .legal-prose strong {
          color: var(--ink, #1a1815);
          font-weight: 600;
        }
        .legal-prose code {
          background: #f1ebe1;
          padding: 1px 6px;
          border-radius: 4px;
          font-size: 13px;
        }
        .legal-prose table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          margin: 0 0 18px;
          border: 1px solid #e8e1d3;
          border-radius: 10px;
          overflow: hidden;
        }
        .legal-prose thead {
          background: #f7f3eb;
        }
        .legal-prose th,
        .legal-prose td {
          text-align: left;
          padding: 10px 14px;
          border-bottom: 1px solid #efe8d8;
          vertical-align: top;
        }
        .legal-prose tr:last-child td {
          border-bottom: none;
        }
        .legal-prose th {
          font-weight: 600;
          color: var(--ink, #1a1815);
        }
        .legal-prose hr {
          border: none;
          border-top: 1px solid #e8e1d3;
          margin: 36px 0;
        }
      `}</style>
    </div>
  )
}

function LegalNav() {
  return (
    <nav className="border-b border-surface-border sticky top-0 bg-[#FAF8F5]/85 backdrop-blur-sm z-50">
      <div className="max-w-[1200px] mx-auto px-6 md:px-10 flex items-center justify-between h-[64px]">
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
        <div className="flex items-center gap-5">
          <Link href="/privacy" className="text-[13px] text-grey-35 hover:text-ink transition-colors">
            Privacy
          </Link>
          <Link href="/terms" className="text-[13px] text-grey-35 hover:text-ink transition-colors">
            Terms
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

function LegalFooter() {
  return (
    <footer style={{ background: '#1a1815', color: 'rgba(255,255,255,0.75)' }}>
      <div className="max-w-[1200px] mx-auto px-6 md:px-10 py-10 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white font-bold text-[17px]"
            style={{ background: 'var(--brand-primary)' }}
          >
            h
          </div>
          <span className="text-[15px] font-semibold text-white" style={{ letterSpacing: '-0.01em' }}>
            HireFunnel
          </span>
        </div>
        <div className="flex items-center gap-6 text-[13px]">
          <Link href="/" className="hover:text-white transition-colors">
            Home
          </Link>
          <Link href="/privacy" className="hover:text-white transition-colors">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-white transition-colors">
            Terms
          </Link>
          <a href="mailto:hello@hirefunnel.app" className="hover:text-white transition-colors">
            Contact
          </a>
        </div>
        <div className="text-[12px] text-white/50">© {new Date().getFullYear()} HireFunnel</div>
      </div>
    </footer>
  )
}
