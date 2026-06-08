import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const ws = '739bcd71-69fd-4b30-a39e-242521b7ab20'
  const all = await prisma.emailTemplate.findMany({
    where: { workspaceId: ws },
    select: {
      id: true,
      name: true,
      subject: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      bodyHtml: true,
    },
    orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
  })

  console.log(`Total email templates: ${all.length}\n`)

  const byName: Record<string, typeof all> = {}
  for (const t of all) {
    byName[t.name] = byName[t.name] || []
    byName[t.name].push(t)
  }

  const dupes = Object.entries(byName).filter(([, v]) => v.length > 1)
  console.log(`Duplicated by name: ${dupes.length}\n`)

  // For each duplicate group, also check which rules reference each copy
  for (const [name, rows] of dupes) {
    console.log(`=== "${name}" (${rows.length} copies) ===`)
    for (const r of rows) {
      const ruleRefs = await prisma.automationRule.count({ where: { emailTemplateId: r.id } })
      const stepRefs = await prisma.automationStep.count({ where: { emailTemplateId: r.id } })
      const bodyHash = r.bodyHtml ? r.bodyHtml.length + ':' + r.bodyHtml.slice(0, 40).replace(/\s+/g, ' ') : '(no body)'
      console.log(`  id=${r.id.slice(0, 8)} subject="${r.subject}"`)
      console.log(`    active=${r.isActive} created=${r.createdAt.toISOString().slice(0, 10)} updated=${r.updatedAt.toISOString().slice(0, 10)}`)
      console.log(`    refs: rules=${ruleRefs} steps=${stepRefs}`)
      console.log(`    body: ${bodyHash}`)
    }
    console.log()
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
