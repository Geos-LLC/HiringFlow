import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const ws = await prisma.workspace.findFirst({
    where: { name: { contains: 'Spotless' } },
    select: { id: true, name: true, senderEmail: true, senderName: true, senderVerifiedAt: true, senderDomain: true, senderDomainValidatedAt: true },
  })
  console.log('Workspace:', JSON.stringify(ws, null, 2))
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
