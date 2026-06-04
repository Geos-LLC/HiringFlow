/**
 * Bounce retry: when a candidate-facing email gets a per-recipient/policy
 * block from the receiving mail server (Apple iCloud's HM08 being the
 * representative case), automatically resend the same content from the
 * platform default sender (`noreply@hirefunnel.app`) instead of the
 * workspace's custom sender domain.
 *
 * The block is on the *sending domain*, not the recipient mailbox — so a
 * fresh send from a different envelope-from typically lands. Reply-To
 * stays pointed at the workspace sender so any candidate reply still
 * reaches the recruiter.
 *
 * The retry is guarded:
 *   - Triggered only when `deliveryErrorMessage` matches a per-recipient
 *     policy pattern we know is sender-related (see PATTERNS).
 *   - Channel must be email.
 *   - bounceRetriedAt must be null (one retry per execution, never loops).
 *   - The execution must have renderedSubject/renderedHtml captured
 *     (without them we can't resend the same content). Pre-2026-06 rows
 *     don't have these and are skipped.
 *   - The original `from` must NOT already be the platform default —
 *     retrying through the same sender would just re-bounce.
 */

import { prisma } from './prisma'
import { sendEmail, PLATFORM_FROM_EMAIL, PLATFORM_FROM_NAME } from './email'

// Patterns where the receiving server's block is bound to the sending
// domain/IP rather than the recipient mailbox. Each pattern is a
// case-insensitive substring match on deliveryErrorMessage.
//
// HM08          — Apple iCloud's "local policy" reject; per-recipient
//                 reputation against the sender domain or shared IP.
// 550 5.7.1     — generic "permission denied / policy reject" — most
//                 receivers use this for sender-side reputation blocks.
// 554 5.7.1     — same family, different severity. Includes Apple HM08
//                 envelopes.
// "local policy" — Apple's English text for HM08, sometimes surfaced
//                 without the bracketed code in older bounces.
const PATTERNS = [/HM08/i, /550\s*5\.7\.1/i, /554\s*5\.7\.1/i, /local policy/i] as const

export function isSenderPolicyBounce(deliveryErrorMessage: string | null | undefined): boolean {
  if (!deliveryErrorMessage) return false
  return PATTERNS.some(p => p.test(deliveryErrorMessage))
}

export type BounceRetryResult =
  | { retried: true; messageId: string | null }
  | { retried: false; reason: string }

export async function maybeBounceRetry(executionId: string): Promise<BounceRetryResult> {
  const exec = await prisma.automationExecution.findUnique({
    where: { id: executionId },
    select: {
      id: true,
      channel: true,
      sessionId: true,
      deliveryStatus: true,
      deliveryErrorMessage: true,
      bounceRetriedAt: true,
      renderedSubject: true,
      renderedHtml: true,
      renderedText: true,
      automationRule: {
        select: {
          workspaceId: true,
          workspace: { select: { senderEmail: true, senderName: true } },
        },
      },
      step: { select: { emailDestination: true } },
    },
  })
  if (!exec) return { retried: false, reason: 'execution_not_found' }
  if (exec.channel !== 'email') return { retried: false, reason: 'not_email_channel' }
  if (exec.bounceRetriedAt) return { retried: false, reason: 'already_retried' }
  if (exec.deliveryStatus !== 'blocked' && exec.deliveryStatus !== 'bounce') {
    return { retried: false, reason: 'not_bounced' }
  }
  if (!isSenderPolicyBounce(exec.deliveryErrorMessage)) {
    return { retried: false, reason: 'reason_not_sender_policy' }
  }
  if (!exec.renderedSubject || !exec.renderedHtml) {
    // Pre-2026-06 rows didn't capture rendered content — can't safely resend.
    return { retried: false, reason: 'no_rendered_content' }
  }

  // We only retry candidate-facing sends. Company / specific destinations
  // are recruiter-facing and don't benefit from sender swap (the company
  // address is usually a non-iCloud mailbox the workspace owner controls).
  if (exec.step && exec.step.emailDestination !== 'applicant') {
    return { retried: false, reason: 'not_applicant_destination' }
  }

  // Need the recipient address (from the session).
  const session = exec.sessionId
    ? await prisma.session.findUnique({
        where: { id: exec.sessionId },
        select: { id: true, candidateEmail: true, candidateName: true, workspaceId: true },
      })
    : null
  if (!session?.candidateEmail) {
    return { retried: false, reason: 'no_recipient' }
  }

  const workspaceSender = exec.automationRule?.workspace?.senderEmail
  // If the original sender was already the platform default, the retry
  // would just go out the same way. Skip — there's nothing to change.
  if (workspaceSender && workspaceSender.toLowerCase() === PLATFORM_FROM_EMAIL.toLowerCase()) {
    return { retried: false, reason: 'sender_already_platform' }
  }

  // Mark retried BEFORE sending, so a crash mid-send doesn't fire a
  // second attempt on next webhook redelivery.
  await prisma.automationExecution.update({
    where: { id: exec.id },
    data: { bounceRetriedAt: new Date() },
  })

  const replyTo = workspaceSender
    ? { email: workspaceSender, name: exec.automationRule?.workspace?.senderName || undefined }
    : null

  const result = await sendEmail({
    to: session.candidateEmail,
    subject: exec.renderedSubject,
    html: exec.renderedHtml,
    text: exec.renderedText ?? undefined,
    // Force platform sender for the retry. Pass null `from` so sendEmail
    // falls back to PLATFORM_FROM_EMAIL / PLATFORM_FROM_NAME.
    from: { email: PLATFORM_FROM_EMAIL, name: PLATFORM_FROM_NAME },
    replyTo,
    executionId: exec.id,
    workspaceId: session.workspaceId,
    candidateId: session.id,
    unsubscribeSessionId: session.id,
  })

  // Reset delivery telemetry on the row so the next webhook event for
  // this retry can write through the priority ladder (otherwise the
  // existing 'blocked' state would block a later 'delivered' update).
  await prisma.automationExecution.update({
    where: { id: exec.id },
    data: {
      status: result.success ? 'sent' : 'failed',
      providerMessageId: result.messageId ?? null,
      sentAt: result.success ? new Date() : null,
      deliveryStatus: null,
      deliveryStatusAt: null,
      deliveryErrorMessage: result.success ? null : (result.error ?? null),
      sendgridMessageId: null,
      sendgridEventId: null,
      // Keep deliveryRaw as a single-shot audit of the bounce-retry
      // attempt; subsequent webhook events will overwrite it normally.
      deliveryRaw: { bounceRetry: { attemptedAt: new Date().toISOString(), success: result.success, error: result.error ?? null } } as any,
    },
  })

  return { retried: true, messageId: result.messageId ?? null }
}
