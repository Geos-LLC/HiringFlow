'use client'

import { useEffect } from 'react'
import { SessionProvider } from 'next-auth/react'
import { initFixPrompt } from '@fixprompt/browser'

let fixPromptInitialized = false

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (fixPromptInitialized) return
    const key = process.env.NEXT_PUBLIC_FIXPROMPT_KEY
    if (!key) return
    initFixPrompt({
      projectKey: key,
      source: 'hiringflow-frontend-prod',
      service: 'hiringflow-frontend',
      env: process.env.NODE_ENV === 'production' ? 'prod' : 'dev',
    })
    fixPromptInitialized = true
  }, [])

  return <SessionProvider>{children}</SessionProvider>
}
