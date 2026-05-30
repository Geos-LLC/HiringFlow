import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const REGION_BASE_URLS: any = {
  'us-east-1': 'https://us-east-1.recall.ai',
  'us-west-2': 'https://us-west-2.recall.ai',
  'eu-central-1': 'https://eu-central-1.recall.ai',
  'ap-northeast-1': 'https://ap-northeast-1.recall.ai',
};

async function recall(path: string) {
  const url = `${REGION_BASE_URLS[process.env.RECALL_REGION || 'us-east-1']}${path}`;
  const res = await fetch(url, { headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  const email = 'dankivski@gmail.com';
  const sessions = await prisma.session.findMany({
    where: { candidateEmail: { equals: email, mode: 'insensitive' } },
    select: {
      id: true,
      candidateName: true,
      candidateEmail: true,
      status: true,
      pipelineStatus: true,
      workspaceId: true,
      flowId: true,
      startedAt: true,
      finishedAt: true,
      interviewMeetings: {
        select: {
          id: true,
          scheduledStart: true,
          scheduledEnd: true,
          actualStart: true,
          actualEnd: true,
          attendanceSource: true,
          meetSpaceName: true,
          meetingCode: true,
          meetingUri: true,
          recordingState: true,
          transcriptState: true,
          recallRecordingId: true,
          recallBotId: true,
          confirmedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { scheduledStart: 'desc' },
      },
      schedulingEvents: {
        select: {
          id: true,
          eventType: true,
          createdAt: true,
          metadata: true,
          eventAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
      },
    },
  });

  console.log(`\nFound ${sessions.length} session(s) for ${email}\n`);
  for (const s of sessions) {
    console.log(`--- session ${s.id} (${s.candidateName}) ---`);
    console.log(`workspaceId: ${s.workspaceId}  flowId: ${s.flowId}`);
    console.log(`status=${s.status} pipelineStatus=${s.pipelineStatus} startedAt=${s.startedAt?.toISOString()} finishedAt=${s.finishedAt?.toISOString() || '-'}`);

    // workspace recall feature flag
    const ws = await prisma.workspace.findUnique({
      where: { id: s.workspaceId },
      select: { id: true, name: true, settings: true },
    });
    const settings: any = ws?.settings || {};
    console.log(`workspace: ${ws?.name}  recallBotEnabled=${settings.recallBotEnabled}  recallBotMode=${settings.recallBotMode || '-'}`);

    for (const m of s.interviewMeetings) {
      console.log(`\n  meeting ${m.id}`);
      console.log(`    scheduled: ${m.scheduledStart?.toISOString()} -> ${m.scheduledEnd?.toISOString()}`);
      console.log(`    actual:    ${m.actualStart?.toISOString() || '-'} -> ${m.actualEnd?.toISOString() || '-'}`);
      console.log(`    meetingUri: ${m.meetingUri}`);
      console.log(`    meetSpaceName: ${m.meetSpaceName}`);
      console.log(`    recallBotId: ${m.recallBotId || '(none)'}`);
      console.log(`    recallRecordingId: ${m.recallRecordingId || '-'}`);
      console.log(`    recordingState: ${m.recordingState}  transcriptState: ${m.transcriptState}  attendanceSource: ${m.attendanceSource}`);
      console.log(`    confirmedAt: ${m.confirmedAt?.toISOString() || '-'}`);
      console.log(`    createdAt:   ${m.createdAt.toISOString()}  updatedAt: ${m.updatedAt.toISOString()}`);

      if (m.recallBotId) {
        const b = await recall(`/api/v1/bot/${m.recallBotId}/`);
        const bo: any = b.body;
        console.log(`    recall.ai bot status (${b.status}):`);
        if (bo) {
          console.log(`      meeting_url: ${JSON.stringify(bo.meeting_url)}`);
          console.log(`      join_at: ${bo.join_at}`);
          console.log(`      status_changes:`);
          for (const sc of bo.status_changes || []) {
            console.log(`        ${sc.created_at}  ${sc.code}  ${sc.sub_code || ''}  ${sc.message || ''}`);
          }
          console.log(`      recordings: ${(bo.recordings || []).length}`);
        } else {
          console.log(`      body: ${JSON.stringify(b.body)}`);
        }
      }
    }

    console.log(`\n  scheduling events (recent ${s.schedulingEvents.length}):`);
    for (const e of s.schedulingEvents) {
      console.log(`    ${e.createdAt.toISOString()}  ${e.eventType}  ${JSON.stringify(e.metadata || {}).slice(0, 240)}`);
    }
    console.log('');
  }

  await prisma.$disconnect();
})();
