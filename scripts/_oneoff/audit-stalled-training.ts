import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

(async () => {
  const stuck = await prisma.session.findMany({
    where: {
      status: 'stalled',
      dispositionReason: 'training_not_completed',
      automationsHaltedReason: 'cron:stalled:training_not_completed',
    },
    select: {
      id: true,
      candidateName: true,
      candidateEmail: true,
      pipelineStatus: true,
      stalledAt: true,
      flow: { select: { name: true } },
      trainingEnrollments: {
        select: { trainingId: true, status: true, startedAt: true, completedAt: true },
      },
    },
    orderBy: { stalledAt: 'desc' },
  });

  const falsePositives: typeof stuck = [];
  for (const s of stuck) {
    const byTraining = new Map<string, { hasCompleted: boolean; hasInProgress: boolean }>();
    for (const e of s.trainingEnrollments) {
      const cur = byTraining.get(e.trainingId) ?? { hasCompleted: false, hasInProgress: false };
      if (e.status === 'completed') cur.hasCompleted = true;
      if (e.status === 'in_progress' && !e.completedAt) cur.hasInProgress = true;
      byTraining.set(e.trainingId, cur);
    }
    const isFalsePositive = Array.from(byTraining.values()).some(
      (v) => v.hasCompleted && v.hasInProgress,
    );
    if (isFalsePositive) falsePositives.push(s);
  }

  console.log(`Total cron-stalled training_not_completed sessions: ${stuck.length}`);
  console.log(`False positives (have completed enrollment for same training): ${falsePositives.length}`);
  console.log(JSON.stringify(falsePositives, null, 2));

  await prisma.$disconnect();
})();
