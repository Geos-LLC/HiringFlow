import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

(async () => {
  // Find ALL pipelines named Cleaner / Dispatcher in any workspace
  const cleaners = await prisma.pipeline.findMany({
    where: { name: { in: ['Cleaner', 'Dispatcher', 'test pipeline 4'] } },
    select: {
      id: true,
      name: true,
      workspaceId: true,
      isDefault: true,
      workspace: { select: { name: true } },
    },
  });
  console.log('All matching pipelines across workspaces:', JSON.stringify(cleaners, null, 2));

  // Find all workspaces the user "info@spotless.homes" belongs to
  const user = await prisma.user.findFirst({
    where: { email: 'info@spotless.homes' },
    select: {
      id: true,
      email: true,
      memberships: {
        select: {
          workspaceId: true,
          role: true,
          workspace: { select: { id: true, name: true } },
        },
      },
    },
  });
  console.log('User memberships:', JSON.stringify(user, null, 2));

  // For each workspace user belongs to, count candidates and check Tassy
  if (user) {
    for (const m of user.memberships) {
      const total = await prisma.session.count({ where: { workspaceId: m.workspaceId } });
      const tassy = await prisma.session.count({
        where: {
          workspaceId: m.workspaceId,
          candidateName: { contains: 'Tassy', mode: 'insensitive' },
        },
      });
      console.log(`WS ${m.workspaceId} (${m.workspace.name}): ${total} total sessions, ${tassy} Tassy matches`);
    }
  }

  await prisma.$disconnect();
})();
