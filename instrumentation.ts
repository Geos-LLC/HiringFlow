/**
 * Next.js instrumentation hook — runs once per server runtime init.
 *
 * Monkey-patches `console.*` so every log line on the Node runtime also
 * forwards to LogHub (→ Grafana Loki). Without this, only the ~5 routes
 * that explicitly import `@/lib/logger` ended up in Loki; everything else
 * (automation dispatch, the guard, webhook handlers, etc.) only landed in
 * Vercel's per-function logs and was unreachable for cross-request
 * debugging.
 *
 * Edge runtime is skipped — the loghub client uses Node `fetch` with
 * keepalive semantics that don't apply there, and Edge functions have
 * tighter cold-start budgets where adding a network call per console
 * line would be reckless.
 *
 * The patch is guarded against re-entry: if loghubLog itself calls
 * console.* during error reporting, we drop the recursive forward rather
 * than risk an infinite loop in a function lambda.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // JSON.stringify throws on bigint by default. Video.sizeBytes and any other
  // BigInt Prisma column would break every NextResponse.json({ ...row }) call
  // without this shim. File sizes fit comfortably in a JS Number (safe up to
  // 9 petabytes), so returning a plain number keeps the wire format stable
  // for clients that still declare `sizeBytes: number`.
  ;(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
    return Number(this as unknown as bigint)
  }

  // Load the client lazily so the import doesn't crash the runtime if the
  // package can't resolve for some reason (e.g. fresh checkout pre-install).
  let loghubLog: ((opts: Record<string, unknown>) => Promise<unknown>) | null = null
  try {
    const mod = (await import('@geos/loghub-client')) as unknown as {
      loghubLog?: (opts: Record<string, unknown>) => Promise<unknown>
    }
    loghubLog = mod.loghubLog ?? null
  } catch {
    return
  }
  if (!loghubLog) return

  const SERVICE = 'hiringflow'
  const APP = 'hiringflow'
  const ENV = process.env.NODE_ENV === 'production' ? 'prod' : 'dev'

  // Guard against the patch being applied twice (hot reload in dev, or two
  // independent imports). A symbol-tagged property on console is the
  // cheapest sentinel.
  const FLAG = Symbol.for('hf.loghub.consolePatched')
  const c = console as unknown as Record<symbol, unknown>
  if (c[FLAG]) return
  c[FLAG] = true

  let inFlight = false

  function format(args: unknown[]): string {
    return args
      .map((a) => {
        if (typeof a === 'string') return a
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')
  }

  function wrap(level: 'debug' | 'info' | 'warn' | 'error', original: (...args: unknown[]) => void) {
    return function patched(this: unknown, ...args: unknown[]) {
      // Always preserve the original console behavior — Vercel function
      // logs still receive the line at full fidelity.
      original.apply(this, args)
      if (inFlight) return
      inFlight = true
      try {
        const message = format(args)
        // Fire-and-forget. We never await — a slow LogHub must not block
        // the request that emitted the line.
        loghubLog!({
          service: SERVICE,
          app: APP,
          env: ENV,
          level,
          message,
        }).catch(() => {})
      } finally {
        inFlight = false
      }
    }
  }

  console.log   = wrap('info',  console.log.bind(console))
  console.info  = wrap('info',  console.info.bind(console))
  console.warn  = wrap('warn',  console.warn.bind(console))
  console.error = wrap('error', console.error.bind(console))
  console.debug = wrap('debug', console.debug.bind(console))
}
