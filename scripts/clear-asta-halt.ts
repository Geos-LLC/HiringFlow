import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const email = 'asta.dobrotina@gmail.com'

  const session = await prisma.session.findFirst({
    where: { candidateEmail: { equals: email, mode: 'insensitive' } },
    select: {
      id: true, candidateName: true, candidateEmail: true,
      status: true, automationsHaltedAt: true, automationsHaltedReason: true,
    },
  })

  if (!session) {
    console.log(`No session found for ${email}`)
    return
  }

  console.log(`BEFORE: ${session.candidateName} <${session.candidateEmail}>`)
  console.log(`  status=${session.status}`)
  console.log(`  automationsHaltedAt=${session.automationsHaltedAt?.toISOString() ?? 'null'}`)
  console.log(`  automationsHaltedReason=${session.automationsHaltedReason}`)

  if (session.status === 'active' && session.automationsHaltedAt) {
    const updated = await prisma.session.update({
      where: { id: session.id },
      data: { automationsHaltedAt: null, automationsHaltedReason: null },
      select: { id: true, status: true, automationsHaltedAt: true, automationsHaltedReason: true },
    })
    console.log(`\nAFTER:`)
    console.log(`  status=${updated.status}`)
    console.log(`  automationsHaltedAt=${updated.automationsHaltedAt?.toISOString() ?? 'null'}`)
    console.log(`  automationsHaltedReason=${updated.automationsHaltedReason ?? 'null'}`)
    console.log(`\nCleared halt for session ${session.id}.`)
  } else {
    console.log(`\nNo halt to clear (status=${session.status}, halt=${session.automationsHaltedAt}). Skipping.`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => process.exit(0))
