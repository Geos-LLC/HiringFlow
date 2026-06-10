/**
 * TopNav (responsive) — brand + grouped tabs + search + CTA + avatar.
 *
 * Two-tier nav structure:
 *
 *   Row 1 (groups):  Recruiting | Process | Content | Insights | Admin
 *   Row 2 (sub-tabs): children of the active group
 *
 * A group tab is "active" when the current path matches any of its children
 * (or the group's own href as a fallback). Clicking a group label routes to
 * the group's href — usually the first child — so the user lands on a real
 * page instead of staring at an empty content area. Items without children
 * still render as flat tabs (back-compat with old callers).
 *
 * Breakpoints:
 *
 *   < md (768px)     — Mobile. Tabs hide; MobileNav drawer renders groups
 *                      as section headers (matches design screenshot).
 *   md+              — Two visible rows: group row (60px) + sub-tab strip
 *                      (40px). Sub-tab strip only renders when the active
 *                      group has children.
 *
 * Wordmark kept as "HireFunnel" (capital F) per product decision.
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Button } from './Button'
import { MobileNav } from './MobileNav'

export interface TopNavItem {
  label: string
  href: string
  matches?: string[]        // additional path prefixes that count as active
  // Group support. When children is present, the item renders as a primary
  // group tab on row 1 with its children appearing on row 2 when active.
  // The group's `href` is the landing route when the group label is clicked
  // (set to the first child's href in most cases).
  children?: TopNavItem[]
}

export interface TopNavProps {
  items: TopNavItem[]
  workspaceName?: string
  user?: { name?: string; email?: string; initials?: string; avatarUrl?: string | null }
  current?: string
  cta?: React.ReactNode
  onSearch?: () => void
  className?: string
  /** Footer slot passed through to MobileNav (usually "Sign out"). */
  mobileFooter?: React.ReactNode
}

