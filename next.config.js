/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    // Baked into the client bundle at build time so the "update available"
    // banner can compare this-tab's version against /version.json served by
    // the currently-live deploy. Falls back to 'dev' for local runs.
    NEXT_PUBLIC_BUILD_VERSION:
      (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev',
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '100mb',
    },
    // Enables ./instrumentation.ts — runs register() once per server
    // runtime init. We use it to monkey-patch console.* so every log line
    // forwards to LogHub (→ Grafana Loki). See instrumentation.ts.
    instrumentationHook: true,
    // Keep ffmpeg-static out of the webpack bundle so the native ffmpeg
    // binary stays at its real path on disk inside the function bundle
    // instead of being mangled. video-frames.ts spawns it by path.
    serverComponentsExternalPackages: ['ffmpeg-static'],
  },
  // When Next traces files into the serverless bundle, it discovers them
  // through import graphs. ffmpeg-static is referenced via a string at
  // runtime, so the binary itself can be missed. Force it in so the
  // /api/evaluations function actually has ffmpeg to spawn.
  outputFileTracingIncludes: {
    'src/app/api/evaluations/route.ts': [
      'node_modules/ffmpeg-static/**',
    ],
  },
}

module.exports = nextConfig
