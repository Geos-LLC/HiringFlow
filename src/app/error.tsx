'use client'

import { useEffect } from 'react'
import { captureException } from '@fixprompt/browser'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    captureException(error, {
      attrs: { boundary: 'app/error.tsx', digest: error.digest ?? null },
    })
  }, [error])

  return (
    <div
      style={{
        padding: 24,
        fontSize: 14,
        color: '#374151',
        textAlign: 'center',
        marginTop: 80,
        fontFamily: 'inherit',
      }}
    >
      <p style={{ fontWeight: 600, marginBottom: 12, fontSize: 16, color: '#111827' }}>
        Something went wrong loading this page.
      </p>
      <button
        onClick={reset}
        style={{
          padding: '8px 16px',
          borderRadius: 8,
          border: '1px solid #d1d5db',
          background: '#fff',
          cursor: 'pointer',
          fontWeight: 600,
          color: '#111827',
        }}
      >
        Try again
      </button>
    </div>
  )
}
