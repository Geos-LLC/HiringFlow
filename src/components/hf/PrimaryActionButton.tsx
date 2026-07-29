/**
 * PrimaryActionButton — the single most-important action on any HFObject
 * surface (UX rule #5).
 *
 * Receives a `PrimaryAction` and dispatches based on `target.kind`:
 *   - href     → next/link navigation
 *   - drawer   → calls the provided `onOpenDrawer(drawerId, params)` handler
 *   - callback → calls the provided `onCallback(callbackId)` handler
 *   - null     → renders disabled placeholder
 *
 * The button uses the existing design-system `Button` primary variant so
 * every "primary action" across the app has identical weight.
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import { Button } from '@/components/design'
import type { PrimaryAction } from '@/lib/hf-core/types'

export interface PrimaryActionButtonProps {
  action: PrimaryAction
  /** Called when the target is a drawer. Parent owns the drawer state. */
  onOpenDrawer?: (drawerId: string, params?: Record<string, string>) => void
  /** Called when the target is a callback (freeform imperative action). */
  onCallback?: (callbackId: string) => void
  size?: 'sm' | 'md'
  className?: string
}

export function PrimaryActionButton({
  action,
  onOpenDrawer,
  onCallback,
  size = 'md',
  className,
}: PrimaryActionButtonProps) {
  if (action.target?.kind === 'href') {
    return (
      <Link href={action.target.href} className={className}>
        <Button size={size} variant="primary" disabled={!!action.disabled}>
          {action.verb}
        </Button>
      </Link>
    )
  }

  return (
    <Button
      size={size}
      variant="primary"
      className={className}
      disabled={!!action.disabled}
      title={action.disabled}
      onClick={() => {
        if (!action.target) return
        if (action.target.kind === 'drawer') onOpenDrawer?.(action.target.drawerId, action.target.params)
        else if (action.target.kind === 'callback') onCallback?.(action.target.callbackId)
      }}
    >
      {action.verb}
    </Button>
  )
}
