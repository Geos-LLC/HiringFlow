/**
 * Telegram channel publisher via Sigcore Platform API.
 *
 * Sigcore wraps TelePorter (the actual Telegram Bot API integration) and
 * exposes a tenant-scoped `/api/integrations/telegram/*` surface that we
 * authenticate against with the same `SIGCORE_API_KEY` we already use for
 * SMS. Full contract lives at
 *   ../../Sigcore/docs/TELEGRAM_PUBLISHER.md
 *
 * Architecture: HF (this code) → Sigcore /integrations/telegram/* → Sigcore
 * telegram-service µsvc → TelePorter Publisher API. Provisioned per-workspace
 * bots, idempotency keyed by `(workspaceId, externalRef)` where externalRef
 * is our `TelegramPlacement.id`.
 *
 * Webhook callbacks (telegram.placement.sent / .failed) land at
 *   src/app/api/webhooks/sigcore/telegram-placement/route.ts
 * and update the placement row by `externalRef`.
 */

export class TelegramConfigError extends Error {}
export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly providerError?: string,
  ) {
    super(message)
  }
}

interface SigcoreConfig {
  apiUrl: string
  apiKey: string
}

function readConfig(): SigcoreConfig {
  // .trim() — env vars piped through CLI tools sometimes acquire trailing
  // newlines, which Sigcore's strict validators reject with a 500.
  const apiUrl = process.env.SIGCORE_API_URL?.trim()
  const apiKey = process.env.SIGCORE_API_KEY?.trim()
  if (!apiUrl) throw new TelegramConfigError('SIGCORE_API_URL is not configured')
  if (!apiKey) throw new TelegramConfigError('SIGCORE_API_KEY is not configured')
  return { apiUrl: apiUrl.replace(/\/+$/, ''), apiKey }
}

async function sigcoreFetch<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const { apiUrl, apiKey } = readConfig()
  let res: Response
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new TelegramApiError(`Sigcore unreachable: ${(err as Error).message}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new TelegramApiError(
      `Sigcore ${method} ${path} returned ${res.status}: ${text.slice(0, 200) || res.statusText}`,
      res.status,
      text,
    )
  }
  return (await res.json()) as T
}

// ---------- subscribe / status ----------

export type TelegramSubscriberStatus =
  | 'not_initialized'
  | 'provisioning'
  | 'ready'
  | 'retired'

export interface TelegramSubscriberView {
  botUsername?: string
  status: TelegramSubscriberStatus
  inviteHint?: string
}

/**
 * Allocate (or return existing) per-workspace bot. Idempotent — a second
 * call returns the same subscriber. `displayName` is shown on the bot's
 * BotFather profile and is optional.
 */
export async function subscribeWorkspace(input?: { displayName?: string }): Promise<TelegramSubscriberView> {
  return sigcoreFetch<TelegramSubscriberView>(
    'POST',
    '/api/integrations/telegram/subscribe',
    input?.displayName ? { displayName: input.displayName } : {},
  )
}

/**
 * Cheap read of current subscriber state. Returns `status: 'not_initialized'`
 * when no subscriber exists for the tenant.
 */
export async function getSubscriptionStatus(): Promise<TelegramSubscriberView> {
  return sigcoreFetch<TelegramSubscriberView>('GET', '/api/integrations/telegram/status')
}

// ---------- chat verify ----------

export interface TelegramVerifyVerdict {
  // 'ready' | 'pending' | 'blocked' | etc. — TelePorter shape, opaque to HF.
  status: string
  // Per docs, ready verdicts always include warnings (e.g.
  // PAY_TO_POST_NOT_DETECTABLE) because the Bot API can't observe channel
  // pay-to-post restrictions.
  warnings?: string[]
  blockers?: string[]
  probeSucceeded?: boolean
  probeError?: string
  // Forward-compat: TelePorter may add fields. We persist the raw verdict
  // as JSON on TelegramChannel.verifyVerdict so the UI can render them.
  [key: string]: unknown
}

/**
 * Verify recruiter-supplied channel reference (e.g. `@cleaners_jax`).
 * `probe: true` bypasses the 1h Sigcore verify cache and sends a zero-width
 * test message that's deleted within 2s — rate-limit expensive on TelePorter,
 * so use sparingly.
 */
export async function verifyChat(input: {
  chatRef: string
  probe?: boolean
}): Promise<TelegramVerifyVerdict> {
  return sigcoreFetch<TelegramVerifyVerdict>(
    'POST',
    '/api/integrations/telegram/verify-chat',
    { chatRef: input.chatRef, probe: input.probe === true },
  )
}

// ---------- publish / cancel / get ----------

export interface PublishInput {
  chatRef: string
  text: string
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'
  imageUrl?: string
  /** ISO-8601 UTC. Omitted → send immediately. */
  scheduledAt?: string
  /**
   * Caller-controlled idempotency token. HF passes the TelegramPlacement.id.
   * Replaying the same value returns the original Sigcore placementId
   * without re-dispatching to TelePorter.
   */
  externalRef: string
}

export interface PublishResult {
  placementId: string
  status: 'queued' | 'scheduled'
  scheduledAt?: string
}

export async function publishToChannel(input: PublishInput): Promise<PublishResult> {
  if (!input.text || input.text.trim().length === 0) {
    throw new TelegramApiError('Telegram publish body is empty')
  }
  if (!input.externalRef) {
    throw new TelegramApiError('externalRef is required (idempotency token)')
  }
  return sigcoreFetch<PublishResult>(
    'POST',
    '/api/integrations/telegram/publish',
    input,
  )
}

/**
 * Cancel a queued/scheduled placement. Sigcore returns 409 once the message
 * has already been sent or failed — surfaced as TelegramApiError(status=409)
 * for the caller to distinguish from infrastructure errors.
 */
export async function cancelPlacement(sigcorePlacementId: string): Promise<void> {
  await sigcoreFetch<unknown>(
    'POST',
    `/api/integrations/telegram/placements/${encodeURIComponent(sigcorePlacementId)}/cancel`,
  )
}

export interface PlacementView {
  placementId: string
  status: 'queued' | 'scheduled' | 'sent' | 'failed' | 'cancelled'
  chatRef: string
  externalRef: string
  scheduledAt?: string
  providerMessageId?: string
  errorCode?: string
  errorMessage?: string
  sentAt?: string
  failedAt?: string
}

export async function getPlacement(sigcorePlacementId: string): Promise<PlacementView> {
  return sigcoreFetch<PlacementView>(
    'GET',
    `/api/integrations/telegram/placements/${encodeURIComponent(sigcorePlacementId)}`,
  )
}
