import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

(async () => {
  const sessionId = 'a2c6834d-730b-4e54-ae01-97be28517252';

  const before = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      status: true,
      dispositionReason: true,
      stalledAt: true,
      automationsHaltedAt: true,
      automationsHaltedReason: true,
      pipelineStatus: true,
    },
  });
  console.log('BEFORE:', JSON.stringify(before, null, 2));

  const updated = await prisma.session.update({
    where: { id: sessionId },
    data: {
      status: 'active',
      dispositionReason: null,
      stalledAt: null,
      automationsHaltedAt: null,
      automationsHaltedReason: null,
    },
    select: {
      status: true,
      dispositionReason: true,
      stalledAt: true,
      automationsHaltedAt: true,
      automationsHaltedReason: true,
      pipelineStatus: true,
    },
  });
  console.log('AFTER:', JSON.stringify(updated, null, 2));

  await prisma.$disconnect();
})();
