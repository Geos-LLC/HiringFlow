/**
 * Dashboard chrome. Responsive:
 *   - Desktop: 60px TopNav with horizontal tab row, main container
 *     max-w-[1596px] with 132px side padding at lg.
 *   - Mobile (< md): TopNav collapses to logo + search icon + avatar +
 *     hamburger. The hamburger opens MobileNav — a right-side drawer
 *     containing the full tab list, user card, and a Sign out footer.
 *     Horizontal swipe on <main> routes to the neighbouring tab (handled
 *     by SwipeTabs). Flow builder is opted out of swipe because it owns
 *     its own horizontal drag.
 */

'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { signOut, useSession } from 'next-auth/react'
import { Toaster } from 'sonner'
import { TopNav, type TopNavItem } from '@/components/design'
import { SwipeTabs } from '@/components/design/SwipeTabs'
import { TranscodeBanner } from './_components/TranscodeBanner'
import { UploadProvider } from './_components/UploadProvider'
import { DeliveryFailureToaster } from './_components/DeliveryFailureToaster'

// Grouped navigation. Row 1 shows the five group labels (Recruiting /
// Process / Content / Insights / Admin); row 2 shows the active group's
// children. The group's own `href` is the first child's route so clicking
// the group lands on a real page.
//
// Routes deliberately not surfaced in nav: /dashboard/flows (reached via
// Journey editor), /dashboard/branding (reached via Settings). They still
// work as direct URLs — this is a regroup, not a removal.
const NAV_ITEMS: TopNavItem[] = [
  {
    label: 'Recruiting',
    href: '/dashboard/candidates',
    children: [
      { label: 'Candidates', href: '/dashboard/candidates' },
      { label: 'Pipeline',   href: '/dashboard/pipelines' },
      { label: 'Campaigns',  href: '/dashboard/campaigns' },
    ],
  },
  {
    label: 'Process',
    href: '/dashboard/flows',
    children: [
      { label: 'Workflows',   href: '/dashboard/flows' },
      { label: 'Automations', href: '/dashboard/automations' },
      { label: 'Scheduling',  href: '/dashboard/scheduling' },
    ],
  },
  {
    label: 'Content',
    href: '/dashboard/trainings',
    children: [
      { label: 'Trainings', href: '/dashboard/trainings', matches: ['/dashboard/ai-calls'] },
      { label: 'Templates', href: '/dashboard/content' },
      { label: 'Media',     href: '/dashboard/videos' },
    ],
  },
  {
    label: 'Insights',
    href: '/dashboard/analytics',
    children: [
      { label: 'Analytics', href: '/dashboard/analytics' },
    ],
  },
  {
    label: 'Admin',
    href: '/dashboard/settings',
    children: [
      { label: 'Settings', href: '/dashboard/settings' },
    ],
  },
]

// Routes that own their own horizontal drag (flow builder canvas, training
// editor drag-reorder). Swipe-to-switch-tab is disabled inside them.
const SWIPE_DISABLED = ['/dashboard/flows/', '/dashboard/trainings/']

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || ''
  const { data: session } = useSession()
  const user = session?.user as { name?: string; email?: string; workspaceName?: string; isSuperAdmin?: boolean } | undefined
  const workspaceName = user?.workspaceName || ''
  const isSuperAdmin = user?.isSuperAdmin || false

  const signOutBtn = (
    <button
      onClick={() => signOut({ callbackUrl: '/login' })}
      className="text-[12px] text-grey-35 hover:text-ink transition-colors px-2 py-1"
    >
      Sign out
    </button>
  )

  return (
    <UploadProvider>
      <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)' }}>
        <TopNav
          items={NAV_ITEMS}
          workspaceName={workspaceName}
          user={{ name: user?.name, email: user?.email, avatarUrl: null }}
          mobileFooter={signOutBtn}
          cta={
            <div className="flex items-center gap-2">
              {isSuperAdmin && (
                <Link
                  href="/platform-admin"
                  className="font-mono text-[10px] uppercase px-2.5 py-1 rounded-full border"
                  style={{ letterSpacing: '0.1em', color: 'var(--warn-fg)', background: 'var(--warn-bg)', borderColor: 'transparent' }}
                >
                  Platform
                </Link>
              )}
              {signOutBtn}
            </div>
          }
        />

        <TranscodeBanner />
        <DeliveryFailureToaster />
        <Toaster position="bottom-right" richColors closeButton />

        <SwipeTabs items={NAV_ITEMS} disabledPaths={SWIPE_DISABLED}>
          <main
            className={`flex-1 w-full max-w-[1596px] mx-auto px-4 md:px-6 lg:px-[132px] py-6 md:py-8 ${
              pathname.endsWith('/builder') ? 'pt-0' : ''
            }`}
          >
            {children}
          </main>
        </SwipeTabs>
      </div>
    </UploadProvider>
  )
}
