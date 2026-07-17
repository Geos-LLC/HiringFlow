import { randomBytes } from 'crypto'
import { prisma } from './prisma'

/**
 * Generate a secure random token for training access.
 */
function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Create a training access token for a candidate (session).
 * Returns existing active token if one already exists for this candidate+training.
 */
export async function createAccessToken(opts: {
  sessionId: string
  trainingId: string
  sourceRefId?: string
}): Promise<{ token: string; id: string }> {
  // Check for existing active token
  const existing = await prisma.trainingAccessToken.findFirst({
    where: {
      candidateId: opts.sessionId,
      trainingId: opts.trainingId,
      status: 'active',
    },
  })

  if (existing) {
    return { token: existing.token, id: existing.id }
  }

  const token = generateToken()
  const record = await prisma.trainingAccessToken.create({
    data: {
      token,
      candidateId: opts.sessionId,
      trainingId: opts.trainingId,
      sourceType: 'automation',
      sourceRefId: opts.sourceRefId || null,
      status: 'active',
    },
  })

  return { token: record.token, id: record.id }
}

/**
 * Resolve the app's public base URL. Same precedence used by every
 * outbound-link builder in the app so previews and real emails point
 * at the same domain (matters for the session cookie in owner-preview
 * mode — `?preview=1` needs the recruiter's dashboard cookie in scope).
 */
export function getAppBaseUrl(): string {
  return process.env.APP_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || process.env.NEXTAUTH_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000'
}

/**
 * Build a full training link with token.
 */
export function buildTrainingLink(trainingSlug: string, token: string): string {
  return `${getAppBaseUrl()}/t/${trainingSlug}?token=${token}`
}

/**
 * Validate a training access token.
 * Returns the token record with training and candidate info, or null if invalid.
 */
export async function validateAccessToken(token: string, trainingId: string) {
  const record = await prisma.trainingAccessToken.findUnique({
    where: { token },
    include: {
      training: true,
      candidate: { select: { id: true, candidateName: true, candidateEmail: true } },
    },
  })

  if (!record) return null
  if (record.trainingId !== trainingId) return null
  if (record.status !== 'active' && record.status !== 'used') return null
  if (record.expiresAt && record.expiresAt < new Date()) return null

  return record
}

/**
 * Read-only lookup for an existing enrollment. Used by the training landing
 * page so that just opening the invitation link does NOT create an
 * enrollment or fire `training_started`. Returns null if the candidate has
 * not pressed the Start button yet.
 */
export async function findExistingEnrollment(opts: {
  trainingId: string
  accessTokenId: string
}) {
  return prisma.trainingEnrollment.findUnique({
    where: {
      trainingId_accessTokenId: {
        trainingId: opts.trainingId,
        accessTokenId: opts.accessTokenId,
      },
    },
  })
}

/**
 * Get or create an enrollment when a candidate accesses training with a valid token.
 */
export async function getOrCreateEnrollment(opts: {
  trainingId: string
  accessTokenId: string
  sessionId: string | null
  userName: string | null
  userEmail: string | null
}) {
  const existing = await prisma.trainingEnrollment.findUnique({
    where: {
      trainingId_accessTokenId: {
        trainingId: opts.trainingId,
        accessTokenId: opts.accessTokenId,
      },
    },
  })

  if (existing) return existing

  const enrollment = await prisma.trainingEnrollment.create({
    data: {
      trainingId: opts.trainingId,
      accessTokenId: opts.accessTokenId,
      sessionId: opts.sessionId,
      userName: opts.userName,
      userEmail: opts.userEmail,
      status: 'in_progress',
      progress: { completedSections: [], quizScores: [] },
    },
  })

  // Mark token as used
  await prisma.trainingAccessToken.update({
    where: { id: opts.accessTokenId },
    data: { status: 'used', usedAt: new Date() },
  })

  // Fire training_started so workspace funnel triggers can auto-place the
  // candidate. Imported lazily to keep this lib usable from contexts that
  // don't pull the automation module. Keyed off the enrollment id so
  // re-creating tokens against the same enrollment doesn't re-fire.
  if (opts.sessionId) {
    const session = await prisma.session.findUnique({
      where: { id: opts.sessionId },
      select: { workspaceId: true },
    })
    if (session) {
      const { fireTrainingStartedAutomations } = await import('./automation')
      const { emitAutomationEvent, eventKeys } = await import('./automation-emit')
      await emitAutomationEvent({
        workspaceId: session.workspaceId,
        sessionId: opts.sessionId,
        triggerType: 'training_started',
        eventKey: eventKeys.trainingStarted(enrollment.id),
        source: 'internal',
        payload: { trainingEnrollmentId: enrollment.id, trainingId: opts.trainingId },
        dispatch: () => fireTrainingStartedAutomations(opts.sessionId!, opts.trainingId),
      }).catch(() => {})
    }
  }

  return enrollment
}

/**
 * Update enrollment progress (section completion, quiz scores).
 */
export async function updateEnrollmentProgress(
  enrollmentId: string,
  progress: { completedSections: string[]; quizScores: { sectionId: string; score: number }[] }
) {
  return prisma.trainingEnrollment.update({
    where: { id: enrollmentId },
    data: { progress },
  })
}

/**
 * Mark training as completed for an enrollment.
 */
export async function completeEnrollment(enrollmentId: string) {
  return prisma.trainingEnrollment.update({
    where: { id: enrollmentId },
    data: {
      status: 'completed',
      completedAt: new Date(),
    },
  })
}
