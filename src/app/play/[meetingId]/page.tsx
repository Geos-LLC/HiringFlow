import { notFound, redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getWorkspaceSession } from '@/lib/auth'
import { CopyLinkButton } from './_CopyLinkButton'

export const dynamic = 'force-dynamic'

export default async function RecordingPlayPage({ params }: { params: { meetingId: string } }) {
  const ws = await getWorkspaceSession()
  if (!ws) redirect(`/login?next=/play/${params.meetingId}`)

  const meeting = await prisma.interviewMeeting.findUnique({
    where: { id: params.meetingId },
    select: {
      id: true,
      workspaceId: true,
      driveRecordingFileId: true,
      recallRecordingId: true,
      recordingState: true,
      scheduledStart: true,
      session: { select: { candidateName: true } },
    },
  })
  if (!meeting) notFound()
  if (meeting.workspaceId !== ws.workspaceId) notFound()

  const ready = meeting.recordingState === 'ready' && (meeting.driveRecordingFileId || meeting.recallRecordingId)
  const src = `/api/interview-meetings/${meeting.id}/recording`

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-3 bg-grey-15/90 text-sm">
        <div className="truncate">
          <span className="text-grey-40">Interview recording — </span>
          <span className="text-white">{meeting.session.candidateName || 'Candidate'}</span>
          {meeting.scheduledStart && (
            <span className="text-grey-40 ml-2">
              {new Date(meeting.scheduledStart).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          )}
        </div>
        <CopyLinkButton />
      </header>
      <main className="flex-1 flex items-center justify-center p-4">
        {ready ? (
          <video controls className="w-full max-h-[calc(100vh-4rem)] rounded-md" src={src} />
        ) : (
          <div className="text-grey-40 text-sm">Recording not yet available.</div>
        )}
      </main>
    </div>
  )
}
