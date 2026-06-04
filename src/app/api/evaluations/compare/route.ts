/**
 * POST /api/evaluations/compare
 *
 * Body: { sessionIds: string[] }
 *
 * Loads the latest CandidateEvaluation per requested session, then asks the
 * comparison engine to produce a role-aware relative summary. The role JD
 * comes from the most recent evaluation's positionDescriptionSnapshot — when
 * evaluations were run against different JDs (override or different flow),
 * the comparison is still meaningful but reflects the candidates' relative
 * fit for the FIRST candidate's JD. UI surfaces a "Note: comparing across
 * different JDs" warning in that case.
 *
 * Returns: { comparison: ComparisonResult, jdSource: { sessionId, snapshot } }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceSession, unauthorized } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import {
  compareEvaluations,
  type ComparisonInputEvaluation,
} from '@/lib/evaluation/engine'

export async function POST(request: NextRequest) {
  const ws = await getWorkspaceSession()
  if (!ws) return unauthorized()

  const { sessionIds } = (await request.json()) as { sessionIds?: string[] }
  if (!Array.isArray(sessionIds) || sessionIds.length < 2) {
    return NextResponse.json(
      { error: 'Need at least 2 sessionIds to compare' },
      { status: 400 },
    )
  }

  // Load latest evaluation per requested session.
  const rows = await prisma.candidateEvaluation.findMany({
    where: { workspaceId: ws.workspaceId, sessionId: { in: sessionIds } },
    orderBy: { createdAt: 'desc' },
    include: {
      session: { select: { id: true, candidateName: true } },
    },
  })
  const latest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!latest.has(r.sessionId)) latest.set(r.sessionId, r)

  if (latest.size < 2) {
    return NextResponse.json(
      {
        error:
          'At least 2 of the requested candidates need a saved evaluation before comparison. Run evaluations first.',
      },
      { status: 400 },
    )
  }

  const evaluations: ComparisonInputEvaluation[] = Array.from(latest.values()).map((e) => ({
    sessionId: e.sessionId,
    candidateName: e.session.candidateName,
    overallScore: e.overallScore,
    recommendation: e.recommendation as ComparisonInputEvaluation['recommendation'],
    summary: e.summary,
    criteria: (e.criteria as any[]).map((c) => ({
      name: c.name,
      weight: c.weight,
      score: c.score,
      evidence: c.evidence,
    })),
    strengths: (e.strengths as string[]) ?? [],
    weaknesses: (e.weaknesses as string[]) ?? [],
    roleSuccessFactors: (e.roleSuccessFactors as string[] | null) ?? null,
  }))

  // Use the most recent evaluation's JD snapshot as the canonical role
  // description for the comparison prompt. Note: if the evaluations span
  // different JDs (override on one, default on another) the UI will surface
  // a notice — the comparison still runs, but the recruiter should know.
  const newest = evaluations[0]
  const newestRow = latest.get(newest.sessionId)!
  const positionDescription = newestRow.positionDescriptionSnapshot

  // Detect cross-JD comparisons so the response can flag them.
  const jdSnapshots = new Set(
    Array.from(latest.values()).map((e) => e.positionDescriptionSnapshot),
  )
  const crossJd = jdSnapshots.size > 1

  try {
    const comparison = await compareEvaluations(positionDescription, evaluations)
    return NextResponse.json({
      comparison,
      jdSource: { sessionId: newest.sessionId, snapshot: positionDescription },
      crossJd,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Comparison failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
