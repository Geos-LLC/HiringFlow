import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { gatherCandidateMaterial } from '@/lib/evaluation/gather'
import { runEvaluation } from '@/lib/evaluation/engine'
import { buildPositionDescription } from '@/lib/evaluation/position-description'
import { observeVoice, observeVideo } from '@/lib/evaluation/media-observation'

/**
 * GET /api/evaluations?sessionIds=a,b,c
 *
 * Returns the latest CandidateEvaluation per requested session id (skip if
 * none exists). Used by the Analytics > AI Evaluation comparison table.
 *
 * Without `sessionIds`, returns the 50 most recent evaluations in the
 * workspace.
 */
export async function GET(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const url = new URL(request.url)
  const sessionIdsParam = url.searchParams.get('sessionIds')

  if (sessionIdsParam) {
    const sessionIds = sessionIdsParam.split(',').map((s) => s.trim()).filter(Boolean)
    if (sessionIds.length === 0) return NextResponse.json({ evaluations: [] })

    const rows = await prisma.candidateEvaluation.findMany({
      where: { workspaceId: ws.workspaceId, sessionId: { in: sessionIds } },
      orderBy: { createdAt: 'desc' },
      include: {
        session: {
          select: { id: true, candidateName: true, candidateEmail: true, flow: { select: { name: true } } },
        },
      },
    })

    // Latest per session
    const latest = new Map<string, (typeof rows)[number]>()
    for (const r of rows) {
      if (!latest.has(r.sessionId)) latest.set(r.sessionId, r)
    }
    return NextResponse.json({ evaluations: Array.from(latest.values()) })
  }

  const rows = await prisma.candidateEvaluation.findMany({
    where: { workspaceId: ws.workspaceId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      session: {
        select: { id: true, candidateName: true, candidateEmail: true, flow: { select: { name: true } } },
      },
    },
  })
  return NextResponse.json({ evaluations: rows })
}

/**
 * POST /api/evaluations
 * body: { sessionId: string, positionDescription?: string }
 *
 * Runs the evaluation engine end-to-end and persists a CandidateEvaluation
 * row. Returns the row.
 */
export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const {
    sessionId,
    positionDescription: override,
    includeVoice,
    includeVideo,
  } = (await request.json()) as {
    sessionId: string
    positionDescription?: string
    includeVoice?: boolean
    includeVideo?: boolean
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  }

  const session = await prisma.session.findFirst({
    where: { id: sessionId, workspaceId: ws.workspaceId },
    include: { flow: true, ad: true, workspace: true },
  })
  if (!session) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })

  const { text: positionDescription } = await buildPositionDescription(session, override)
  if (!positionDescription.trim()) {
    return NextResponse.json(
      { error: 'No position description available — paste one in the override field or set it on the flow.' },
      { status: 400 },
    )
  }

  const gathered = await gatherCandidateMaterial(sessionId, ws.workspaceId)
  if (!gathered) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })

  const hasAnyMaterial =
    gathered.material.aiCalls.some((c) => c.transcript.length > 0) ||
    gathered.material.captures.some((c) => !!c.transcript?.trim()) ||
    gathered.material.meetings.some((m) => !!m.actualStart)

  if (!hasAnyMaterial) {
    return NextResponse.json(
      {
        error:
          'No recorded material available for this candidate yet — they need at least one AI call, screening recording, or interview before evaluation.',
      },
      { status: 400 },
    )
  }

  try {
    // Run media observation passes BEFORE scoring so their findings can be
    // folded into the scoring prompt as additional evidence. Each pass
    // checks MediaAnalysisCache and only spends OpenAI tokens on clips that
    // haven't been observed at this analysisVersion yet.
    const voice = includeVoice
      ? await observeVoice(ws.workspaceId, gathered.voiceClips)
      : null
    const video = includeVideo
      ? await observeVideo(ws.workspaceId, gathered.videoClips)
      : null

    const result = await runEvaluation(positionDescription, gathered.material, voice, video)

    const row = await prisma.candidateEvaluation.create({
      data: {
        workspaceId: ws.workspaceId,
        sessionId,
        positionDescriptionSnapshot: positionDescription,
        model: 'gpt-4o-mini',
        overallScore: result.overallScore,
        recommendation: result.recommendation,
        summary: result.summary,
        criteria: result.criteria as any,
        strengths: result.strengths as any,
        weaknesses: result.weaknesses as any,
        sources: gathered.sources as any,
        includeVoice: !!includeVoice,
        includeVideo: !!includeVideo,
        voiceObservation: voice as any,
        videoObservation: video as any,
        createdById: ws.userId,
      },
    })

    return NextResponse.json({ evaluation: row })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Evaluation failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