function initialsFromName(name?: string): string {
  if (!name) return ''
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// A path matches an item iff it equals the item's href, starts with
// `href + '/'` (subroute), or matches one of the `matches` prefixes the
// same way. We deliberately do NOT use `startsWith(p)` without the slash —
// that produced false positives like `/dashboard/processes` activating
// `/dashboard/process`-prefixed routes.
function pathMatchesItem(pathname: string, it: TopNavItem): boolean {
  const prefixes = [it.href, ...(it.matches || [])]
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

export function TopNav({
  items,
  workspaceName,
  user,
  current,
  cta,
  onSearch,
  className = '',
  mobileFooter,
}: TopNavProps) {
  const pathname = usePathname() || ''

  // Active-group resolution. A group is active when the current path matches
  // it or any of its children. Used both for the group-tab highlight on row 1
  // and to pick which children render on row 2.
  const isGroupActive = (it: TopNavItem): boolean => {
    if (current) return current === it.label
    if (pathMatchesItem(pathname, it)) return true
    return (it.children || []).some((c) => pathMatchesItem(pathname, c))
  }
  const isSubActive = (it: TopNavItem): boolean => {
    if (current) return current === it.label
    return pathMatchesItem(pathname, it)
  }

  // hoveredLabel drives the popover anchored directly under each group
  // label. Reset is handled by a container-level onMouseLeave on the whole
  // header so moving the cursor from the group label down into the popover
  // doesn't close it (they're vertically adjacent).
  const [hoveredLabel, setHoveredLabel] = React.useState<string | null>(null)

  // Persistent sub-tab strip for the active group — gives users on a
  // sub-page (e.g. /dashboard/automations) a constant view of siblings to
  // jump to, independent of the hover popover above.
  const activeGroup = items.find(isGroupActive) || null
  const activeSubTabs = activeGroup?.children || []

  const initials = user?.initials || initialsFromName(user?.name)

  // Group tabs (primary). Reused inline (xl+) and on the dedicated strip
  // (md→xl). Each item is wrapped in a relative container so its children
  // popover can absolutely position itself directly below the label.
  const groupRow = (
    <nav className="flex gap-0.5 items-center">
      {items.map((it) => {
        const active = isGroupActive(it)
        const hovered = hoveredLabel === it.label
        const children = it.children || []
        return (
          <div
            key={it.href}
            className="relative"
            onMouseEnter={() => setHoveredLabel(it.label)}
            onFocus={() => setHoveredLabel(it.label)}
          >
            <Link
              href={it.href}
              className={`block px-3 py-2 text-[14px] font-medium rounded-[8px] whitespace-nowrap transition-colors ${
                active ? 'text-ink' : 'text-grey-35 hover:text-ink hover:bg-surface-light'
              }`}
              style={active ? { background: 'var(--brand-dim)' } : undefined}
            >
              {it.label}
            </Link>
            {hovered && children.length > 0 && (
              <div className="absolute left-0 top-full z-50 mt-1 min-w-[180px] rounded-[10px] border border-surface-border bg-white py-1 shadow-lg">
                {children.map((sub) => {
                  const subActive = isSubActive(sub)
                  return (
                    <Link
                      key={sub.href}
                      href={sub.href}
                      className={`block px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors ${
                        subActive ? 'text-ink bg-surface-light' : 'text-grey-35 hover:text-ink hover:bg-surface-light'
                      }`}
                    >
                      {sub.label}
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )

  return (
    <header
      className={`bg-white border-b border-surface-border shrink-0 ${className}`.trim()}
      onMouseLeave={() => setHoveredLabel(null)}
    >
      {/* Row 1: brand (+ inline group tabs on xl+) + right cluster */}
      <div className="h-[60px] flex items-center gap-3 xl:gap-7 px-4 md:px-6">
        {/* Brand */}
        <div className="flex items-center gap-2.5 shrink-0">
          <Link href={items[0]?.href || '/dashboard'} className="flex items-center gap-2.5">
            <div
              className="w-7 h-7 rounded-[8px] flex items-center justify-center text-white font-bold text-[15px]"
              style={{ background: 'var(--brand-primary)', boxShadow: 'var(--shadow-brand)' }}
            >
              h
            </div>
            <span className="font-semibold text-[15px] text-ink tracking-[-0.01em]">HireFunnel</span>
          </Link>
          {workspaceName && (
            <span
              className="hidden sm:inline-block ml-1.5 font-mono text-[10px] uppercase text-grey-35 px-2 py-0.5 rounded-full border border-surface-border"
              style={{ letterSpacing: '0.08em' }}
              title={workspaceName}
            >
              {workspaceName.length > 14 ? workspaceName.slice(0, 14) + '…' : workspaceName}
            </span>
          )}
        </div>

        {/* Inline group tabs — xl+ only. Below xl, groups live on row 2.
            overflow is left visible so the group popover can extend below
            the header instead of being clipped. */}
        <div className="hidden xl:flex flex-1 items-center">
          {groupRow}
        </div>

        {/* Spacer when group tabs are NOT inline (mobile and md→xl). */}
        <div className="flex-1 xl:hidden" />

        {/* Right cluster */}
        <div className="flex items-center gap-2 md:gap-2.5 shrink-0">
          {onSearch && (
            <>
              <Button variant="secondary" size="sm" onClick={onSearch} className="hidden md:inline-flex">
                <span className="font-mono text-[10px] opacity-70">⌘K</span>
                <span>Search</span>
              </Button>
              <button
                onClick={onSearch}
                aria-label="Search"
                className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-[10px] text-ink hover:bg-surface-light transition-colors"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
              </button>
            </>
          )}
          {/* CTA block — desktop only (mobile gets it via MobileNav footer if needed) */}
          <div className="hidden md:inline-flex">{cta}</div>
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white font-semibold text-[12px] overflow-hidden"
            style={{ background: 'var(--ink)' }}
            title={user?.name}
          >
            {user?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatarUrl} alt={user.name || ''} className="w-full h-full object-cover" />
            ) : (
              initials
            )}
          </div>
          <MobileNav
            items={items}
            workspaceName={workspaceName}
            user={user ? { name: user.name, email: user.email, avatarUrl: user.avatarUrl } : undefined}
            footer={mobileFooter}
          />
        </div>
      </div>

      {/* Row 2 — group strip on md→xl (where row 1 doesn't have inline groups).
          overflow is left visible so the per-group popover below each
          label can extend out of this strip. */}
      <div
        className="hidden md:block xl:hidden border-t border-surface-border"
        style={{ background: 'var(--surface-light, #FCFAF6)' }}
      >
        <div className="h-12 px-4 md:px-6 flex items-center">
          {groupRow}
        </div>
      </div>

      {/* Persistent sub-tab strip — children of the active group. Renders
          regardless of hover so users on a sub-page always see siblings to
          jump to. The hover popover above is the discovery affordance;
          this strip is the wayfinding affordance. Mobile (< md) uses the
          drawer instead, where groups + children are always co-visible. */}
      {activeSubTabs.length > 0 && (
        <div
          className="hidden md:block border-t border-surface-border"
          style={{ background: 'var(--surface-light, #FCFAF6)' }}
        >
          <div className="h-10 px-4 md:px-6 flex items-center gap-0.5 overflow-x-auto">
            {activeSubTabs.map((sub) => {
              const active = isSubActive(sub)
              return (
                <Link
                  key={sub.href}
                  href={sub.href}
                  className={`px-3 py-1.5 text-[13px] font-medium rounded-[8px] whitespace-nowrap transition-colors ${
                    active ? 'text-ink bg-white border border-surface-border' : 'text-grey-35 hover:text-ink'
                  }`}
                >
                  {sub.label}
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </header>
  )
}
