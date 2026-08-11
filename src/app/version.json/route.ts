import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'edge'

const VERSION =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7)
  || process.env.NEXT_PUBLIC_BUILD_VERSION
  || 'dev'

export function GET() {
  return NextResponse.json(
    { version: VERSION },
    { headers: { 'cache-control': 'no-store, max-age=0' } },
  )
}
