'use client'

import { useState } from 'react'

export function CopyLinkButton() {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(window.location.href)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          window.prompt('Copy this link:', window.location.href)
        }
      }}
      className="px-3 py-1 rounded bg-primary text-white text-xs hover:opacity-90 shrink-0"
    >
      {copied ? 'Copied!' : 'Copy link'}
    </button>
  )
}
