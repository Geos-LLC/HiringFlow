/**
 * Shared design-system primitives — port of
 * Design/design_handoff_hirefunnel/ui.jsx.
 *
 * Import from here, not from individual files, so the component set stays
 * cohesive and easy to audit. Token values live in globals.css (CSS vars)
 * and tailwind.config.js (theme).
 */

export { Button, type ButtonProps } from './Button'
export { Badge, type BadgeProps, type BadgeTone } from './Badge'
export { Card, type CardProps } from './Card'
export { Eyebrow, type EyebrowProps } from './Eyebrow'
export { PageHeader, type PageHeaderProps } from './PageHeader'
export { Sparkline, type SparklineProps } from './Sparkline'
export { Stat, type StatProps } from './Stat'
export { TopNav, type TopNavProps, type TopNavItem } from './TopNav'
export { MobileNav, type MobileNavProps } from './MobileNav'
export { SwipeTabs, type SwipeTabsProps } from './SwipeTabs'
export { useSwipeNav } from './useSwipeNav'
export { WipBadge, WipSection, type WipBadgeProps, type WipSectionProps } from './WipBadge'
