// One-shot helper: loads cleaned prod DATABASE_URL/DIRECT_URL from .env.prod
// (stripping the trailing literal \n that Vercel CLI exports leave behind),
// then exec's `prisma db push` against prod. Use ONLY for the Phase 1A
// capture schema push approved 2026-05-11.
const fs = require('fs')
const { spawnSync } = require('child_process')

const text = fs.readFileSync('.env.prod', 'utf8')

function read(key) {
  const m = text.match(new RegExp('^' + key + '=(.*)$', 'm'))
  if (!m) return null
  let v = m[1].trim()
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  // Strip literal backslash-n appended by Vercel CLI exports.
  if (v.endsWith('\\n')) v = v.slice(0, -2)
  return v
}

const db = read('DATABASE_URL')
const direct = read('DIRECT_URL') || db
if (!db) {
  console.error('No DATABASE_URL in .env.prod')
  process.exit(1)
}

console.log('Target host:', db.replace(/.*@/, '').replace(/\/.*/, ''))
console.log('URL ends with:', JSON.stringify(db.slice(-15)))

const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['prisma', 'db', 'push', '--skip-generate'],
  {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: db, DIRECT_URL: direct },
  }
)
process.exit(r.status ?? 1)
