/**
 * Drawer — focused-edit surface that keeps parent context visible.
 *
 * UX rule #3 (formalized): drawers are for focused edits, full pages are for
 * creative work. Sizes are per-task, not uniform:
 *
 *   narrow     480px    reminder message, notes
 *   medium     640px    booking config, template body
 *   wide       60% vw   automation rule (multi-step)
 *   fullscreen 90% vw   training editor if used as drawer
 *
 * Slide-in from the right, ESC to close, click outside to close (with
 * optional dirty-confirm). Multiple drawers CAN stack visually but the
 * expected pattern on any single surface is one drawer at a time.
 */

'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'

export type DrawerSize = 'narrow' | 'medium' | 'wide' | 'fullscreen'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  /** Right-aligned actions in the header (Save / Delete / etc.). */
  headerActions?: React.ReactNode
  size?: DrawerSize
  /** If true, block outside-click and ESC dismissal — used when the form is dirty. */
  blockDismiss?: boolean
  /** Sticky footer content (typically Save / Cancel row). */
  footer?: React.ReactNode
  children?: React.ReactNode
  className?: string
}

const WIDTH: Record<DrawerSize, string> = {
  narrow:     '480px',
  medium:     '640px',
  wide:       '60vw',
  fullscreen: '90vw',
}

export function Drawer({
  open,
  onClose,
  title,
  headerActions,
  size = 'medium',
  blockDismiss,
  footer,
  children,
  className = '',
}: DrawerProps) {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !blockDismiss) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, blockDismiss, onClose])

  // Lock body scroll while drawer is open
  React.useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!mounted || !open) return null

  return createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-ink/30"
        onClick={() => !blockDismiss && onClose()}
      />
      <div
        className={`absolute top-0 right-0 h-full bg-white shadow-raised flex flex-col ${className}`.trim()}
        style={{ width: WIDTH[size], maxWidth: '100vw' }}
      >
        {(title || headerActions) && (
          <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-surface-divider shrink-0">
            <div className="min-w-0 flex-1">
              {typeof title === 'string' ? (
                <h2 className="text-[16px] font-semibold text-ink truncate m-0">{title}</h2>
              ) : (
                title
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {headerActions}
              <button
                onClick={onClose}
                aria-label="Close"
                className="text-grey-40 hover:text-ink text-[20px] leading-none px-2 py-1"
              >
                ×
              </button>
            </div>
          </header>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="border-t border-surface-divider px-5 py-3 shrink-0">{footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  )
}
