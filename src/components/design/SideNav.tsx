/**
 * SideNav — left sidebar app shell matching the redesigned Design/*.png mocks.
 *
 * 240px fixed rail on desktop, collapses to a hamburger drawer on mobile
 * (handled by parent layout). Groups:
 *   Top:    Home / Pipelines / Positions / Candidates / Trainings /
 *           Automations / Media
 *   Bottom: Reports / Settings, then the user card
 *
 * Selected item = orange pill background. Icons are inline SVG so the
 * component has no external dep.
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export interface SideNavItem {
  label: string
  href: string
  icon: React.ReactNode
  /** Optional additional path prefixes that should render the item as active. */
  matches?: string[]
}

export interface SideNavProps {
  primary: SideNavItem[]
  secondary: SideNavItem[]
  user: { name?: string | null; email?: string | null; role?: string | null }
  footer?: React.ReactNode
  brand?: React.ReactNode
}

export function SideNav({ primary, secondary, user, footer, brand }: SideNavProps) {
  return (
    <aside
      className="hidden md:flex fixed left-0 top-0 bottom-0 w-[240px] flex-col bg-[#FAF6EE] border-r border-surface-border z-30"
    >
      <div className="px-5 pt-5 pb-4">
        {brand ?? <DefaultBrand />}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        <ul className="flex flex-col gap-0.5">
          {primary.map(item => <NavRow key={item.href} item={item} />)}
        </ul>

        <div className="mt-6 mb-2 h-px bg-surface-divider" />

        <ul className="flex flex-col gap-0.5">
          {secondary.map(item => <NavRow key={item.href} item={item} />)}
        </ul>
      </nav>

      <div className="border-t border-surface-divider px-3 py-3">
        <UserCard user={user} />
        {footer && <div className="mt-2">{footer}</div>}
      </div>
    </aside>
  )
}

function NavRow({ item }: { item: SideNavItem }) {
  const pathname = usePathname() || ''
  const active =
    pathname === item.href ||
    pathname.startsWith(item.href + '/') ||
    (item.matches || []).some(m => pathname === m || pathname.startsWith(m + '/'))

  return (
    <li>
      <Link
        href={item.href}
        className={
          'flex items-center gap-3 px-3 py-2 rounded-[10px] text-[13px] transition-colors ' +
          (active
            ? 'bg-brand-500 text-white'
            : 'text-grey-30 hover:bg-white/70 hover:text-ink')
        }
        style={active ? { background: 'var(--brand-primary)' } : undefined}
      >
        <span className={active ? 'text-white' : 'text-grey-40'}>{item.icon}</span>
        <span className="truncate">{item.label}</span>
      </Link>
    </li>
  )
}

function UserCard({ user }: { user: SideNavProps['user'] }) {
  const name = user.name || (user.email ? user.email.split('@')[0] : 'User')
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')
  const bg = avatarBg(name)
  return (
    <div className="flex items-center gap-2.5 px-1">
      <span aria-hidden className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-[13px]" style={{ background: bg }}>
        {initials}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink truncate">{name}</div>
        {user.role && <div className="text-[11px] text-grey-40 truncate">{user.role}</div>}
      </div>
    </div>
  )
}

function avatarBg(name: string): string {
  const palette = ['#4B9F6F', '#C5638A', '#7B6BD6', '#5D8AC7', '#3F9E9C', '#C68A3F']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function DefaultBrand() {
  return (
    <div className="flex items-center gap-2">
      <span className="w-7 h-7 rounded-md bg-brand-500 flex items-center justify-center text-white font-bold text-[13px]" aria-hidden>H</span>
      <span className="font-semibold text-ink text-[14px]">HireFunnel</span>
    </div>
  )
}

// ─── Icons (18px) ───────────────────────────────────────────────────────────

const s = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const NavIcons = {
  home:        <svg {...s}><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2h-4a2 2 0 01-2-2v-4a2 2 0 00-2-2 2 2 0 00-2 2v4a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>,
  pipelines:   <svg {...s}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>,
  positions:   <svg {...s}><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" /></svg>,
  candidates:  <svg {...s}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></svg>,
  trainings:   <svg {...s}><path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" /></svg>,
  automations: <svg {...s}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>,
  media:       <svg {...s}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>,
  reports:     <svg {...s}><line x1="12" y1="20" x2="12" y2="10" /><line x1="18" y1="20" x2="18" y2="4" /><line x1="6" y1="20" x2="6" y2="16" /></svg>,
  settings:    <svg {...s}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" /></svg>,
  bars:        <svg {...s}><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>,
} as const
