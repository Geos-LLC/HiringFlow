/**
 * MobileNav — hamburger + right-side drawer for the dashboard below the `md`
 * breakpoint (< 768px). Consumes the same TopNavItem[] as the desktop TopNav
 * so config stays single-source in dashboard/layout.tsx.
 *
 * Accessibility: role="dialog" + aria-modal, Esc/scrim/close-button all
 * dismiss, focus moves to the active link on open and back to the trigger
 * on close, body scroll locked while open.
 *
 * Port of Design/reference/mobile/MobileNav.tsx with two token fixes:
 *   - `var(--brand-ink)` → `var(--ink)`           (brand-ink isn't defined)
 *   - `text-grey-25` → `text-grey-35`             (25 isn't in the scale)
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { TopNavItem } from './TopNav'

export interface MobileNavProps {
  items: TopNavItem[]
  workspaceName?: string
  user?: { name?: string; email?: string; avatarUrl?: string | null }
  /** Usually a "Sign out" button + version stamp. */
  footer?: React.ReactNode
}

function isActivePath(pathname: string, it: TopNavItem) {
  const prefixes = [it.href, ...(it.matches || [])]
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

function initialsFromName(name?: string): string {
  if (!name) return ''
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function HamburgerGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  )
}
function CloseGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M6 6l12 12M6 18 18 6" />
    </svg>
  )
}

export function MobileNav({ items, workspaceName, user, footer }: MobileNavProps) {
  const [open, setOpen] = React.useState(false)
  const pathname = usePathname() || ''
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)

  // Lock body scroll while open — otherwise iOS lets the page scroll behind
  // the scrim, which reads as "the drawer is broken".
  React.useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>('[data-active="true"]')
      ?? panel?.querySelector<HTMLElement>('a, button')
    first?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  React.useEffect(() => {
    setOpen(false)
  }, [pathname])

  const userName = user?.name
  const initials = initialsFromName(userName)

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="hirefunnel-mobile-drawer"
        className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-[10px] text-ink hover:bg-surface-light transition-colors"
      >
        <HamburgerGlyph />
      </button>

      {/* Scrim */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        className={`md:hidden fixed inset-0 z-[60] transition-opacity duration-200 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        style={{ background: 'rgba(23,23,26,0.35)', backdropFilter: 'blur(2px)' }}
      />

      {/* Panel */}
      <aside
        id="hirefunnel-mobile-drawer"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Main menu"
        className={`md:hidden fixed top-0 right-0 bottom-0 z-[61] w-[82%] max-w-[360px] flex flex-col bg-white transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ boxShadow: '-20px 0 40px -20px rgba(0,0,0,0.2)' }}
      >
        {/* Header — user card */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-surface-border">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-[12px] overflow-hidden shrink-0"
              style={{ background: 'var(--ink)' }}
            >
              {user?.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatarUrl} alt={userName || ''} className="w-full h-full object-cover" />
              ) : initials}
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ink truncate">{userName || 'Signed in'}</div>
              <div className="text-[11px] text-grey-50 truncate">
                {user?.email || workspaceName || ''}
              </div>
            </div>
          </div>
          <button
            onClick={() => { setOpen(false); triggerRef.current?.focus() }}
            aria-label="Close menu"
            className="w-10 h-10 rounded-[10px] inline-flex items-center justify-center text-ink hover:bg-surface-light transition-colors"
          >
            <CloseGlyph />
          </button>
        </div>

        {/* Link list. Groups (items with `children`) render as a section
            header + a card containing the children. Flat items render as a
            single row. The visual style follows the design screenshot:
            uppercase group label, items in a soft-grey container.  */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-4">
          {items.map((it) => {
            if (it.children && it.children.length > 0) {
              return (
                <section key={it.href}>
                  <h3 className="font-semibold text-[15px] text-ink mb-2 px-1">{it.label}</h3>
                  <div
                    className="rounded-[12px] p-1.5"
                    style={{ background: 'var(--surface-light, #FCFAF6)' }}
                  >
                    {it.children.map((child) => {
                      const active = isActivePath(pathname, child)
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          data-active={active || undefined}
                          onClick={() => setOpen(false)}
                          className={`flex items-center justify-between px-3 py-2 rounded-[10px] font-mono text-[13px] transition-colors ${
                            active ? 'text-ink' : 'text-grey-35 hover:bg-white hover:text-ink'
                          }`}
                          style={active ? { background: 'var(--brand-dim)' } : undefined}
                        >
                          <span>{child.label}</span>
                          <span
                            className="w-1.5 h-1.5 rounded-full transition-opacity"
                            style={{
                              background: 'var(--brand-primary)',
                              opacity: active ? 1 : 0,
                            }}
                          />
                        </Link>
                      )
                    })}
                  </div>
                </section>
              )
            }
            // Flat item — back-compat for callers that don't use groups.
            const active = isActivePath(pathname, it)
            return (
              <Link
                key={it.href}
                href={it.href}
                data-active={active || undefined}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-2.5 px-3 py-3 rounded-[10px] text-[14px] font-medium transition-colors ${
                  active ? 'text-ink' : 'text-grey-35 hover:bg-surface-light hover:text-ink'
                }`}
                style={active ? { background: 'var(--brand-dim)' } : undefined}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full transition-opacity"
                  style={{
                    background: 'var(--brand-primary)',
                    opacity: active ? 1 : 0,
                  }}
                />
                {it.label}
              </Link>
            )
          })}
        </nav>

        {footer && (
          <div className="px-4 py-3 border-t border-surface-border text-[12px] text-grey-35 flex items-center justify-between">
            {footer}
          </div>
        )}
      </aside>
    </>
  )
}
