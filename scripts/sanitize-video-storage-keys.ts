// One-shot: scrub BOM + CR/LF/tab from Video.storageKey rows that got
// polluted by the bad R2_PUBLIC_DOMAIN env var (the env-read now strips
// these but already-persisted rows still 404 in Deepgram). Safe to re-run.

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const BAD = /[﻿\r\n\t]/

async function main() {
  const candidates = await prisma.video.findMany({
    where: { storageKey: { not: '' } },
    select: { id: true, storageKey: true },
  })
  console.log(`scanning ${candidates.length} videos`)
  let fixed = 0
  for (const v of candidates) {
    if (!BAD.test(v.storageKey)) continue
    const cleaned = v.storageKey.replace(/﻿/g, '').replace(/[\r\n\t]/g, '').trim()
    if (cleaned === v.storageKey) continue
    await prisma.video.update({ where: { id: v.id }, data: { storageKey: cleaned } })
    fixed++
    console.log(`fixed ${v.id}`)
  }
  console.log(`done — ${fixed} rows updated`)
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
