/**
 * Dashboard chrome — matches the left-sidebar app shell from Design/*.png.
 *
 * Desktop: 240px fixed left sidebar (SideNav), content offset by ml-[240px].
 * Mobile:  sidebar hidden; hamburger opens the existing MobileNav drawer
 *          which still uses the horizontal-nav item structure.
 *
 * Routes are unchanged. If you're adding a new dashboard page, add its
 * entry to PRIMARY_NAV or SECONDARY_NAV below and it'll appear in the
 * sidebar automatically.
 */

'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { signOut, useSession } from 'next-auth/react'
import { Toaster } from 'sonner'
import { SideNav, NavIcons, type SideNavItem } from '@/components/design'
import { MobileNav, type TopNavItem } from '@/components/design'
import { TranscodeBanner } from './_components/TranscodeBanner'
import { UploadProvider } from './_components/UploadProvider'
import { DeliveryFailureToaster } from './_components/DeliveryFailureToaster'

const PRIMARY_NAV: SideNavItem[] = [
  { label: 'Home',        href: '/dashboard',              icon: NavIcons.home },
  { label: 'Pipelines',   href: '/dashboard/pipelines',    icon: NavIcons.pipelines },
  { label: 'Positions',   href: '/dashboard/positions',    icon: NavIcons.positions, matches: ['/dashboard/campaigns'] },
  { label: 'Candidates',  href: '/dashboard/candidates',   icon: NavIcons.candidates },
  { label: 'Trainings',   href: '/dashboard/trainings',    icon: NavIcons.trainings, matches: ['/dashboard/ai-calls'] },
  { label: 'Automations', href: '/dashboard/automations',  icon: NavIcons.automations },
  { label: 'Media',       href: '/dashboard/videos',       icon: NavIcons.media,     matches: ['/dashboard/content'] },
]

const SECONDARY_NAV: SideNavItem[] = [
  { label: 'Reports',  href: '/dashboard/analytics', icon: NavIcons.reports },
  { label: 'Settings', href: '/dashboard/settings',  icon: NavIcons.settings },
]

// Mobile drawer still consumes the horizontal-nav grouping shape.
const MOBILE_NAV: TopNavItem[] = [
  { label: 'Home',        href: '/dashboard',             children: [{ label: 'Home', href: '/dashboard' }] },
  { label: 'Pipelines',   href: '/dashboard/pipelines',   children: [{ label: 'Pipelines', href: '/dashboard/pipelines' }] },
  { label: 'Positions',   href: '/dashboard/positions',   children: [{ label: 'Positions', href: '/dashboard/positions', matches: ['/dashboard/campaigns'] }] },
  { label: 'Candidates',  href: '/dashboard/candidates',  children: [{ label: 'Candidates', href: '/dashboard/candidates' }] },
  { label: 'Trainings',   href: '/dashboard/trainings',   children: [{ label: 'Trainings', href: '/dashboard/trainings', matches: ['/dashboard/ai-calls'] }] },
  { label: 'Automations', href: '/dashboard/automations', children: [{ label: 'Automations', href: '/dashboard/automations' }] },
  { label: 'Media',       href: '/dashboard/videos',      children: [{ label: 'Media', href: '/dashboard/videos', matches: ['/dashboard/content'] }] },
  { label: 'Reports',     href: '/dashboard/analytics',   children: [{ label: 'Reports', href: '/dashboard/analytics' }] },
  { label: 'Settings',    href: '/dashboard/settings',    children: [{ label: 'Settings', href: '/dashboard/settings' }] },
]

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || ''
  const { data: session } = useSession()
  const user = session?.user as { name?: string; email?: string; workspaceName?: string; role?: string; isSuperAdmin?: boolean } | undefined
  const isSuperAdmin = user?.isSuperAdmin || false

  const signOutBtn = (
    <button
      onClick={() => signOut({ callbackUrl: '/login' })}
      className="text-[12px] text-grey-35 hover:text-ink transition-colors px-2 py-1 w-full text-left"
    >
      Sign out
    </button>
  )

  return (
    <UploadProvider>
      <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
        <SideNav
          primary={PRIMARY_NAV}
          secondary={SECONDARY_NAV}
          user={{ name: user?.name, email: user?.email, role: user?.role || 'Recruiter' }}
          footer={
            <div className="flex items-center justify-between">
              {isSuperAdmin && (
                <Link
                  href="/platform-admin"
                  className="font-mono text-[10px] uppercase px-2 py-1 rounded-full"
                  style={{ letterSpacing: '0.1em', color: 'var(--warn-fg)', background: 'var(--warn-bg)' }}
                >
                  Platform
                </Link>
              )}
              {signOutBtn}
            </div>
          }
        />

        {/* Mobile drawer trigger — keeps the app usable on phones without
            forcing the sidebar to shrink. */}
        <div className="md:hidden">
          <MobileNav items={MOBILE_NAV} workspaceName={user?.workspaceName || ''} user={{ name: user?.name, email: user?.email, avatarUrl: null }} footer={signOutBtn} />
        </div>

        <TranscodeBanner />
        <DeliveryFailureToaster />
        <Toaster position="bottom-right" richColors closeButton />

        <main
          className={`md:ml-[240px] w-full max-w-[1596px] mx-auto px-4 md:px-8 lg:px-10 py-6 md:py-8 ${
            pathname.endsWith('/builder') ? 'pt-0' : ''
          }`}
        >
          {children}
        </main>
      </div>
    </UploadProvider>
  )
}
