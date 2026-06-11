import { prisma } from '../prisma'
import { sendEmail } from '../email'
import { logger } from '../logger'

const ALERT_TO = 'hello@hirefunnel.app'
const THROTTLE_KEY = 'recall_credit_alert_last_sent'
const THROTTLE_MS = 24 * 60 * 60 * 1000

export interface RecallCreditAlertContext {
  workspaceId: string
  workspaceName?: string | null
  meetingUri?: string | null
  interviewMeetingId?: string | null
  recallDetail?: string
}

export async function notifyRecallOutOfCredits(ctx: RecallCreditAlertContext): Promise<void> {
  try {
    const last = await prisma.platformSetting.findUnique({ where: { key: THROTTLE_KEY } })
    if (last) {
      const lastSent = Date.parse(last.value)
      if (Number.isFinite(lastSent) && Date.now() - lastSent < THROTTLE_MS) return
    }

    const subject = '[HireFunnel] Recall.ai credits exhausted — interview recordings disabled'
    const html = `
      <p>Recall.ai returned <strong>HTTP 402 insufficient_credit_balance</strong> when scheduling a bot for an interview. Every booking from this point forward will skip the bot and fall back to Google Meet native recording, which silently stops when the host is alone.</p>
      <p><strong>Top up at:</strong> <a href="https://dashboard.recall.ai">dashboard.recall.ai</a></p>
      <p>First failure detected on:</p>
      <ul>
        <li>Workspace: ${ctx.workspaceName || ctx.workspaceId}</li>
        ${ctx.meetingUri ? `<li>Meet: <a href="${ctx.meetingUri}">${ctx.meetingUri}</a></li>` : ''}
        ${ctx.interviewMeetingId ? `<li>InterviewMeeting id: <code>${ctx.interviewMeetingId}</code></li>` : ''}
        ${ctx.recallDetail ? `<li>Recall response: <code>${ctx.recallDetail}</code></li>` : ''}
      </ul>
      <p>This alert is throttled to once every 24h; subsequent failures will be silent in email but still logged.</p>
    `
    const result = await sendEmail({ to: ALERT_TO, subject, html })
    if (!result.success) {
      logger.warn('recall credit alert email failed', { error: result.error })
      return
    }

    await prisma.platformSetting.upsert({
      where: { key: THROTTLE_KEY },
      create: { key: THROTTLE_KEY, value: new Date().toISOString(), category: 'integrations' },
      update: { value: new Date().toISOString() },
    })
  } catch (err) {
    logger.warn('recall credit alert failed', { error: (err as Error).message })
  }
}
